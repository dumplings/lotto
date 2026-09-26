import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import type { Lotto } from "../target/types/lotto";

declare const process: {
  env: Record<string, string | undefined>;
  getBuiltinModule(name: "fs"): {
    readFileSync(path: string, encoding: "utf8"): string;
  };
  getBuiltinModule(name: "crypto"): {
    createHash(algorithm: string): {
      update(data: string | Buffer): {
        digest(): Buffer;
        digest(encoding: "hex"): string;
      };
    };
  };
};

type RawIdlField = { name: string; type: unknown };
type RawIdlType = {
  name: string;
  type: { kind: string; fields?: RawIdlField[] };
};
type RawIdl = {
  address: string;
  instructions: Array<{
    name: string;
    discriminator: number[];
    accounts: Array<{
      name: string;
      address?: string;
      relations?: string[];
      pda?: {
        seeds?: Array<{
          kind: string;
          path?: string;
          account?: string;
          value?: number[];
        }>;
      };
      signer?: boolean;
      writable?: boolean;
    }>;
    args: Array<{ name: string; type: unknown }>;
  }>;
  accounts?: Array<{ name: string }>;
  events?: Array<{ name: string; discriminator: number[] }>;
  types?: RawIdlType[];
  constants?: Array<{ name: string; type: unknown; value: string }>;
  errors?: Array<{ code: number; name: string; msg: string }>;
};
type MethodCall = {
  simulate(options?: anchor.web3.ConfirmOptions): Promise<unknown>;
  rpc(options?: anchor.web3.ConfirmOptions): Promise<string>;
};
type RpcConnection = {
  _rpcRequest(
    method: string,
    params: unknown[]
  ): Promise<{ error?: unknown; result?: unknown }>;
};
type Phase6TransactionBuilder = {
  accountsStrict(
    accounts: Record<string, anchor.web3.PublicKey>
  ): Phase6TransactionBuilder;
  postInstructions(
    instructions: anchor.web3.TransactionInstruction[]
  ): Phase6TransactionBuilder;
  transaction(): Promise<anchor.web3.Transaction>;
};

const { readFileSync } = process.getBuiltinModule("fs");
const { createHash } = process.getBuiltinModule("crypto");
const rawIdl = JSON.parse(
  readFileSync("target/idl/lotto.json", "utf8")
) as RawIdl;

const ticketRandomnessDomain = Buffer.from("solana_lotto:ticket:v1");

function countLeadingZeroBits(hash: Buffer): number {
  let total = 0;
  for (const byte of hash) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    total += Math.clz32(byte) - 24;
    break;
  }
  return total;
}

function deriveTicketHash(
  randomness: Buffer,
  ticket: anchor.web3.PublicKey
): Buffer {
  expect(randomness.length).to.equal(32);
  return createHash("sha256")
    .update(
      Buffer.concat([ticketRandomnessDomain, randomness, ticket.toBuffer()])
    )
    .digest();
}

function mapScoreToTier(
  score: number,
  thresholds: readonly [number, number, number]
): "tier0" | "tier1" | "tier2" | null {
  if (score >= thresholds[2]) return "tier2";
  if (score >= thresholds[1]) return "tier1";
  if (score >= thresholds[0]) return "tier0";
  return null;
}

describe("lotto Phase 0-6", function () {
  this.timeout(60_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.lotto as Program<Lotto>;
  const systemProgram = anchor.web3.SystemProgram.programId;
  const slotHashes = anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY;
  const vrfProgram = new anchor.web3.PublicKey(
    "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
  );
  const vrfQueue = new anchor.web3.PublicKey(
    "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb"
  );
  const upgradeableLoader = new anchor.web3.PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );
  const [config, configBump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("lotto_config")],
    program.programId
  );
  const [rolloverVault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("rollover_vault_seed")],
    program.programId
  );
  const [programData] = anchor.web3.PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    upgradeableLoader
  );
  const substitutedProgramData = anchor.web3.Keypair.generate().publicKey;
  const unauthorizedInitializer = anchor.web3.Keypair.generate();
  const unauthorizedUpdater = anchor.web3.Keypair.generate();
  const [requestProgramIdentity] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity")],
    program.programId
  );
  const [scopedVrfIdentity] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), program.programId.toBuffer()],
    vrfProgram
  );

  const validInitializeArgs = {
    ticketPrice: new anchor.BN(1_000_000),
    tierThresholds: [1, 128, 256] as [number, number, number],
    tierPoolBps: [0, 2_500, 7_500] as [number, number, number],
  };

  function initializeCall(
    args: typeof validInitializeArgs,
    authority = provider.wallet.publicKey,
    suppliedProgramData = programData,
    signers: anchor.web3.Signer[] = [],
    suppliedProgram = program.programId
  ): MethodCall {
    return program.methods
      .initializeConfig(args)
      .accountsStrict({
        authority,
        config,
        rolloverVault,
        program: suppliedProgram,
        programData: suppliedProgramData,
        systemProgram,
      })
      .signers(signers);
  }

  function updateCall(
    args: typeof validInitializeArgs,
    authority = provider.wallet.publicKey,
    signers: anchor.web3.Signer[] = []
  ): MethodCall {
    return program.methods
      .updateConfig(args)
      .accountsStrict({ authority, config })
      .signers(signers);
  }

  async function expectAnchorError(
    operation: Promise<unknown>,
    expectedCode: string
  ): Promise<void> {
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }

    const simulationLogs = (
      caught as { simulationResponse?: { logs?: string[] } } | undefined
    )?.simulationResponse?.logs;
    const parsed =
      caught instanceof anchor.AnchorError
        ? caught
        : simulationLogs
        ? anchor.AnchorError.parse(simulationLogs)
        : null;
    if (parsed === null) {
      throw new Error(
        `expected Anchor error ${expectedCode}, got ${String(caught)}; keys=${
          caught && typeof caught === "object"
            ? Object.keys(caught).join(",")
            : "none"
        }; simulation=${JSON.stringify(
          (caught as { simulationResponse?: unknown } | undefined)
            ?.simulationResponse
        )}`
      );
    }
    const actualCode = parsed!.error.errorCode.code;
    if (actualCode !== expectedCode) {
      throw new Error(
        `expected Anchor error ${expectedCode}, got ${actualCode}\n${
          simulationLogs?.join("\n") ?? parsed!.toString()
        }`
      );
    }
  }

  async function expectSimulatedAndSubmittedError(
    simulationCall: () => MethodCall,
    expectedCode: string,
    submittedCall = simulationCall
  ): Promise<void> {
    await expectAnchorError(simulationCall().simulate(), expectedCode);
    await expectAnchorError(
      submittedCall().rpc({ commitment: "confirmed" }),
      expectedCode
    );
  }

  async function expectFailure(operation: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
  }

  async function expectSingletonsAbsent(): Promise<void> {
    const [configInfo, rolloverInfo] = await Promise.all([
      provider.connection.getAccountInfo(config, "confirmed"),
      provider.connection.getAccountInfo(rolloverVault, "confirmed"),
    ]);
    expect(configInfo).to.equal(null);
    expect(rolloverInfo).to.equal(null);
  }

  async function configBytes(): Promise<Buffer> {
    const account = await provider.connection.getAccountInfo(
      config,
      "confirmed"
    );
    expect(account).not.to.equal(null);
    return Buffer.from(account!.data);
  }

  before(async () => {
    await expectSingletonsAbsent();

    // A structurally valid ProgramData account whose address is deliberately
    // unrelated to the lotto executable. This isolates the raw relationship
    // constraint from owner/deserialization failures.
    const data = Buffer.alloc(45);
    data.writeUInt32LE(3, 0);
    data[12] = 1;
    provider.wallet.publicKey.toBuffer().copy(data, 13);
    const rpc = provider.connection as unknown as RpcConnection;
    const response = await rpc._rpcRequest("surfnet_setAccount", [
      substitutedProgramData.toBase58(),
      {
        data: data.toString("hex"),
        executable: false,
        lamports: 1_000_000,
        owner: upgradeableLoader.toBase58(),
      },
    ]);
    expect(response.error, JSON.stringify(response.error)).to.equal(undefined);

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: unauthorizedInitializer.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      ),
      [],
      { commitment: "confirmed" }
    );
  });

  describe("generated ABI", () => {
    it("pins the reconstruction Program ID and only the Phase 1-6 instructions", () => {
      expect(program.programId.toBase58()).to.equal(
        "6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm"
      );
      expect(rawIdl.address).to.equal(program.programId.toBase58());
      expect(rawIdl.instructions.map(({ name }) => name)).to.deep.equal([
        "buy_ticket_v2",
        "claim_prize",
        "cleanup_expired_ticket",
        "create_round",
        "finalize_registration",
        "finalize_round",
        "initialize_config",
        "receive_randomness",
        "register_winner",
        "request_randomness",
        "settle_randomness",
        "update_config",
      ]);
      expect(program.idl.instructions.map(({ name }) => name)).to.deep.equal([
        "buyTicketV2",
        "claimPrize",
        "cleanupExpiredTicket",
        "createRound",
        "finalizeRegistration",
        "finalizeRound",
        "initializeConfig",
        "receiveRandomness",
        "registerWinner",
        "requestRandomness",
        "settleRandomness",
        "updateConfig",
      ]);
    });

    it("pins Phase 1 account wiring and the standard authority relation", () => {
      const instruction = (name: string) =>
        rawIdl.instructions.find((item) => item.name === name)!;
      const initialize = instruction("initialize_config");
      const update = instruction("update_config");

      expect(initialize.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "rollover_vault",
        "program",
        "program_data",
        "system_program",
      ]);
      expect(initialize.accounts[1].pda).not.to.equal(undefined);
      expect(initialize.accounts[2].pda).not.to.equal(undefined);
      expect(initialize.accounts[3].address).to.equal(rawIdl.address);
      expect(initialize.accounts[5].address).to.equal(systemProgram.toBase58());
      expect(update.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
      ]);
      expect(update.accounts[0].relations).to.deep.equal(["config"]);
    });

    it("pins the Phase 2 instruction accounts and arguments", () => {
      const instruction = (name: string) =>
        rawIdl.instructions.find((item) => item.name === name)!;
      const create = instruction("create_round");
      const buy = instruction("buy_ticket_v2");
      expect(create.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "round",
        "prize_vault",
        "rollover_vault",
        "system_program",
      ]);
      expect(create.accounts[0].relations).to.deep.equal(["config"]);
      expect(create.args).to.deep.equal([]);
      expect(buy.accounts.map(({ name }) => name)).to.deep.equal([
        "round",
        "ticket",
        "prize_vault",
        "instructions_sysvar",
        "system_program",
      ]);
      expect(buy.args).to.deep.equal([
        { name: "buyer", type: "pubkey" },
        { name: "quantity", type: "u32" },
      ]);
      expect(buy.accounts.map(({ name }) => name)).not.to.include("buyer");
      expect(buy.accounts[1].pda?.seeds?.[2]).to.deep.equal({
        kind: "arg",
        path: "buyer",
      });
      expect(buy.accounts[3].address).to.equal(
        anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY.toBase58()
      );
      expect(buy.accounts[4].address).to.equal(systemProgram.toBase58());
      expect(buy.accounts[4].signer).not.to.equal(true);
      expect(buy.accounts[4].writable).not.to.equal(true);
      expect(rawIdl.constants).to.deep.include({
        name: "TICKET_SPACE",
        type: "u64",
        value: String(program.account.ticket.size),
      });
    });

    it("pins the LottoConfig field order", () => {
      expect(rawIdl.accounts?.map(({ name }) => name)).to.deep.equal([
        "LottoConfig",
        "Round",
        "Ticket",
      ]);
      const configType = rawIdl.types?.find(
        ({ name }) => name === "LottoConfig"
      );
      expect(configType?.type.kind).to.equal("struct");
      expect(configType?.type.fields?.map(({ name }) => name)).to.deep.equal([
        "authority",
        "treasury",
        "next_round_id",
        "active_round_id",
        "ticket_price",
        "tier_thresholds",
        "tier_pool_bps",
        "bump",
      ]);
    });

    it("keeps the Phase 0-2 error ABI unchanged and pins the Phase 3 append", () => {
      expect(rawIdl.errors?.slice(0, 4)).to.deep.equal([
        {
          code: 6000,
          name: "InvalidTicketPrice",
          msg: "TicketPrice 必须大于 0",
        },
        {
          code: 6001,
          name: "InvalidTierThresholds",
          msg: "TierThresholds 必须严格递增，且每项位于 1..=256",
        },
        {
          code: 6002,
          name: "InvalidTierPoolBps",
          msg: "TierPoolBPS 总和不能超过 10,000",
        },
        {
          code: 6003,
          name: "UnauthorizedInitializer",
          msg: "当前 signer 不是 Program Upgrade Authority，不能初始化 Config",
        },
      ]);
      expect(rawIdl.errors?.slice(4, 9)).to.deep.equal([
        {
          code: 6004,
          name: "ActiveRoundExists",
          msg: "当前已有激活中的 Round",
        },
        {
          code: 6005,
          name: "ArithmeticError",
          msg: "算术运算失败",
        },
        {
          code: 6006,
          name: "InvalidTicketQuantity",
          msg: "Ticket quantity 必须大于 0",
        },
        {
          code: 6007,
          name: "RoundNotSelling",
          msg: "Round 当前不处于 Selling 状态",
        },
        { code: 6008, name: "SaleClosed", msg: "售票窗口已关闭" },
      ]);
      expect(rawIdl.errors?.slice(9, 14)).to.deep.equal([
        { code: 6009, name: "SaleStillOpen", msg: "售票窗口仍未结束" },
        {
          code: 6010,
          name: "RandomnessAlreadyReady",
          msg: "Randomness 已经就绪",
        },
        {
          code: 6011,
          name: "RoundNotRandomnessPending",
          msg: "Round 当前不处于 RandomnessPending 状态",
        },
        {
          code: 6012,
          name: "RandomnessNotReady",
          msg: "Randomness 尚未就绪",
        },
        {
          code: 6013,
          name: "RandomnessBindingMismatch",
          msg: "Randomness callback binding 与当前 Round 不匹配",
        },
      ]);
    });

    it("pins only the three reachable Phase 4 domain errors", () => {
      expect(rawIdl.errors?.slice(14, 17)).to.deep.equal([
        {
          code: 6014,
          name: "RoundNotRegistering",
          msg: "Round 当前不处于 Registering 状态",
        },
        {
          code: 6015,
          name: "RegistrationClosed",
          msg: "登记窗口已关闭",
        },
        {
          code: 6016,
          name: "TicketAlreadyRegistered",
          msg: "Ticket 已完成登记，不能重复登记",
        },
      ]);
      expect(rawIdl.errors?.map(({ name }) => name)).not.to.include(
        "InvalidTierNumber"
      );
      expect(rawIdl.errors?.map(({ name }) => name)).not.to.include(
        "InvalidPrizeTier"
      );
    });

    it("pins only the four reachable Phase 5 domain errors", () => {
      expect(rawIdl.errors?.slice(17, 21)).to.deep.equal([
        {
          code: 6017,
          name: "RegistrationStillOpen",
          msg: "登记窗口仍未结束",
        },
        {
          code: 6018,
          name: "RoundNotClaiming",
          msg: "Round 当前不处于 Claiming 状态",
        },
        {
          code: 6019,
          name: "ClaimClosed",
          msg: "兑奖窗口已关闭",
        },
        {
          code: 6020,
          name: "TicketNotWinner",
          msg: "Ticket 不是已登记的中奖 Ticket",
        },
      ]);
    });

    it("preserves Phase 6 errors and appends the V2 payment errors", () => {
      expect(rawIdl.errors?.slice(21, 23)).to.deep.equal([
        {
          code: 6021,
          name: "ClaimStillOpen",
          msg: "兑奖窗口仍未结束",
        },
        {
          code: 6022,
          name: "RoundCleanupStateInvalid",
          msg: "Round account 既不是有效的 live Round，也不是有效的 closed Round",
        },
      ]);
      expect(rawIdl.errors?.slice(23)).to.deep.equal([
        {
          code: 6023,
          name: "InvalidPaymentInstruction",
          msg: "上一条 instruction 不是有效的购票付款 instruction",
        },
        {
          code: 6024,
          name: "PaymentSourceMismatch",
          msg: "付款来源与 buyer 不匹配",
        },
        {
          code: 6025,
          name: "PaymentDestinationMismatch",
          msg: "付款目标与 Prize Vault 不匹配",
        },
        {
          code: 6026,
          name: "PaymentAmountMismatch",
          msg: "付款金额与当前应付金额不匹配",
        },
        {
          code: 6027,
          name: "InvalidTicketAccountState",
          msg: "Ticket account 当前状态无效",
        },
      ]);
    });

    it("pins Phase 3 discriminators, account order, and framework metadata", () => {
      const instruction = (name: string) =>
        rawIdl.instructions.find((item) => item.name === name)!;
      const expectedDiscriminator = (name: string) =>
        Array.from(
          createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)
        );
      const receive = instruction("receive_randomness");
      const request = instruction("request_randomness");
      const settle = instruction("settle_randomness");

      expect(receive.discriminator).to.deep.equal(
        expectedDiscriminator("receive_randomness")
      );
      expect(request.discriminator).to.deep.equal(
        expectedDiscriminator("request_randomness")
      );
      expect(settle.discriminator).to.deep.equal(
        expectedDiscriminator("settle_randomness")
      );

      expect(receive.accounts.map(({ name }) => name)).to.deep.equal([
        "vrf_program_identity",
        "round",
      ]);
      expect(receive.accounts[0].signer).to.equal(true);
      expect(receive.accounts[0].writable).not.to.equal(true);
      expect(receive.accounts[1].signer).not.to.equal(true);
      expect(receive.accounts[1].writable).to.equal(true);
      expect(receive.accounts[1].pda).not.to.equal(undefined);
      expect(receive.args).to.deep.equal([
        { name: "randomness", type: { array: ["u8", 32] } },
        { name: "binding", type: { array: ["u8", 32] } },
      ]);

      expect(request.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "round",
        "oracle_queue",
        "program_identity",
        "vrf_program",
        "slot_hashes",
        "system_program",
      ]);
      expect(request.accounts[0]).to.include({ writable: true, signer: true });
      expect(request.accounts[0].relations).to.deep.equal(["config"]);
      expect(request.accounts[1].pda).not.to.equal(undefined);
      expect(request.accounts[1].writable).not.to.equal(true);
      expect(request.accounts[2]).to.include({ writable: true });
      expect(request.accounts[2].pda).not.to.equal(undefined);
      expect(request.accounts[3]).to.include({
        address: vrfQueue.toBase58(),
        writable: true,
      });
      expect(request.accounts[4].pda).not.to.equal(undefined);
      expect(request.accounts[5].address).to.equal(vrfProgram.toBase58());
      expect(request.accounts[6].address).to.equal(slotHashes.toBase58());
      expect(request.accounts[7].address).to.equal(systemProgram.toBase58());
      expect(request.args).to.deep.equal([]);

      expect(settle.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "round",
      ]);
      expect(settle.accounts[0].signer).to.equal(true);
      expect(settle.accounts[0].relations).to.deep.equal(["config"]);
      expect(settle.accounts[1].pda).not.to.equal(undefined);
      expect(settle.accounts[2]).to.include({ writable: true });
      expect(settle.accounts[2].pda).not.to.equal(undefined);
      expect(settle.args).to.deep.equal([]);
    });

    it("pins the Phase 4 discriminator, account order, and framework metadata", () => {
      const register = rawIdl.instructions.find(
        ({ name }) => name === "register_winner"
      )!;
      const expectedDiscriminator = Array.from(
        createHash("sha256")
          .update("global:register_winner")
          .digest()
          .subarray(0, 8)
      );

      expect(register.discriminator).to.deep.equal(expectedDiscriminator);
      expect(register.accounts.map(({ name }) => name)).to.deep.equal([
        "user",
        "round",
        "ticket",
        "config",
        "treasury",
      ]);
      expect(register.accounts[0].signer).to.equal(true);
      expect(register.accounts[0].writable).not.to.equal(true);
      expect(register.accounts[0].relations).to.deep.equal(["ticket"]);
      expect(register.accounts[1]).to.include({ writable: true });
      expect(register.accounts[1].pda).not.to.equal(undefined);
      expect(register.accounts[2]).to.include({ writable: true });
      expect(register.accounts[2].pda).not.to.equal(undefined);
      expect(register.accounts[3].pda).not.to.equal(undefined);
      expect(register.accounts[3].writable).not.to.equal(true);
      expect(register.accounts[4].writable).to.equal(true);
      expect(register.args).to.deep.equal([]);
    });

    it("pins Phase 5 discriminators, privileges, relationships, and event shape", () => {
      const instruction = (name: string) =>
        rawIdl.instructions.find((item) => item.name === name)!;
      const expectedDiscriminator = (namespace: string, name: string) =>
        Array.from(
          createHash("sha256")
            .update(`${namespace}:${name}`)
            .digest()
            .subarray(0, 8)
        );
      const finalize = instruction("finalize_registration");
      const claim = instruction("claim_prize");

      expect(finalize.discriminator).to.deep.equal(
        expectedDiscriminator("global", "finalize_registration")
      );
      expect(finalize.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "round",
      ]);
      expect(finalize.accounts[0]).to.include({ signer: true });
      expect(finalize.accounts[0].writable).not.to.equal(true);
      expect(finalize.accounts[0].relations).to.deep.equal(["config"]);
      expect(finalize.accounts[1].writable).not.to.equal(true);
      expect(finalize.accounts[1].pda).not.to.equal(undefined);
      expect(finalize.accounts[2]).to.include({ writable: true });
      expect(finalize.accounts[2].pda).not.to.equal(undefined);
      expect(finalize.args).to.deep.equal([]);

      expect(claim.discriminator).to.deep.equal(
        expectedDiscriminator("global", "claim_prize")
      );
      expect(claim.accounts.map(({ name }) => name)).to.deep.equal([
        "user",
        "config",
        "round",
        "ticket",
        "prize_vault",
        "treasury",
        "system_program",
      ]);
      expect(claim.accounts[0]).to.include({ signer: true, writable: true });
      expect(claim.accounts[0].relations).to.deep.equal(["ticket"]);
      expect(claim.accounts[1].writable).not.to.equal(true);
      expect(claim.accounts[1].pda).not.to.equal(undefined);
      expect(claim.accounts[2].writable).not.to.equal(true);
      expect(claim.accounts[2].pda).not.to.equal(undefined);
      expect(claim.accounts[3]).to.include({ writable: true });
      expect(claim.accounts[3].pda).not.to.equal(undefined);
      expect(claim.accounts[4]).to.include({ writable: true });
      expect(claim.accounts[4].pda).not.to.equal(undefined);
      expect(claim.accounts[5].writable).to.equal(true);
      expect(claim.accounts[6].address).to.equal(systemProgram.toBase58());
      expect(claim.args).to.deep.equal([]);

      expect(
        rawIdl.events?.find(({ name }) => name === "PrizeClaimed")
      ).to.deep.equal({
        name: "PrizeClaimed",
        discriminator: expectedDiscriminator("event", "PrizeClaimed"),
      });
      const claimEvent = rawIdl.types?.find(
        ({ name }) => name === "PrizeClaimed"
      );
      expect(claimEvent?.type.kind).to.equal("struct");
      expect(claimEvent?.type.fields).to.deep.equal([
        { name: "round_id", type: "u64" },
        { name: "user", type: "pubkey" },
        { name: "tier", type: { defined: { name: "PrizeTier" } } },
        { name: "quantity", type: "u32" },
        { name: "amount", type: "u64" },
      ]);
    });

    it("pins finalize_round privileges and event ABI", () => {
      const expectedDiscriminator = (namespace: string, name: string) =>
        Array.from(
          createHash("sha256")
            .update(`${namespace}:${name}`)
            .digest()
            .subarray(0, 8)
        );
      const finalize = rawIdl.instructions.find(
        ({ name }) => name === "finalize_round"
      );

      expect(
        finalize,
        "finalize_round must be a #[program] entrypoint"
      ).not.to.equal(undefined);
      expect(finalize!.discriminator).to.deep.equal(
        expectedDiscriminator("global", "finalize_round")
      );
      expect(finalize!.accounts.map(({ name }) => name)).to.deep.equal([
        "authority",
        "config",
        "round",
        "prize_vault",
        "rollover_vault",
        "treasury",
        "system_program",
      ]);
      expect(finalize!.accounts[0]).to.include({ signer: true });
      expect(finalize!.accounts[0].writable).not.to.equal(true);
      expect(finalize!.accounts[0].relations).to.deep.equal(["config"]);
      for (const index of [1, 2, 3, 4, 5]) {
        expect(finalize!.accounts[index].writable).to.equal(true);
      }
      expect(finalize!.accounts[1].pda).not.to.equal(undefined);
      expect(finalize!.accounts[2].pda).not.to.equal(undefined);
      expect(finalize!.accounts[3].pda).not.to.equal(undefined);
      expect(finalize!.accounts[4].pda).not.to.equal(undefined);
      expect(finalize!.accounts[6].address).to.equal(systemProgram.toBase58());
      expect(finalize!.args).to.deep.equal([]);

      expect(
        rawIdl.events?.find(({ name }) => name === "RoundFinalized")
      ).to.deep.equal({
        name: "RoundFinalized",
        discriminator: expectedDiscriminator("event", "RoundFinalized"),
      });
      const event = rawIdl.types?.find(({ name }) => name === "RoundFinalized");
      expect(event?.type).to.deep.equal({
        kind: "struct",
        fields: [
          { name: "round_id", type: "u64" },
          { name: "rollover_out", type: "u64" },
        ],
      });
    });

    it("pins cleanup_expired_ticket privileges and canonical PDA relationships", () => {
      const expectedDiscriminator = (namespace: string, name: string) =>
        Array.from(
          createHash("sha256")
            .update(`${namespace}:${name}`)
            .digest()
            .subarray(0, 8)
        );
      const cleanup = rawIdl.instructions.find(
        ({ name }) => name === "cleanup_expired_ticket"
      );

      expect(cleanup).not.to.equal(undefined);
      expect(cleanup!.discriminator).to.deep.equal(
        expectedDiscriminator("global", "cleanup_expired_ticket")
      );
      expect(cleanup!.accounts.map(({ name }) => name)).to.deep.equal([
        "user",
        "ticket",
        "round",
      ]);
      expect(cleanup!.accounts[0]).to.include({
        signer: true,
        writable: true,
      });
      expect(cleanup!.accounts[0].relations).to.deep.equal(["ticket"]);
      expect(cleanup!.accounts[1].writable).to.equal(true);
      expect(cleanup!.accounts[2].writable).not.to.equal(true);
      expect(
        cleanup!.accounts[1].pda?.seeds?.map(({ path }) => path)
      ).to.deep.equal([undefined, "ticket.round_id", "user"]);
      expect(
        cleanup!.accounts[2].pda?.seeds?.map(({ path }) => path)
      ).to.deep.equal([undefined, "ticket.round_id"]);
      expect(cleanup!.args).to.deep.equal([]);
    });

    it("pins independent binding, identity PDA, and callback encoding vectors", async () => {
      const u64Le = (value: number) => {
        return new anchor.BN(value).toArrayLike(Buffer, "le", 8);
      };
      const roundPda = (roundId: number) =>
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("round"), u64Le(roundId)],
          program.programId
        )[0];
      const deriveBinding = (round: anchor.web3.PublicKey) =>
        createHash("sha256")
          .update(
            Buffer.concat([
              Buffer.from("solana_lotto:randomness:v1"),
              program.programId.toBuffer(),
              round.toBuffer(),
            ])
          )
          .digest("hex");
      const roundZero = roundPda(0);
      const roundOne = roundPda(1);

      expect(roundZero.toBase58()).to.equal(
        "j8fXgS1jUdhSiTNvRKzmBMp8NYj2mf8ifaDTPXYXW5Y"
      );
      expect(roundOne.toBase58()).to.equal(
        "14ifBYDhv6xyVNYCNxZd9Aq2rNsWJQbJiENEaaMa5vnA"
      );
      expect(deriveBinding(roundZero)).to.equal(
        "5ac6714e65e4f8ceff10452b82f91de564e5efaba38eefcf574ad54207dfb1a1"
      );
      expect(deriveBinding(roundOne)).to.equal(
        "775d60baa4095340cb6977a9cf6875243d1de65cc43021b6a9e6efa5c9696fa2"
      );
      expect(requestProgramIdentity.toBase58()).to.equal(
        "27GRSHafNFC1SiMpaFvptBEt1oZwk47cmRZycv17kkdz"
      );
      expect(scopedVrfIdentity.toBase58()).to.equal(
        "Fo9xSnyVhj76XejePxnNc33p4xCzAiLDiMo2FvkzANaL"
      );

      const randomness = Array.from({ length: 32 }, (_, index) => index);
      const binding = Array.from({ length: 32 }, (_, index) => 255 - index);
      const callback = await program.methods
        .receiveRandomness(randomness, binding)
        .accountsStrict({
          vrfProgramIdentity: scopedVrfIdentity,
          round: roundZero,
        })
        .instruction();
      expect(callback.keys).to.have.length(2);
      expect(callback.keys[0]).to.deep.include({
        isSigner: true,
        isWritable: false,
      });
      expect(callback.keys[0].pubkey.equals(scopedVrfIdentity)).to.equal(true);
      expect(callback.keys[1]).to.deep.include({
        isSigner: false,
        isWritable: true,
      });
      expect(callback.keys[1].pubkey.equals(roundZero)).to.equal(true);
      expect(callback.data).to.have.length(8 + 32 + 32);
      expect(Array.from(callback.data.subarray(0, 8))).to.deep.equal(
        rawIdl.instructions.find(({ name }) => name === "receive_randomness")!
          .discriminator
      );
      expect(callback.data.subarray(8, 40)).to.deep.equal(
        Buffer.from(randomness)
      );
      expect(callback.data.subarray(40)).to.deep.equal(Buffer.from(binding));
    });

    it("pins Phase 2 account layouts without reference-schema residue", () => {
      expect(rawIdl.accounts?.map(({ name }) => name)).to.deep.equal([
        "LottoConfig",
        "Round",
        "Ticket",
      ]);
      const type = (name: string) =>
        rawIdl.types?.find((candidate) => candidate.name === name)?.type;
      expect(type("Round")?.fields?.map(({ name }) => name)).to.deep.equal([
        "round_id",
        "status",
        "randomness_binding",
        "randomness_requested_at",
        "randomness_received_at",
        "randomness_ready",
        "randomness",
        "sale_duration_secs",
        "registration_duration_secs",
        "claim_duration_secs",
        "sale_deadline",
        "registration_deadline",
        "claim_deadline",
        "ticket_price",
        "tier_thresholds",
        "tier_pool_bps",
        "registered_units",
        "prize_per_unit",
        "sales_proceeds",
        "rollover_in",
        "bump",
      ]);
      expect(type("Ticket")?.fields?.map(({ name }) => name)).to.deep.equal([
        "user",
        "round_id",
        "quantity",
        "outcome",
        "bump",
      ]);
      expect(JSON.stringify(type("Round"))).not.to.include("claimed_units");
      expect(JSON.stringify(type("Ticket"))).not.to.include("prize_tier");
      expect(JSON.stringify(type("TicketOutcome"))).to.include("Winner");
      expect(JSON.stringify(type("TicketOutcome"))).not.to.include('"u8"');
    });
  });

  describe("Phase 4 independent winner derivation vectors", () => {
    it("counts leading zero bits across every requested byte boundary", () => {
      const vector = (prefix: number[], fill = 0xff) => {
        const bytes = Buffer.alloc(32, fill);
        Buffer.from(prefix).copy(bytes);
        return bytes;
      };
      const vectors: Array<[string, Buffer, number]> = [
        ["all one bits", Buffer.alloc(32, 0xff), 0],
        ["first bit is one", vector([0x80]), 0],
        ["one", vector([0x40]), 1],
        ["seven", vector([0x01]), 7],
        ["eight", vector([0x00, 0x80]), 8],
        ["fifteen", vector([0x00, 0x01]), 15],
        ["sixteen", vector([0x00, 0x00, 0x80]), 16],
        ["twenty-three", vector([0x00, 0x00, 0x01]), 23],
        ["twenty-four", vector([0x00, 0x00, 0x00, 0x80]), 24],
        [
          "two hundred fifty-five",
          vector([...new Array(31).fill(0), 0x01]),
          255,
        ],
        ["all zero bytes", Buffer.alloc(32), 256],
      ];

      for (const [label, bytes, expected] of vectors) {
        expect(countLeadingZeroBits(bytes), label).to.equal(expected);
      }
    });

    it("pins the reconstruction domain, fixed-width input order, and Ticket PDA", () => {
      const roundId = new anchor.BN(42);
      const user = systemProgram;
      const [ticket, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("ticket"),
          roundId.toArrayLike(Buffer, "le", 8),
          user.toBuffer(),
        ],
        program.programId
      );
      const randomness = Buffer.from(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "hex"
      );
      const digest = deriveTicketHash(randomness, ticket);

      expect(program.programId.toBase58()).to.equal(
        "6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm"
      );
      expect(ticket.toBase58()).to.equal(
        "D79bap8rRZhChnYoc6pYGgoU1bgL7BrzuBTyzyLCRoki"
      );
      expect(bump).to.equal(254);
      expect(digest.toString("hex")).to.equal(
        "c31b3c664edddd5261864e43498d20e8d2103e5884b4f082fbea2677d24c43dc"
      );
      expect(countLeadingZeroBits(digest)).to.equal(0);

      const withoutDomain = createHash("sha256")
        .update(Buffer.concat([randomness, ticket.toBuffer()]))
        .digest();
      const reversedInputs = createHash("sha256")
        .update(
          Buffer.concat([ticketRandomnessDomain, ticket.toBuffer(), randomness])
        )
        .digest();
      expect(withoutDomain).not.to.deep.equal(digest);
      expect(reversedInputs).not.to.deep.equal(digest);
    });

    it("pins independent SHA-256 vectors at the frozen score boundaries", () => {
      const roundId = new anchor.BN(42);
      const [ticket] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("ticket"),
          roundId.toArrayLike(Buffer, "le", 8),
          systemProgram.toBuffer(),
        ],
        program.programId
      );
      const vectors = [
        [
          7,
          "cb00000000000000000000000000000000000000000000000000000000000000",
          "01e2326677669c4cbaffde24b287e86e93dd080688add07dcaaac1b107cfb18d",
        ],
        [
          8,
          "fe00000000000000000000000000000000000000000000000000000000000000",
          "009baa309ad6691a835c7d146959c1db15c1c8d80fa2975fdb87966e0bf4db93",
        ],
        [
          15,
          "445b000000000000000000000000000000000000000000000000000000000000",
          "0001b96e2384bd2e34d6964c0a924c4a5e0c74d07985d3c7f88475c7327d0d6f",
        ],
        [
          16,
          "c1c8050000000000000000000000000000000000000000000000000000000000",
          "00008fe674b555b9afe1dee0c811b23f33a1432839e2a6b12dd7e04724479bf1",
        ],
        [
          23,
          "fbd19e0000000000000000000000000000000000000000000000000000000000",
          "000001cf1c0b0f48b7a137feb645b4a132dbdd60cbcc3cef8af58de8286e40d8",
        ],
        [
          24,
          "d224c80100000000000000000000000000000000000000000000000000000000",
          "0000009abcc6e0d1a4f746c707f0bb396102087545cfa3745ea8a374557285b7",
        ],
      ] as const;

      for (const [expectedScore, randomnessHex, digestHex] of vectors) {
        const digest = deriveTicketHash(
          Buffer.from(randomnessHex, "hex"),
          ticket
        );
        expect(digest.toString("hex")).to.equal(digestHex);
        expect(countLeadingZeroBits(digest)).to.equal(expectedScore);
      }
    });

    it("maps the frozen thresholds by highest qualifying priority", () => {
      const thresholds = [8, 16, 24] as const;
      const vectors: Array<[number, "tier0" | "tier1" | "tier2" | null]> = [
        [0, null],
        [7, null],
        [8, "tier0"],
        [15, "tier0"],
        [16, "tier1"],
        [23, "tier1"],
        [24, "tier2"],
        [256, "tier2"],
      ];
      for (const [score, expected] of vectors) {
        expect(mapScoreToTier(score, thresholds), `score ${score}`).to.equal(
          expected
        );
      }
      expect(mapScoreToTier(24, [8, 16, 24])).to.equal("tier2");
    });
  });

  it("rejects a substituted executable Program with an Anchor framework error", async () => {
    await expectSimulatedAndSubmittedError(
      () =>
        initializeCall(
          validInitializeArgs,
          provider.wallet.publicKey,
          programData,
          [],
          systemProgram
        ),
      "InvalidProgramId"
    );
    await expectSingletonsAbsent();
  });

  it("rejects a valid substituted ProgramData with Anchor ConstraintRaw", async () => {
    await expectSimulatedAndSubmittedError(
      () =>
        initializeCall(
          validInitializeArgs,
          provider.wallet.publicKey,
          substitutedProgramData
        ),
      "ConstraintRaw"
    );
    await expectSingletonsAbsent();
  });

  it("rejects a non-upgrade-authority signer with UnauthorizedInitializer", async () => {
    await expectSimulatedAndSubmittedError(
      () =>
        initializeCall(
          validInitializeArgs,
          unauthorizedInitializer.publicKey,
          programData
        ),
      "UnauthorizedInitializer",
      () =>
        initializeCall(
          validInitializeArgs,
          unauthorizedInitializer.publicKey,
          programData,
          [unauthorizedInitializer]
        )
    );
    await expectSingletonsAbsent();
  });

  for (const [label, args, expectedCode] of [
    [
      "zero ticket price",
      { ...validInitializeArgs, ticketPrice: new anchor.BN(0) },
      "InvalidTicketPrice",
    ],
    [
      "zero first threshold",
      {
        ...validInitializeArgs,
        tierThresholds: [0, 128, 256] as [number, number, number],
      },
      "InvalidTierThresholds",
    ],
    [
      "equal thresholds",
      {
        ...validInitializeArgs,
        tierThresholds: [8, 8, 256] as [number, number, number],
      },
      "InvalidTierThresholds",
    ],
    [
      "descending thresholds",
      {
        ...validInitializeArgs,
        tierThresholds: [8, 32, 16] as [number, number, number],
      },
      "InvalidTierThresholds",
    ],
    [
      "threshold above 256",
      {
        ...validInitializeArgs,
        tierThresholds: [8, 256, 257] as [number, number, number],
      },
      "InvalidTierThresholds",
    ],
    [
      "BPS total above 10,000",
      {
        ...validInitializeArgs,
        tierPoolBps: [0, 2_500, 7_501] as [number, number, number],
      },
      "InvalidTierPoolBps",
    ],
  ] as const) {
    it(`rejects ${label} without partial singleton state`, async () => {
      await expectSimulatedAndSubmittedError(
        () => initializeCall(args),
        expectedCode
      );
      await expectSingletonsAbsent();
    });
  }

  it("initializes the canonical Config and Rollover Vault at the boundaries", async () => {
    const authorityBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey,
      "confirmed"
    );
    await initializeCall(validInitializeArgs).simulate({
      commitment: "confirmed",
    });
    const signature = await initializeCall(validInitializeArgs).rpc({
      commitment: "confirmed",
    });

    const [decoded, configInfo, rolloverInfo, transaction] = await Promise.all([
      program.account.lottoConfig.fetch(config, "confirmed"),
      provider.connection.getAccountInfo(config, "confirmed"),
      provider.connection.getAccountInfo(rolloverVault, "confirmed"),
      provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    ]);
    const authorityBalanceAfter = await provider.connection.getBalance(
      provider.wallet.publicKey,
      "confirmed"
    );

    expect(decoded.authority.equals(provider.wallet.publicKey)).to.equal(true);
    expect(decoded.treasury.equals(provider.wallet.publicKey)).to.equal(true);
    expect(decoded.nextRoundId.toString()).to.equal("0");
    expect(decoded.activeRoundId).to.equal(null);
    expect(decoded.ticketPrice.toString()).to.equal("1000000");
    expect(decoded.tierThresholds).to.deep.equal([1, 128, 256]);
    expect(decoded.tierPoolBps).to.deep.equal([0, 2_500, 7_500]);
    expect(decoded.bump).to.equal(configBump);

    expect(configInfo).not.to.equal(null);
    expect(configInfo!.owner.equals(program.programId)).to.equal(true);
    expect(configInfo!.data.length).to.equal(110);
    expect(rolloverInfo).not.to.equal(null);
    expect(rolloverInfo!.owner.equals(systemProgram)).to.equal(true);
    expect(rolloverInfo!.data.length).to.equal(0);
    expect(rolloverInfo!.lamports).to.equal(
      await provider.connection.getMinimumBalanceForRentExemption(0)
    );
    expect(transaction?.meta).not.to.equal(null);
    expect(authorityBalanceBefore - authorityBalanceAfter).to.equal(
      configInfo!.lamports + rolloverInfo!.lamports + transaction!.meta!.fee
    );
  });

  it("rejects duplicate initialization without changing either singleton", async () => {
    const [configBefore, rolloverBefore] = await Promise.all([
      provider.connection.getAccountInfo(config, "confirmed"),
      provider.connection.getAccountInfo(rolloverVault, "confirmed"),
    ]);
    const duplicateArgs = {
      ticketPrice: new anchor.BN(9_000_000),
      tierThresholds: [8, 16, 24] as [number, number, number],
      tierPoolBps: [2_000, 3_000, 5_000] as [number, number, number],
    };
    await expectFailure(initializeCall(duplicateArgs).simulate());
    await expectFailure(
      initializeCall(duplicateArgs).rpc({ commitment: "confirmed" })
    );
    const [configAfter, rolloverAfter] = await Promise.all([
      provider.connection.getAccountInfo(config, "confirmed"),
      provider.connection.getAccountInfo(rolloverVault, "confirmed"),
    ]);
    expect(configAfter).to.deep.equal(configBefore);
    expect(rolloverAfter).to.deep.equal(rolloverBefore);
  });

  it("rejects a wrong Config authority with ConstraintHasOne", async () => {
    const before = await configBytes();
    await expectSimulatedAndSubmittedError(
      () =>
        updateCall(
          {
            ticketPrice: new anchor.BN(2_000_000),
            tierThresholds: [8, 16, 24],
            tierPoolBps: [2_000, 3_000, 5_000],
          },
          unauthorizedUpdater.publicKey
        ),
      "ConstraintHasOne",
      () =>
        updateCall(
          {
            ticketPrice: new anchor.BN(2_000_000),
            tierThresholds: [8, 16, 24],
            tierPoolBps: [2_000, 3_000, 5_000],
          },
          unauthorizedUpdater.publicKey,
          [unauthorizedUpdater]
        )
    );
    expect(await configBytes()).to.deep.equal(before);
  });

  for (const [label, args, expectedCode] of [
    [
      "zero ticket price update",
      { ...validInitializeArgs, ticketPrice: new anchor.BN(0) },
      "InvalidTicketPrice",
    ],
    [
      "invalid threshold update",
      {
        ...validInitializeArgs,
        tierThresholds: [1, 257, 258] as [number, number, number],
      },
      "InvalidTierThresholds",
    ],
    [
      "invalid BPS update",
      {
        ...validInitializeArgs,
        tierPoolBps: [10_000, 10_000, 10_000] as [number, number, number],
      },
      "InvalidTierPoolBps",
    ],
  ] as const) {
    it(`rolls back the complete serialized Config after ${label}`, async () => {
      const before = await configBytes();
      await expectSimulatedAndSubmittedError(
        () => updateCall(args),
        expectedCode
      );
      expect(await configBytes()).to.deep.equal(before);
    });
  }

  it("updates economics while preserving every protected field", async () => {
    const before = await program.account.lottoConfig.fetch(config, "confirmed");
    const args = {
      ticketPrice: new anchor.BN(2_000_000),
      tierThresholds: [12, 24, 32] as [number, number, number],
      tierPoolBps: [0, 3_500, 4_000] as [number, number, number],
    };
    await updateCall(args).simulate({ commitment: "confirmed" });
    await updateCall(args).rpc({ commitment: "confirmed" });
    const after = await program.account.lottoConfig.fetch(config, "confirmed");

    expect(after.ticketPrice.toString()).to.equal("2000000");
    expect(after.tierThresholds).to.deep.equal([12, 24, 32]);
    expect(after.tierPoolBps).to.deep.equal([0, 3_500, 4_000]);
    expect(after.authority.equals(before.authority)).to.equal(true);
    expect(after.treasury.equals(before.treasury)).to.equal(true);
    expect(after.nextRoundId.eq(before.nextRoundId)).to.equal(true);
    expect(after.activeRoundId).to.equal(before.activeRoundId);
    expect(after.bump).to.equal(before.bump);
  });

  const rolloverMode = process.env.CREATE_ROUND_ROLLOVER ?? "funded";
  if (rolloverMode !== "funded" && rolloverMode !== "zero") {
    throw new Error("CREATE_ROUND_ROLLOVER must be funded or zero");
  }
  const buyMode = process.env.PHASE2_BUY_MODE ?? "normal";
  if (buyMode !== "normal" && buyMode !== "payment-overflow") {
    throw new Error("PHASE2_BUY_MODE must be normal or payment-overflow");
  }

  describe(`Phase 2 (${rolloverMode} rollover, ${buyMode})`, function () {
    this.timeout(60_000);

    type Snapshot = {
      owner: string;
      lamports: number;
      data: string;
      executable: boolean;
    } | null;

    const businessRollover = rolloverMode === "funded" ? 1_234_567 : 0;
    const overflowPrice = new anchor.BN(1).shln(63);
    const phase2Price =
      buyMode === "payment-overflow" ? overflowPrice : new anchor.BN(1);
    const ticketSpaceConstant = rawIdl.constants?.find(
      ({ name }) => name === "TICKET_SPACE"
    );
    if (ticketSpaceConstant === undefined) {
      throw new Error("generated IDL is missing TICKET_SPACE");
    }
    const ticketSpace = Number(ticketSpaceConstant.value);
    const playerA = anchor.web3.Keypair.generate();
    const playerB = anchor.web3.Keypair.generate();
    const zeroBuyer = anchor.web3.Keypair.generate();
    const maxQuantityBuyer = anchor.web3.Keypair.generate();
    const poorNewBuyer = anchor.web3.Keypair.generate();
    const poorRepeatBuyer = anchor.web3.Keypair.generate();
    const securityBuyers = Array.from({ length: 20 }, () =>
      anchor.web3.Keypair.generate()
    );
    const substituteSystemAccount = anchor.web3.Keypair.generate().publicKey;
    let minimumRent = 0;
    let ticketRent = 0;
    let activeRoundId = new anchor.BN(0);
    let activeRound = anchor.web3.PublicKey.default;
    let activePrizeVault = anchor.web3.PublicKey.default;
    let saleDeadline = new anchor.BN(0);

    function u64Le(value: anchor.BN): Buffer {
      return value.toArrayLike(Buffer, "le", 8);
    }

    function roundPdas(roundId: anchor.BN) {
      const [round, roundBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round"), u64Le(roundId)],
        program.programId
      );
      const [prizeVault, prizeVaultBump] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("prize_vault_seed"), u64Le(roundId)],
          program.programId
        );
      return { round, roundBump, prizeVault, prizeVaultBump };
    }

    function ticketPda(user: anchor.web3.PublicKey, roundId = activeRoundId) {
      const [ticket, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), u64Le(roundId), user.toBuffer()],
        program.programId
      );
      return { ticket, bump };
    }

    function createAccounts(roundId: anchor.BN) {
      const { round, prizeVault } = roundPdas(roundId);
      return {
        authority: provider.wallet.publicKey,
        config,
        round,
        prizeVault,
        rolloverVault,
        systemProgram,
      };
    }

    function buyAccounts(buyer: anchor.web3.PublicKey) {
      return {
        round: activeRound,
        ticket: ticketPda(buyer).ticket,
        prizeVault: activePrizeVault,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram,
      };
    }

    type BuyAccounts = ReturnType<typeof buyAccounts>;

    async function quotePayment(
      buyer: anchor.web3.PublicKey,
      quantity: number
    ) {
      const ticket = ticketPda(buyer).ticket;
      const info = await provider.connection.getAccountInfo(
        ticket,
        "confirmed"
      );
      const isNew =
        info === null ||
        (info.owner.equals(systemProgram) && info.data.length === 0);
      const rentTopUp = isNew
        ? Math.max(ticketRent - (info?.lamports ?? 0), 0)
        : 0;
      const businessPayment = phase2Price.mul(new anchor.BN(quantity));
      const expectedPayment = businessPayment.add(new anchor.BN(rentTopUp));
      if (expectedPayment.gt(new anchor.BN(Number.MAX_SAFE_INTEGER))) {
        throw new Error("quoted payment does not fit a JavaScript number");
      }
      return {
        businessPayment,
        expectedPayment: expectedPayment.toNumber(),
        rentTopUp,
        ticket,
      };
    }

    async function buyInstruction(
      buyer: anchor.web3.PublicKey,
      quantity: number,
      overrides: Partial<BuyAccounts> = {}
    ) {
      return program.methods
        .buyTicketV2(buyer, quantity)
        .accountsStrict({ ...buyAccounts(buyer), ...overrides })
        .instruction();
    }

    function paymentInstruction(
      source: anchor.web3.PublicKey,
      destination: anchor.web3.PublicKey,
      lamports: number
    ) {
      return anchor.web3.SystemProgram.transfer({
        fromPubkey: source,
        toPubkey: destination,
        lamports,
      });
    }

    async function buyTransaction(
      buyer: anchor.web3.PublicKey,
      quantity: number,
      options: {
        accounts?: Partial<BuyAccounts>;
        amount?: number;
        source?: anchor.web3.PublicKey;
        destination?: anchor.web3.PublicKey;
        beforePayment?: anchor.web3.TransactionInstruction[];
        betweenPaymentAndBuy?: anchor.web3.TransactionInstruction[];
        payment?: anchor.web3.TransactionInstruction | null;
      } = {}
    ) {
      const quote =
        options.amount === undefined
          ? await quotePayment(buyer, quantity)
          : undefined;
      const source = options.source ?? buyer;
      const destination = options.destination ?? activePrizeVault;
      const amount = options.amount ?? quote!.expectedPayment;
      const payment =
        options.payment === undefined
          ? paymentInstruction(source, destination, amount)
          : options.payment;
      const transaction = new anchor.web3.Transaction();
      if ((options.beforePayment?.length ?? 0) > 0) {
        transaction.add(...options.beforePayment!);
      }
      if (payment !== null) transaction.add(payment);
      if ((options.betweenPaymentAndBuy?.length ?? 0) > 0) {
        transaction.add(...options.betweenPaymentAndBuy!);
      }
      transaction.add(await buyInstruction(buyer, quantity, options.accounts));
      return transaction;
    }

    async function snapshot(
      addresses: anchor.web3.PublicKey[]
    ): Promise<Snapshot[]> {
      const accounts = await provider.connection.getMultipleAccountsInfo(
        addresses,
        "confirmed"
      );
      return accounts.map((account) =>
        account === null
          ? null
          : {
              owner: account.owner.toBase58(),
              lamports: account.lamports,
              data: account.data.toString("base64"),
              executable: account.executable,
            }
      );
    }

    async function surfpoolRpc(method: string, params: unknown[]) {
      const endpoint = new URL(provider.connection.rpcEndpoint);
      if (
        endpoint.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(endpoint.hostname)
      ) {
        throw new Error("Phase 2 fixtures require a local Surfpool RPC");
      }
      const response = await (
        provider.connection as unknown as RpcConnection
      )._rpcRequest(method, params);
      if (response.error !== undefined) {
        throw new Error(`${method}: ${JSON.stringify(response.error)}`);
      }
      return response.result;
    }

    async function setAccount(
      address: anchor.web3.PublicKey,
      account: {
        lamports: number;
        data: Buffer;
        owner: anchor.web3.PublicKey;
        executable: boolean;
      }
    ) {
      await surfpoolRpc("surfnet_setAccount", [
        address.toBase58(),
        {
          lamports: account.lamports,
          data: account.data.toString("hex"),
          owner: account.owner.toBase58(),
          executable: account.executable,
        },
      ]);
    }

    async function chainTimestamp() {
      const clock = await provider.connection.getAccountInfo(
        anchor.web3.SYSVAR_CLOCK_PUBKEY,
        "confirmed"
      );
      expect(clock).not.to.equal(null);
      return new anchor.BN(clock!.data.subarray(32, 40), "le").fromTwos(64);
    }

    async function setChainTime(timestamp: anchor.BN) {
      await surfpoolRpc("surfnet_timeTravel", [
        { absoluteTimestamp: timestamp.mul(new anchor.BN(1000)).toNumber() },
      ]);
      expect((await chainTimestamp()).gte(timestamp)).to.equal(true);
    }

    async function submitRecorded(
      transaction: anchor.web3.Transaction,
      signers: anchor.web3.Keypair[] = []
    ) {
      const latest = await provider.connection.getLatestBlockhash("confirmed");
      transaction.feePayer = provider.wallet.publicKey;
      transaction.recentBlockhash = latest.blockhash;
      if (signers.length > 0) transaction.partialSign(...signers);
      const signed = await provider.wallet.signTransaction(transaction);
      const signature = await provider.connection.sendRawTransaction(
        signed.serialize(),
        { skipPreflight: true }
      );
      await provider.connection.confirmTransaction(
        { signature, ...latest },
        "confirmed"
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const receipt = await provider.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (receipt?.meta) return receipt;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`confirmed receipt unavailable: ${signature}`);
    }

    function expectReceiptError(
      receipt: Awaited<ReturnType<typeof submitRecorded>>,
      code: string
    ) {
      expect(receipt.meta!.err).not.to.equal(null);
      const parsed = anchor.AnchorError.parse(receipt.meta!.logMessages ?? []);
      expect(parsed, receipt.meta!.logMessages?.join("\n")).not.to.equal(null);
      expect(parsed!.error.errorCode.code).to.equal(code);
    }

    async function expectRejectedWithoutChanges(
      transaction: anchor.web3.Transaction,
      code: string,
      addresses: anchor.web3.PublicKey[],
      signers: anchor.web3.Keypair[] = []
    ) {
      const before = await snapshot(addresses);
      const receipt = await submitRecorded(transaction, signers);
      expectReceiptError(receipt, code);
      expect(await snapshot(addresses)).to.deep.equal(before);
      return receipt;
    }

    async function rejectBuy(
      user: anchor.web3.Keypair,
      quantity: number,
      code: string,
      overrides: Partial<BuyAccounts> = {},
      amount?: number
    ) {
      const accounts = { ...buyAccounts(user.publicKey), ...overrides };
      const watched = [
        config,
        rolloverVault,
        activeRound,
        activePrizeVault,
        ticketPda(user.publicKey).ticket,
        accounts.ticket,
        user.publicKey,
      ];
      const transaction = await buyTransaction(user.publicKey, quantity, {
        accounts,
        amount: amount ?? (buyMode === "payment-overflow" ? 1 : undefined),
      });
      return expectRejectedWithoutChanges(transaction, code, watched, [user]);
    }

    async function purchase(
      user: anchor.web3.Keypair,
      quantity: number,
      previousQuantity: number,
      beforePayment: anchor.web3.TransactionInstruction[] = []
    ) {
      const { ticket, bump } = ticketPda(user.publicKey);
      const ticketBefore = await provider.connection.getAccountInfo(
        ticket,
        "confirmed"
      );
      const wasExisting =
        ticketBefore?.owner.equals(program.programId) ?? false;
      expect(wasExisting).to.equal(previousQuantity > 0);
      const previous = wasExisting
        ? await program.account.ticket.fetch(ticket, "confirmed")
        : null;
      const roundBefore = await program.account.round.fetch(
        activeRound,
        "confirmed"
      );
      const vaultBefore = await provider.connection.getBalance(
        activePrizeVault,
        "confirmed"
      );
      const userBefore = await provider.connection.getBalance(
        user.publicKey,
        "confirmed"
      );
      const quote = await quotePayment(user.publicKey, quantity);
      const receipt = await submitRecorded(
        await buyTransaction(user.publicKey, quantity, {
          amount: quote.expectedPayment,
          beforePayment,
        }),
        [user]
      );
      expect(receipt.meta!.err, receipt.meta!.logMessages?.join("\n")).to.equal(
        null
      );

      const ticketInfo = await provider.connection.getAccountInfo(
        ticket,
        "confirmed"
      );
      const created = await program.account.ticket.fetch(ticket, "confirmed");
      expect(ticketInfo).not.to.equal(null);
      expect(ticketInfo!.owner.equals(program.programId)).to.equal(true);
      expect(ticketInfo!.data.length).to.equal(ticketSpace);
      expect(created.user.equals(user.publicKey)).to.equal(true);
      expect(created.roundId.eq(activeRoundId)).to.equal(true);
      expect(created.quantity).to.equal(previousQuantity + quantity);
      expect(created.outcome).to.deep.equal({ unregistered: {} });
      expect(created.bump).to.equal(bump);
      if (previous === null) {
        expect(ticketInfo!.lamports).to.equal(ticketRent);
      } else {
        expect(ticketInfo!.lamports).to.equal(ticketBefore!.lamports);
        expect(created.user.equals(previous.user)).to.equal(true);
        expect(created.roundId.eq(previous.roundId)).to.equal(true);
        expect(created.outcome).to.deep.equal(previous.outcome);
        expect(created.bump).to.equal(previous.bump);
      }

      const roundAfter = await program.account.round.fetch(
        activeRound,
        "confirmed"
      );
      expect(
        roundAfter.salesProceeds
          .sub(roundBefore.salesProceeds)
          .eq(quote.businessPayment)
      ).to.equal(true);
      expect(roundAfter.ticketPrice.eq(phase2Price)).to.equal(true);
      const vaultAfter = await provider.connection.getBalance(
        activePrizeVault,
        "confirmed"
      );
      expect(
        new anchor.BN(vaultAfter - vaultBefore).eq(quote.businessPayment)
      ).to.equal(true);
      const userAfter = await provider.connection.getBalance(
        user.publicKey,
        "confirmed"
      );
      expect(
        new anchor.BN(userBefore - userAfter).eq(
          new anchor.BN(quote.expectedPayment)
        )
      ).to.equal(true);
      expect(
        new anchor.BN(vaultAfter - minimumRent).eq(
          roundAfter.rolloverIn.add(roundAfter.salesProceeds)
        )
      ).to.equal(true);
    }

    before(async () => {
      minimumRent = await provider.connection.getMinimumBalanceForRentExemption(
        0
      );
      expect(ticketSpace).to.equal(program.account.ticket.size);
      ticketRent = await provider.connection.getMinimumBalanceForRentExemption(
        ticketSpace
      );
      const current = await program.account.lottoConfig.fetch(
        config,
        "confirmed"
      );
      expect(current.activeRoundId).to.equal(null);
      expect(
        await provider.connection.getBalance(rolloverVault, "confirmed")
      ).to.equal(minimumRent);

      if (businessRollover > 0) {
        await provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            anchor.web3.SystemProgram.transfer({
              fromPubkey: provider.wallet.publicKey,
              toPubkey: rolloverVault,
              lamports: businessRollover,
            })
          ),
          [],
          { commitment: "confirmed" }
        );
      }
      await updateCall({
        ticketPrice: phase2Price,
        tierThresholds: current.tierThresholds as [number, number, number],
        tierPoolBps: current.tierPoolBps as [number, number, number],
      }).rpc({ commitment: "confirmed" });

      const funding = [
        { key: playerA.publicKey, lamports: 2 * anchor.web3.LAMPORTS_PER_SOL },
        { key: playerB.publicKey, lamports: 2 * anchor.web3.LAMPORTS_PER_SOL },
        { key: zeroBuyer.publicKey, lamports: anchor.web3.LAMPORTS_PER_SOL },
        {
          key: maxQuantityBuyer.publicKey,
          lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
        },
        { key: poorNewBuyer.publicKey, lamports: ticketRent },
        { key: poorRepeatBuyer.publicKey, lamports: ticketRent + 1 },
        { key: substituteSystemAccount, lamports: minimumRent },
      ];
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          ...funding.map(({ key, lamports }) =>
            anchor.web3.SystemProgram.transfer({
              fromPubkey: provider.wallet.publicKey,
              toPubkey: key,
              lamports,
            })
          )
        ),
        [],
        { commitment: "confirmed" }
      );

      for (let offset = 0; offset < securityBuyers.length; offset += 6) {
        await provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            ...securityBuyers.slice(offset, offset + 6).map((buyer) =>
              anchor.web3.SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: buyer.publicKey,
                lamports: anchor.web3.LAMPORTS_PER_SOL,
              })
            )
          ),
          [],
          { commitment: "confirmed" }
        );
      }
    });

    it("rejects a non-Config authority with ConstraintHasOne and no partial initialization", async () => {
      const unauthorized = anchor.web3.Keypair.generate();
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: unauthorized.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL,
          })
        ),
        [],
        { commitment: "confirmed" }
      );
      const current = await program.account.lottoConfig.fetch(config);
      const accounts = {
        ...createAccounts(current.nextRoundId),
        authority: unauthorized.publicKey,
      };
      const canonical = roundPdas(current.nextRoundId);
      await expectRejectedWithoutChanges(
        await program.methods
          .createRound()
          .accountsStrict(accounts)
          .transaction(),
        "ConstraintHasOne",
        [config, rolloverVault, canonical.round, canonical.prizeVault],
        [unauthorized]
      );
    });

    for (const role of ["round", "prizeVault", "rolloverVault"] as const) {
      it(`rejects a substituted ${role} PDA with ConstraintSeeds and no partial mutation`, async () => {
        const current = await program.account.lottoConfig.fetch(config);
        const accounts = createAccounts(current.nextRoundId);
        const later = roundPdas(current.nextRoundId.add(new anchor.BN(1)));
        const wrong =
          role === "rolloverVault"
            ? anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("wrong_rollover_vault")],
                program.programId
              )[0]
            : later[role];
        const supplied = { ...accounts, [role]: wrong };
        await expectRejectedWithoutChanges(
          await program.methods
            .createRound()
            .accountsStrict(supplied)
            .transaction(),
          "ConstraintSeeds",
          [config, rolloverVault, accounts.round, accounts.prizeVault, wrong]
        );
      });
    }

    it("rolls back Round creation and rollover when a later transaction instruction fails", async () => {
      const current = await program.account.lottoConfig.fetch(config);
      const accounts = createAccounts(current.nextRoundId);
      const watched = [
        config,
        rolloverVault,
        accounts.round,
        accounts.prizeVault,
      ];
      const before = await snapshot(watched);
      const impossiblePayment = Number.MAX_SAFE_INTEGER;
      const transaction = await program.methods
        .createRound()
        .accountsStrict(accounts)
        .postInstructions([
          anchor.web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: rolloverVault,
            lamports: impossiblePayment,
          }),
        ])
        .transaction();
      const receipt = await submitRecorded(transaction);
      expect(receipt.meta!.err).to.deep.equal({
        InstructionError: [1, { Custom: 1 }],
      });
      expect(receipt.meta!.logMessages).to.include(
        `Program ${program.programId.toBase58()} success`
      );
      expect(await snapshot(watched)).to.deep.equal(before);
    });

    it("creates the canonical Round and vault, snapshots Config, and transfers only rollover business SOL", async () => {
      const configBefore = await program.account.lottoConfig.fetch(config);
      activeRoundId = configBefore.nextRoundId;
      const pdas = roundPdas(activeRoundId);
      activeRound = pdas.round;
      activePrizeVault = pdas.prizeVault;
      const beforeTime = await chainTimestamp();
      const signature = await program.methods
        .createRound()
        .accountsStrict(createAccounts(activeRoundId))
        .rpc({ commitment: "confirmed" });
      const afterTime = await chainTimestamp();
      const [configAfter, created, roundInfo, prizeInfo, rolloverInfo] =
        await Promise.all([
          program.account.lottoConfig.fetch(config, "confirmed"),
          program.account.round.fetch(activeRound, "confirmed"),
          provider.connection.getAccountInfo(activeRound, "confirmed"),
          provider.connection.getAccountInfo(activePrizeVault, "confirmed"),
          provider.connection.getAccountInfo(rolloverVault, "confirmed"),
        ]);

      expect(configAfter.activeRoundId?.eq(activeRoundId)).to.equal(true);
      expect(
        configAfter.nextRoundId.eq(activeRoundId.add(new anchor.BN(1)))
      ).to.equal(true);
      expect(created.roundId.eq(activeRoundId)).to.equal(true);
      expect(created.status).to.deep.equal({ selling: {} });
      expect(created.bump).to.equal(pdas.roundBump);
      expect(created.ticketPrice.eq(phase2Price)).to.equal(true);
      expect(created.tierThresholds).to.deep.equal(configBefore.tierThresholds);
      expect(created.tierPoolBps).to.deep.equal(configBefore.tierPoolBps);
      expect(created.saleDurationSecs.eq(new anchor.BN(2))).to.equal(true);
      expect(created.registrationDurationSecs.eq(new anchor.BN(2))).to.equal(
        true
      );
      expect(created.claimDurationSecs.eq(new anchor.BN(2))).to.equal(true);
      const createdAt = created.saleDeadline.sub(created.saleDurationSecs);
      expect(createdAt.gte(beforeTime) && createdAt.lte(afterTime)).to.equal(
        true
      );
      saleDeadline = created.saleDeadline;
      expect(created.registrationDeadline.isZero()).to.equal(true);
      expect(created.claimDeadline.isZero()).to.equal(true);
      expect(created.randomnessRequestedAt.isZero()).to.equal(true);
      expect(created.randomnessReceivedAt.isZero()).to.equal(true);
      expect(created.randomnessReady).to.equal(false);
      expect(Array.from(created.randomnessBinding)).to.deep.equal(
        new Array(32).fill(0)
      );
      expect(Array.from(created.randomness)).to.deep.equal(
        new Array(32).fill(0)
      );
      expect(
        created.registeredUnits.map((value) => value.toString())
      ).to.deep.equal(["0", "0", "0"]);
      expect(
        created.prizePerUnit.map((value) => value.toString())
      ).to.deep.equal(["0", "0", "0"]);
      expect(created.salesProceeds.isZero()).to.equal(true);
      expect(created.rolloverIn.eq(new anchor.BN(businessRollover))).to.equal(
        true
      );
      expect(roundInfo!.owner.equals(program.programId)).to.equal(true);
      expect(roundInfo!.data.length).to.equal(program.account.round.size);
      expect(prizeInfo!.owner.equals(systemProgram)).to.equal(true);
      expect(prizeInfo!.data.length).to.equal(0);
      expect(prizeInfo!.lamports).to.equal(minimumRent + businessRollover);
      expect(rolloverInfo!.owner.equals(systemProgram)).to.equal(true);
      expect(rolloverInfo!.data.length).to.equal(0);
      expect(rolloverInfo!.lamports).to.equal(minimumRent);
      const transaction = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      expect(transaction?.meta?.err).to.equal(null);
    });

    it("rejects a second active Round and rolls back both init accounts", async () => {
      const current = await program.account.lottoConfig.fetch(config);
      const accounts = createAccounts(current.nextRoundId);
      await expectRejectedWithoutChanges(
        await program.methods
          .createRound()
          .accountsStrict(accounts)
          .transaction(),
        "ActiveRoundExists",
        [config, rolloverVault, accounts.round, accounts.prizeVault]
      );
    });

    describe("buy_ticket_v2", function () {
      const [
        missingPreviousBuyer,
        nonSystemBuyer,
        nonTransferBuyer,
        wrongSourceBuyer,
        wrongSource,
        wrongDestinationBuyer,
        underpayBuyer,
        overpayBuyer,
        trailingDataBuyer,
        extraMetaBuyer,
        interruptedBuyer,
        computeBudgetBuyer,
        prefundedBuyer,
        invalidOwnerBuyer,
        corruptDataBuyer,
        wrongUserBuyer,
        wrongRoundBuyer,
        wrongBumpBuyer,
        staleQuoteBuyer,
        replayBuyer,
      ] = securityBuyers;

      function watchedFor(
        buyer: anchor.web3.PublicKey,
        ...extra: anchor.web3.PublicKey[]
      ) {
        return [
          activeRound,
          activePrizeVault,
          ticketPda(buyer).ticket,
          buyer,
          ...extra,
        ];
      }

      async function setTicketFixture(
        buyer: anchor.web3.PublicKey,
        overrides: Partial<{
          user: anchor.web3.PublicKey;
          roundId: anchor.BN;
          quantity: number;
          outcome: { unregistered: Record<string, never> };
          bump: number;
        }> = {}
      ) {
        const { ticket, bump } = ticketPda(buyer);
        const encoded = await program.coder.accounts.encode("ticket", {
          user: buyer,
          roundId: activeRoundId,
          quantity: 1,
          outcome: { unregistered: {} },
          bump,
          ...overrides,
        } as never);
        const data = Buffer.alloc(ticketSpace);
        encoded.copy(data);
        await setAccount(ticket, {
          lamports: ticketRent,
          data,
          owner: program.programId,
          executable: false,
        });
      }

      before(async () => {
        const current = await program.account.lottoConfig.fetch(config);
        expect(current.activeRoundId?.eq(activeRoundId)).to.equal(true);
        const active = await program.account.round.fetch(activeRound);
        expect(active.saleDeadline.eq(saleDeadline)).to.equal(true);
        expect((await chainTimestamp()).lt(saleDeadline)).to.equal(true);
      });

      it("rejects zero quantity and rolls back the preceding payment", async () => {
        expect(
          await snapshot([ticketPda(zeroBuyer.publicKey).ticket])
        ).to.deep.equal([null]);
        await rejectBuy(zeroBuyer, 0, "InvalidTicketQuantity");
      });

      it("rejects a substituted System account for Round with a framework owner error", async () => {
        await rejectBuy(playerA, 1, "AccountOwnedByWrongProgram", {
          round: substituteSystemAccount,
        });
      });

      it("rejects another player's or another round's Ticket with ConstraintSeeds", async () => {
        await rejectBuy(playerA, 1, "ConstraintSeeds", {
          ticket: ticketPda(playerB.publicKey).ticket,
        });
        await rejectBuy(playerA, 1, "ConstraintSeeds", {
          ticket: ticketPda(
            playerA.publicKey,
            activeRoundId.add(new anchor.BN(1))
          ).ticket,
        });
      });

      it("rejects a substituted System-owned Prize Vault with ConstraintSeeds", async () => {
        await rejectBuy(playerA, 1, "ConstraintSeeds", {
          prizeVault: substituteSystemAccount,
        });
      });

      it("distinguishes wrong lifecycle state from an expired Selling deadline", async () => {
        const info = await provider.connection.getAccountInfo(
          activeRound,
          "confirmed"
        );
        const active = await program.account.round.fetch(activeRound);
        const modified = { ...active, status: { randomnessPending: {} } };
        const encoded = await program.coder.accounts.encode(
          "round",
          modified as never
        );
        await setAccount(activeRound, {
          lamports: info!.lamports,
          data: encoded,
          owner: info!.owner,
          executable: false,
        });
        try {
          await rejectBuy(playerA, 1, "RoundNotSelling");
        } finally {
          await setAccount(activeRound, {
            lamports: info!.lamports,
            data: info!.data,
            owner: info!.owner,
            executable: false,
          });
        }
      });

      if (buyMode === "payment-overflow") {
        it("rejects ticket_price * quantity overflow with ArithmeticError and full rollback", async () => {
          expect(phase2Price.eq(overflowPrice)).to.equal(true);
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(playerA.publicKey).ticket,
            playerA.publicKey,
          ];
          const before = await snapshot(watched);
          const receipt = await rejectBuy(playerA, 2, "ArithmeticError", {}, 1);
          expect(receipt.meta!.logMessages).to.include(
            `Program ${systemProgram.toBase58()} success`
          );
          expect(await snapshot(watched)).to.deep.equal(before);
        });
      } else {
        it("rejects buyTicketV2 without a previous instruction", async () => {
          await expectRejectedWithoutChanges(
            new anchor.web3.Transaction().add(
              await buyInstruction(missingPreviousBuyer.publicKey, 1)
            ),
            "InvalidPaymentInstruction",
            watchedFor(missingPreviousBuyer.publicKey)
          );
        });

        it("rejects a previous instruction from a non-System program", async () => {
          const transaction = new anchor.web3.Transaction().add(
            anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
              units: 300_000,
            }),
            await buyInstruction(nonSystemBuyer.publicKey, 1)
          );
          await expectRejectedWithoutChanges(
            transaction,
            "InvalidPaymentInstruction",
            watchedFor(nonSystemBuyer.publicKey)
          );
        });

        it("rejects a previous System instruction that is not Transfer", async () => {
          const allocate = anchor.web3.SystemProgram.allocate({
            accountPubkey: nonTransferBuyer.publicKey,
            space: 0,
          });
          const transaction = new anchor.web3.Transaction().add(
            allocate,
            await buyInstruction(nonTransferBuyer.publicKey, 1)
          );
          await expectRejectedWithoutChanges(
            transaction,
            "InvalidPaymentInstruction",
            watchedFor(nonTransferBuyer.publicKey),
            [nonTransferBuyer]
          );
        });

        it("rejects a payment source that differs from buyer", async () => {
          const quote = await quotePayment(wrongSourceBuyer.publicKey, 1);
          await expectRejectedWithoutChanges(
            await buyTransaction(wrongSourceBuyer.publicKey, 1, {
              amount: quote.expectedPayment,
              source: wrongSource.publicKey,
            }),
            "PaymentSourceMismatch",
            watchedFor(wrongSourceBuyer.publicKey, wrongSource.publicKey),
            [wrongSource]
          );
        });

        it("rejects a payment destination that is not the canonical Prize Vault", async () => {
          const quote = await quotePayment(wrongDestinationBuyer.publicKey, 1);
          await expectRejectedWithoutChanges(
            await buyTransaction(wrongDestinationBuyer.publicKey, 1, {
              amount: quote.expectedPayment,
              destination: substituteSystemAccount,
            }),
            "PaymentDestinationMismatch",
            watchedFor(
              wrongDestinationBuyer.publicKey,
              substituteSystemAccount
            ),
            [wrongDestinationBuyer]
          );
        });

        for (const [label, buyer, delta] of [
          ["underpayment", underpayBuyer, -1],
          ["overpayment", overpayBuyer, 1],
        ] as const) {
          it(`rejects ${label} and rolls back the transfer`, async () => {
            const quote = await quotePayment(buyer.publicKey, 1);
            await expectRejectedWithoutChanges(
              await buyTransaction(buyer.publicKey, 1, {
                amount: quote.expectedPayment + delta,
              }),
              "PaymentAmountMismatch",
              watchedFor(buyer.publicKey),
              [buyer]
            );
          });
        }

        it("rejects canonical Transfer data with trailing bytes", async () => {
          const quote = await quotePayment(trailingDataBuyer.publicKey, 1);
          const canonical = paymentInstruction(
            trailingDataBuyer.publicKey,
            activePrizeVault,
            quote.expectedPayment
          );
          const malformed = new anchor.web3.TransactionInstruction({
            programId: canonical.programId,
            keys: canonical.keys,
            data: Buffer.concat([canonical.data, Buffer.from([0])]),
          });
          await expectRejectedWithoutChanges(
            await buyTransaction(trailingDataBuyer.publicKey, 1, {
              payment: malformed,
            }),
            "InvalidPaymentInstruction",
            watchedFor(trailingDataBuyer.publicKey),
            [trailingDataBuyer]
          );
        });

        it("rejects a Transfer carrying a third account meta", async () => {
          const quote = await quotePayment(extraMetaBuyer.publicKey, 1);
          const canonical = paymentInstruction(
            extraMetaBuyer.publicKey,
            activePrizeVault,
            quote.expectedPayment
          );
          const withExtraMeta = new anchor.web3.TransactionInstruction({
            programId: canonical.programId,
            keys: [
              ...canonical.keys,
              {
                pubkey: substituteSystemAccount,
                isSigner: false,
                isWritable: false,
              },
            ],
            data: canonical.data,
          });
          await expectRejectedWithoutChanges(
            await buyTransaction(extraMetaBuyer.publicKey, 1, {
              payment: withExtraMeta,
            }),
            "InvalidPaymentInstruction",
            watchedFor(extraMetaBuyer.publicKey),
            [extraMetaBuyer]
          );
        });

        it("only accepts the immediately previous top-level instruction", async () => {
          const quote = await quotePayment(interruptedBuyer.publicKey, 1);
          await expectRejectedWithoutChanges(
            await buyTransaction(interruptedBuyer.publicKey, 1, {
              amount: quote.expectedPayment,
              betweenPaymentAndBuy: [
                anchor.web3.SystemProgram.allocate({
                  accountPubkey: interruptedBuyer.publicKey,
                  space: 0,
                }),
              ],
            }),
            "InvalidPaymentInstruction",
            watchedFor(interruptedBuyer.publicKey),
            [interruptedBuyer]
          );
        });

        it("allows ComputeBudget instructions before the payment transfer", async () => {
          await purchase(computeBudgetBuyer, 1, 0, [
            anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
              units: 300_000,
            }),
          ]);
        });

        it("keeps the Round snapshot after Config repricing and charges P1", async () => {
          const configBefore = await program.account.lottoConfig.fetch(config);
          const roundBefore = await snapshot([
            activeRound,
            activePrizeVault,
            rolloverVault,
          ]);
          const futurePrice = phase2Price.add(new anchor.BN(777_777));
          await updateCall({
            ticketPrice: futurePrice,
            tierThresholds: configBefore.tierThresholds as [
              number,
              number,
              number
            ],
            tierPoolBps: configBefore.tierPoolBps as [number, number, number],
          }).rpc({ commitment: "confirmed" });
          expect(
            (await program.account.lottoConfig.fetch(config)).ticketPrice.eq(
              futurePrice
            )
          ).to.equal(true);
          expect(
            await snapshot([activeRound, activePrizeVault, rolloverVault])
          ).to.deep.equal(roundBefore);
          await purchase(playerA, 3, 0);
        });

        it("reuses the canonical Ticket and charges only the repeated delta", async () => {
          if (
            (await provider.connection.getAccountInfo(
              ticketPda(playerA.publicKey).ticket,
              "confirmed"
            )) === null
          ) {
            await setTicketFixture(playerA.publicKey, { quantity: 3 });
          }
          await purchase(playerA, 2, 3);
        });

        it("initializes a third-party-prefunded System-owned Ticket PDA", async () => {
          const ticket = ticketPda(prefundedBuyer.publicKey).ticket;
          const prefundedLamports = ticketRent;
          await provider.sendAndConfirm(
            new anchor.web3.Transaction().add(
              paymentInstruction(
                provider.wallet.publicKey,
                ticket,
                prefundedLamports
              )
            ),
            [],
            { commitment: "confirmed" }
          );
          const before = await provider.connection.getAccountInfo(
            ticket,
            "confirmed"
          );
          expect(before!.owner.equals(systemProgram)).to.equal(true);
          expect(before!.data.length).to.equal(0);
          expect(before!.lamports).to.equal(prefundedLamports);
          const quote = await quotePayment(prefundedBuyer.publicKey, 1);
          expect(quote.rentTopUp).to.equal(0);
          await purchase(prefundedBuyer, 1, 0);
        });

        it("keeps Player A and B Tickets isolated while aggregating one ledger", async () => {
          expect(
            ticketPda(playerA.publicKey).ticket.equals(
              ticketPda(playerB.publicKey).ticket
            )
          ).to.equal(false);
          const playerABefore = await snapshot([
            ticketPda(playerA.publicKey).ticket,
          ]);
          await setTicketFixture(playerB.publicKey, { quantity: 1 });
          await purchase(playerB, 4, 1);
          expect(
            await snapshot([ticketPda(playerA.publicKey).ticket])
          ).to.deep.equal(playerABefore);
        });

        it("checks u32 Ticket quantity addition and rolls back overflow", async () => {
          const maxQuantity = 0xffff_ffff;
          await setTicketFixture(maxQuantityBuyer.publicKey, {
            quantity: maxQuantity,
          });
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(maxQuantityBuyer.publicKey).ticket,
            maxQuantityBuyer.publicKey,
          ];
          const before = await snapshot(watched);
          await rejectBuy(maxQuantityBuyer, 1, "ArithmeticError");
          expect(await snapshot(watched)).to.deep.equal(before);
        });

        it("rejects a canonical Ticket PDA owned by another program", async () => {
          const ticket = ticketPda(invalidOwnerBuyer.publicKey).ticket;
          await setAccount(ticket, {
            lamports: ticketRent,
            data: Buffer.alloc(0),
            owner: substituteSystemAccount,
            executable: false,
          });
          await rejectBuy(
            invalidOwnerBuyer,
            1,
            "InvalidTicketAccountState",
            {},
            phase2Price.toNumber()
          );
        });

        it("rejects Lotto-owned Ticket data with an invalid discriminator", async () => {
          const ticket = ticketPda(corruptDataBuyer.publicKey).ticket;
          await setAccount(ticket, {
            lamports: ticketRent,
            data: Buffer.alloc(ticketSpace),
            owner: program.programId,
            executable: false,
          });
          await rejectBuy(corruptDataBuyer, 1, "InvalidTicketAccountState");
        });

        for (const [label, buyer, fixture] of [
          ["user", wrongUserBuyer, { user: playerA.publicKey }],
          [
            "round_id",
            wrongRoundBuyer,
            { roundId: activeRoundId.add(new anchor.BN(1)) },
          ],
          [
            "bump",
            wrongBumpBuyer,
            { bump: (ticketPda(wrongBumpBuyer.publicKey).bump + 1) % 256 },
          ],
        ] as const) {
          it(`rejects an existing Ticket with a mismatched inner ${label}`, async () => {
            await setTicketFixture(buyer.publicKey, fixture);
            await rejectBuy(buyer, 1, "InvalidTicketAccountState");
          });
        }

        it("rejects a stale New-Ticket quote and rolls back its transfer", async () => {
          const staleQuote = await quotePayment(staleQuoteBuyer.publicKey, 1);
          const staleTransaction = await buyTransaction(
            staleQuoteBuyer.publicKey,
            1,
            { amount: staleQuote.expectedPayment }
          );
          await purchase(staleQuoteBuyer, 1, 0);
          await expectRejectedWithoutChanges(
            staleTransaction,
            "PaymentAmountMismatch",
            watchedFor(staleQuoteBuyer.publicKey),
            [staleQuoteBuyer]
          );
        });

        it("cannot consume one valid transfer with two buyTicketV2 calls", async () => {
          const quote = await quotePayment(replayBuyer.publicKey, 1);
          const buy = await buyInstruction(replayBuyer.publicKey, 1);
          const transaction = new anchor.web3.Transaction().add(
            paymentInstruction(
              replayBuyer.publicKey,
              activePrizeVault,
              quote.expectedPayment
            ),
            buy,
            buy
          );
          await expectRejectedWithoutChanges(
            transaction,
            "InvalidPaymentInstruction",
            watchedFor(replayBuyer.publicKey),
            [replayBuyer]
          );
        });

        it("rolls back a newly initialized Ticket when the buyer cannot pay principal", async () => {
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(poorNewBuyer.publicKey).ticket,
            poorNewBuyer.publicKey,
          ];
          const before = await snapshot(watched);
          const receipt = await submitRecorded(
            await buyTransaction(poorNewBuyer.publicKey, 1),
            [poorNewBuyer]
          );
          expect(receipt.meta!.err).not.to.equal(null);
          expect(
            (receipt.meta!.logMessages ?? []).some((line) =>
              line.includes("Transfer: insufficient lamports")
            )
          ).to.equal(true);
          expect(await snapshot(watched)).to.deep.equal(before);
        });

        it("rolls back repeat quantity and ledger when the buyer cannot pay the delta", async () => {
          await setTicketFixture(poorRepeatBuyer.publicKey, { quantity: 1 });
          await setAccount(poorRepeatBuyer.publicKey, {
            lamports: 1,
            data: Buffer.alloc(0),
            owner: systemProgram,
            executable: false,
          });
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(poorRepeatBuyer.publicKey).ticket,
            poorRepeatBuyer.publicKey,
          ];
          const before = await snapshot(watched);
          const receipt = await submitRecorded(
            await buyTransaction(poorRepeatBuyer.publicKey, 2),
            [poorRepeatBuyer]
          );
          expect(receipt.meta!.err).not.to.equal(null);
          expect(await snapshot(watched)).to.deep.equal(before);
        });
      }

      it("rejects now == sale_deadline for both existing and new Tickets with full rollback", async () => {
        await setChainTime(saleDeadline);
        await rejectBuy(playerA, 1, "SaleClosed");
        await rejectBuy(zeroBuyer, 1, "SaleClosed");
        expect(
          await snapshot([ticketPda(zeroBuyer.publicKey).ticket])
        ).to.deep.equal([null]);
      });
    });

    describe("Phase 3 VRF lifecycle", function () {
      const callbackRandomness = Array.from(
        { length: 32 },
        (_, index) => index + 1
      );
      const callbackBinding = Array.from(
        { length: 32 },
        (_, index) => 255 - index
      );

      function requestAccounts(
        overrides: Partial<{
          authority: anchor.web3.PublicKey;
          config: anchor.web3.PublicKey;
          round: anchor.web3.PublicKey;
          oracleQueue: anchor.web3.PublicKey;
          programIdentity: anchor.web3.PublicKey;
          vrfProgram: anchor.web3.PublicKey;
          slotHashes: anchor.web3.PublicKey;
          systemProgram: anchor.web3.PublicKey;
        }> = {}
      ) {
        return {
          authority: provider.wallet.publicKey,
          config,
          round: activeRound,
          oracleQueue: vrfQueue,
          programIdentity: requestProgramIdentity,
          vrfProgram,
          slotHashes,
          systemProgram,
          ...overrides,
        };
      }

      function settleAccounts(
        overrides: Partial<{
          authority: anchor.web3.PublicKey;
          config: anchor.web3.PublicKey;
          round: anchor.web3.PublicKey;
        }> = {}
      ) {
        return {
          authority: provider.wallet.publicKey,
          config,
          round: activeRound,
          ...overrides,
        };
      }

      async function withActiveRoundFixture(
        overrides: Record<string, unknown>,
        operation: () => Promise<void>
      ) {
        const info = await provider.connection.getAccountInfo(
          activeRound,
          "confirmed"
        );
        const current = await program.account.round.fetch(
          activeRound,
          "confirmed"
        );
        const encoded = await program.coder.accounts.encode("round", {
          ...current,
          ...overrides,
        } as never);
        await setAccount(activeRound, {
          lamports: info!.lamports,
          data: encoded,
          owner: info!.owner,
          executable: false,
        });
        try {
          await operation();
        } finally {
          await setAccount(activeRound, {
            lamports: info!.lamports,
            data: info!.data,
            owner: info!.owner,
            executable: false,
          });
        }
      }

      function expectedActiveBinding() {
        return createHash("sha256")
          .update(
            Buffer.concat([
              Buffer.from("solana_lotto:randomness:v1"),
              program.programId.toBuffer(),
              activeRound.toBuffer(),
            ])
          )
          .digest();
      }

      it("rejects user- and Authority-signed direct callbacks at the scoped identity constraint", async () => {
        for (const [identity, signers] of [
          [playerA.publicKey, [playerA]],
          [provider.wallet.publicKey, []],
        ] as const) {
          const transaction = await program.methods
            .receiveRandomness(callbackRandomness, callbackBinding)
            .accountsStrict({
              vrfProgramIdentity: identity,
              round: activeRound,
            })
            .transaction();
          await expectRejectedWithoutChanges(
            transaction,
            "ConstraintAddress",
            [config, activeRound, activePrizeVault, rolloverVault],
            [...signers]
          );
        }
      });

      it("rejects the correct scoped callback identity when it is not a signer", async () => {
        const instruction = await program.methods
          .receiveRandomness(callbackRandomness, callbackBinding)
          .accountsStrict({
            vrfProgramIdentity: scopedVrfIdentity,
            round: activeRound,
          })
          .instruction();
        instruction.keys[0].isSigner = false;
        await expectRejectedWithoutChanges(
          new anchor.web3.Transaction().add(instruction),
          "AccountNotSigner",
          [config, activeRound, activePrizeVault, rolloverVault]
        );
      });

      it("rejects settle from Selling before readiness without lifecycle mutation", async () => {
        await expectRejectedWithoutChanges(
          await program.methods
            .settleRandomness()
            .accountsStrict(settleAccounts())
            .transaction(),
          "RoundNotRandomnessPending",
          [config, activeRound, activePrizeVault, rolloverVault]
        );
      });

      it("documents the bare-Surfpool request boundary before handler execution", async () => {
        const authorityBefore = await provider.connection.getBalance(
          provider.wallet.publicKey,
          "confirmed"
        );
        const transaction = await program.methods
          .requestRandomness()
          .accountsStrict(requestAccounts())
          .transaction();
        const receipt = await expectRejectedWithoutChanges(
          transaction,
          "InvalidProgramExecutable",
          [config, activeRound, activePrizeVault, rolloverVault]
        );
        expect(
          (receipt.meta!.logMessages ?? []).some((line) =>
            line.includes(`Program ${vrfProgram.toBase58()} invoke`)
          )
        ).to.equal(false);
        const authorityAfter = await provider.connection.getBalance(
          provider.wallet.publicKey,
          "confirmed"
        );
        expect(authorityBefore - authorityAfter).to.equal(receipt.meta!.fee);
      });

      describe("fixture-assisted request-side validation", function () {
        before(async () => {
          // This only makes the fixed VRF address executable enough to reach
          // handler/CPI paths. It is not a MagicBlock provider or callback E2E.
          const lottoExecutable = await provider.connection.getAccountInfo(
            program.programId,
            "confirmed"
          );
          expect(lottoExecutable).not.to.equal(null);
          await setAccount(vrfProgram, {
            lamports: lottoExecutable!.lamports,
            data: lottoExecutable!.data,
            owner: lottoExecutable!.owner,
            executable: true,
          });
        });

        it("rejects a non-Config authority and wrong queue with framework errors", async () => {
          await expectRejectedWithoutChanges(
            await program.methods
              .requestRandomness()
              .accountsStrict(requestAccounts({ authority: playerA.publicKey }))
              .transaction(),
            "ConstraintHasOne",
            [config, activeRound, activePrizeVault, rolloverVault],
            [playerA]
          );
          await expectRejectedWithoutChanges(
            await program.methods
              .requestRandomness()
              .accountsStrict(
                requestAccounts({ oracleQueue: substituteSystemAccount })
              )
              .transaction(),
            "ConstraintAddress",
            [config, activeRound, activePrizeVault, rolloverVault]
          );
        });

        it("rejects a canonical inactive Round with framework ConstraintRaw", async () => {
          const inactiveRoundId = activeRoundId.add(new anchor.BN(1));
          const inactive = roundPdas(inactiveRoundId);
          const [activeInfo, inactiveInfo] = await Promise.all([
            provider.connection.getAccountInfo(activeRound, "confirmed"),
            provider.connection.getAccountInfo(inactive.round, "confirmed"),
          ]);
          const active = await program.account.round.fetch(
            activeRound,
            "confirmed"
          );
          const encoded = await program.coder.accounts.encode("round", {
            ...active,
            roundId: inactiveRoundId,
            bump: inactive.roundBump,
          } as never);
          await setAccount(inactive.round, {
            lamports: activeInfo!.lamports,
            data: encoded,
            owner: program.programId,
            executable: false,
          });

          try {
            await expectRejectedWithoutChanges(
              await program.methods
                .requestRandomness()
                .accountsStrict(requestAccounts({ round: inactive.round }))
                .transaction(),
              "ConstraintRaw",
              [config, activeRound, inactive.round, activePrizeVault]
            );
            await expectRejectedWithoutChanges(
              await program.methods
                .settleRandomness()
                .accountsStrict(settleAccounts({ round: inactive.round }))
                .transaction(),
              "ConstraintRaw",
              [config, activeRound, inactive.round, activePrizeVault]
            );
          } finally {
            await setAccount(
              inactive.round,
              inactiveInfo === null
                ? {
                    lamports: 0,
                    data: Buffer.alloc(0),
                    owner: systemProgram,
                    executable: false,
                  }
                : {
                    lamports: inactiveInfo.lamports,
                    data: inactiveInfo.data,
                    owner: inactiveInfo.owner,
                    executable: inactiveInfo.executable,
                  }
            );
          }
        });

        it("uses the transition boundary now >= sale_deadline", async () => {
          const now = await chainTimestamp();
          await withActiveRoundFixture(
            {
              status: { selling: {} },
              randomnessReady: false,
              saleDeadline: now.add(new anchor.BN(100)),
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .requestRandomness()
                  .accountsStrict(requestAccounts())
                  .transaction(),
                "SaleStillOpen",
                [config, activeRound, activePrizeVault, rolloverVault]
              );
            }
          );
        });

        it("rejects request after the Round has left Selling", async () => {
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessReady: false,
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .requestRandomness()
                  .accountsStrict(requestAccounts())
                  .transaction(),
                "RoundNotSelling",
                [config, activeRound, activePrizeVault, rolloverVault]
              );
            }
          );
        });

        it("emits SDK 0.17.0 scoped request bytes and rolls back all state when the CPI fails", async () => {
          const watched = [
            config,
            activeRound,
            activePrizeVault,
            rolloverVault,
          ];
          const before = await snapshot(watched);
          const authorityBefore = await provider.connection.getBalance(
            provider.wallet.publicKey,
            "confirmed"
          );
          const receipt = await submitRecorded(
            await program.methods
              .requestRandomness()
              .accountsStrict(requestAccounts())
              .transaction()
          );
          expect(receipt.meta!.err).not.to.equal(null);
          expect(await snapshot(watched)).to.deep.equal(before);
          const authorityAfter = await provider.connection.getBalance(
            provider.wallet.publicKey,
            "confirmed"
          );
          expect(authorityBefore - authorityAfter).to.equal(receipt.meta!.fee);
          expect(
            (receipt.meta!.logMessages ?? []).some((line) =>
              line.includes(`Program ${vrfProgram.toBase58()} invoke`)
            )
          ).to.equal(true);

          const inner = receipt
            .meta!.innerInstructions?.flatMap(
              ({ instructions }) => instructions
            )
            .find((candidate) => "data" in candidate) as
            | { data: string }
            | undefined;
          expect(inner).not.to.equal(undefined);
          const data = Buffer.from(anchor.utils.bytes.bs58.decode(inner!.data));
          expect(data.subarray(0, 8)).to.deep.equal(
            Buffer.from([10, 0, 0, 0, 0, 0, 0, 0])
          );
          let offset = 8;
          const callerSeed = data.subarray(offset, (offset += 32));
          const callbackProgram = new anchor.web3.PublicKey(
            data.subarray(offset, (offset += 32))
          );
          const discriminatorLength = data.readUInt32LE(offset);
          offset += 4;
          const callbackDiscriminator = data.subarray(
            offset,
            (offset += discriminatorLength)
          );
          const callbackAccountCount = data.readUInt32LE(offset);
          offset += 4;
          expect(callbackAccountCount).to.equal(1);
          const callbackRound = new anchor.web3.PublicKey(
            data.subarray(offset, (offset += 32))
          );
          const callbackRoundSigner = data[offset++];
          const callbackRoundWritable = data[offset++];
          const callbackArgsLength = data.readUInt32LE(offset);
          offset += 4;
          const callbackArgs = data.subarray(
            offset,
            (offset += callbackArgsLength)
          );

          expect(callerSeed).to.deep.equal(expectedActiveBinding());
          expect(callbackProgram.equals(program.programId)).to.equal(true);
          expect(callbackDiscriminator).to.deep.equal(
            Buffer.from(
              rawIdl.instructions.find(
                ({ name }) => name === "receive_randomness"
              )!.discriminator
            )
          );
          expect(callbackRound.equals(activeRound)).to.equal(true);
          expect(callbackRoundSigner).to.equal(0);
          expect(callbackRoundWritable).to.equal(1);
          expect(callbackArgsLength).to.equal(32);
          expect(callbackArgs).to.deep.equal(expectedActiveBinding());
          expect(offset).to.equal(data.length);
        });
      });

      describe("fixture-assisted settle lifecycle", function () {
        it("rejects a non-Config authority with ConstraintHasOne", async () => {
          await expectRejectedWithoutChanges(
            await program.methods
              .settleRandomness()
              .accountsStrict(settleAccounts({ authority: playerA.publicKey }))
              .transaction(),
            "ConstraintHasOne",
            [config, activeRound, activePrizeVault, rolloverVault],
            [playerA]
          );
        });

        it("rejects RandomnessPending while randomness is not ready", async () => {
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessReady: false,
              registrationDeadline: new anchor.BN(0),
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .settleRandomness()
                  .accountsStrict(settleAccounts())
                  .transaction(),
                "RandomnessNotReady",
                [config, activeRound, activePrizeVault, rolloverVault]
              );
            }
          );
        });

        it("opens a complete registration window from settle time and preserves VRF state", async () => {
          const fixtureNow = await chainTimestamp();
          const binding = Array.from(expectedActiveBinding());
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessBinding: binding,
              randomnessRequestedAt: fixtureNow.sub(new anchor.BN(20)),
              randomnessReceivedAt: fixtureNow.sub(new anchor.BN(10)),
              randomnessReady: true,
              randomness: callbackRandomness,
              registrationDeadline: new anchor.BN(0),
            },
            async () => {
              const beforeTime = await chainTimestamp();
              const receipt = await submitRecorded(
                await program.methods
                  .settleRandomness()
                  .accountsStrict(settleAccounts())
                  .transaction()
              );
              expect(
                receipt.meta!.err,
                receipt.meta!.logMessages?.join("\n")
              ).to.equal(null);
              const afterTime = await chainTimestamp();
              const settled = await program.account.round.fetch(activeRound);
              const openedAt = settled.registrationDeadline.sub(
                settled.registrationDurationSecs
              );
              expect(
                openedAt.gte(beforeTime) && openedAt.lte(afterTime)
              ).to.equal(true);
              expect(settled.status).to.deep.equal({ registering: {} });
              expect(settled.randomnessReady).to.equal(true);
              expect(Array.from(settled.randomnessBinding)).to.deep.equal(
                binding
              );
              expect(Array.from(settled.randomness)).to.deep.equal(
                callbackRandomness
              );
              expect(
                settled.randomnessRequestedAt.eq(
                  fixtureNow.sub(new anchor.BN(20))
                )
              ).to.equal(true);
              expect(
                settled.randomnessReceivedAt.eq(
                  fixtureNow.sub(new anchor.BN(10))
                )
              ).to.equal(true);
            }
          );
        });

        it("uses ArithmeticError for registration deadline overflow", async () => {
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessReady: true,
              registrationDurationSecs: new anchor.BN("9223372036854775807"),
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .settleRandomness()
                  .accountsStrict(settleAccounts())
                  .transaction(),
                "ArithmeticError",
                [config, activeRound, activePrizeVault, rolloverVault]
              );
            }
          );
        });

        it("rejects repeat settle and cannot extend the registration deadline", async () => {
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessReady: true,
              registrationDeadline: new anchor.BN(0),
            },
            async () => {
              const first = await submitRecorded(
                await program.methods
                  .settleRandomness()
                  .accountsStrict(settleAccounts())
                  .transaction()
              );
              expect(first.meta!.err).to.equal(null);
              const beforeRepeat = await snapshot([
                config,
                activeRound,
                activePrizeVault,
                rolloverVault,
              ]);
              await expectRejectedWithoutChanges(
                await program.methods
                  .settleRandomness()
                  .accountsStrict(settleAccounts())
                  .transaction(),
                "RoundNotRandomnessPending",
                [config, activeRound, activePrizeVault, rolloverVault]
              );
              expect(
                await snapshot([
                  config,
                  activeRound,
                  activePrizeVault,
                  rolloverVault,
                ])
              ).to.deep.equal(beforeRepeat);
            }
          );
        });

        it("rolls back a successful settle when a later instruction fails", async () => {
          await withActiveRoundFixture(
            {
              status: { randomnessPending: {} },
              randomnessReady: true,
              registrationDeadline: new anchor.BN(0),
            },
            async () => {
              const watched = [
                config,
                activeRound,
                activePrizeVault,
                rolloverVault,
              ];
              const before = await snapshot(watched);
              const transaction = await program.methods
                .settleRandomness()
                .accountsStrict(settleAccounts())
                .postInstructions([
                  anchor.web3.SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: rolloverVault,
                    lamports: Number.MAX_SAFE_INTEGER,
                  }),
                ])
                .transaction();
              const receipt = await submitRecorded(transaction);
              expect(receipt.meta!.err).not.to.equal(null);
              expect(receipt.meta!.logMessages).to.include(
                `Program ${program.programId.toBase58()} success`
              );
              expect(await snapshot(watched)).to.deep.equal(before);
            }
          );
        });
      });
    });

    describe("Phase 4 winner registration", function () {
      this.timeout(60_000);

      const registrationUsers = Array.from({ length: 12 }, () =>
        anchor.web3.Keypair.generate()
      );

      function registerAccounts(
        user: anchor.web3.PublicKey,
        overrides: Partial<{
          user: anchor.web3.PublicKey;
          round: anchor.web3.PublicKey;
          ticket: anchor.web3.PublicKey;
          config: anchor.web3.PublicKey;
          treasury: anchor.web3.PublicKey;
        }> = {}
      ) {
        return {
          user,
          round: activeRound,
          ticket: ticketPda(user).ticket,
          config,
          treasury: provider.wallet.publicKey,
          ...overrides,
        };
      }

      async function putTicketFixture(
        user: anchor.web3.PublicKey,
        quantity: number
      ) {
        const { ticket, bump } = ticketPda(user);
        const encoded = await program.coder.accounts.encode("ticket", {
          user,
          roundId: activeRoundId,
          quantity,
          outcome: { unregistered: {} },
          bump,
        } as never);
        const data = Buffer.alloc(program.account.ticket.size);
        encoded.copy(data);
        await setAccount(ticket, {
          lamports: ticketRent,
          data,
          owner: program.programId,
          executable: false,
        });
        return ticket;
      }

      async function withRegistrationRound(
        overrides: Record<string, unknown>,
        operation: () => Promise<void>
      ) {
        const info = await provider.connection.getAccountInfo(
          activeRound,
          "confirmed"
        );
        const current = await program.account.round.fetch(
          activeRound,
          "confirmed"
        );
        const now = await chainTimestamp();
        const data = await program.coder.accounts.encode("round", {
          ...current,
          status: { registering: {} },
          registrationDeadline: now.add(new anchor.BN(1_000)),
          ...overrides,
        } as never);
        await setAccount(activeRound, {
          lamports: info!.lamports,
          data,
          owner: info!.owner,
          executable: false,
        });
        try {
          await operation();
        } finally {
          await setAccount(activeRound, {
            lamports: info!.lamports,
            data: info!.data,
            owner: info!.owner,
            executable: false,
          });
        }
      }

      function findRandomness(
        ticket: anchor.web3.PublicKey,
        predicate: (score: number) => boolean
      ) {
        for (let counter = 0; counter < 1_000_000; counter += 1) {
          const randomness = Buffer.alloc(32);
          randomness.writeUInt32LE(counter, 0);
          const score = countLeadingZeroBits(
            deriveTicketHash(randomness, ticket)
          );
          if (predicate(score)) return { randomness, score };
        }
        throw new Error("unable to find a Phase 4 randomness fixture");
      }

      function exactTierFixture(
        ticket: anchor.web3.PublicKey,
        tier: 0 | 1 | 2
      ) {
        const { randomness, score } = findRandomness(
          ticket,
          (candidate) => candidate >= 3 && candidate <= 253
        );
        const thresholds: [number, number, number] =
          tier === 0
            ? [score, score + 1, score + 2]
            : tier === 1
            ? [score - 1, score, score + 1]
            : [score - 2, score - 1, score];
        return { randomness, score, thresholds };
      }

      async function submitRegistration(
        user: anchor.web3.Keypair,
        overrides: Partial<ReturnType<typeof registerAccounts>> = {}
      ) {
        return submitRecorded(
          await program.methods
            .registerWinner()
            .accountsStrict(registerAccounts(user.publicKey, overrides))
            .transaction(),
          [user]
        );
      }

      function winnerTier(outcome: unknown) {
        const winner = (
          outcome as {
            winner: Record<number, Record<string, Record<string, never>>>;
          }
        ).winner;
        return Object.keys(winner[0])[0];
      }

      before(async () => {
        await provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            ...registrationUsers.map((user) =>
              anchor.web3.SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: user.publicKey,
                lamports: minimumRent,
              })
            )
          ),
          [],
          { commitment: "confirmed" }
        );
      });

      it("uses the Round snapshot, derives one Tier0 outcome, and applies quantity as a multiplier", async () => {
        const user = registrationUsers[0];
        const ticket = await putTicketFixture(user.publicKey, 5);
        const fixture = exactTierFixture(ticket, 0);
        const registeredBefore = [
          new anchor.BN(11),
          new anchor.BN(22),
          new anchor.BN(33),
        ];
        const configBefore = await program.account.lottoConfig.fetch(config);
        expect(configBefore.tierThresholds).not.to.deep.equal(
          fixture.thresholds
        );

        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
            registeredUnits: registeredBefore,
          },
          async () => {
            const before = await program.account.round.fetch(activeRound);
            const receipt = await submitRegistration(user);
            expect(
              receipt.meta!.err,
              receipt.meta!.logMessages?.join("\n")
            ).to.equal(null);

            const [roundAfter, ticketAfter] = await Promise.all([
              program.account.round.fetch(activeRound),
              program.account.ticket.fetch(ticket),
            ]);
            expect(fixture.score).to.equal(fixture.thresholds[0]);
            expect(
              roundAfter.registeredUnits.map((value) => value.toString())
            ).to.deep.equal(["16", "22", "33"]);
            expect(winnerTier(ticketAfter.outcome)).to.equal("tier0");
            expect(ticketAfter.quantity).to.equal(5);
            expect(roundAfter.status).to.deep.equal({ registering: {} });
            expect(roundAfter.prizePerUnit).to.deep.equal(before.prizePerUnit);
            expect(roundAfter.salesProceeds.eq(before.salesProceeds)).to.equal(
              true
            );
            expect(roundAfter.rolloverIn.eq(before.rolloverIn)).to.equal(true);
            expect(Array.from(roundAfter.randomness)).to.deep.equal(
              Array.from(fixture.randomness)
            );
          }
        );
      });

      for (const [tier, expectedName] of [
        [1, "tier1"],
        [2, "tier2"],
      ] as const) {
        it(`selects ${expectedName} at its exact threshold with highest-tier priority`, async () => {
          const user = registrationUsers[tier];
          const ticket = await putTicketFixture(user.publicKey, 1);
          const fixture = exactTierFixture(ticket, tier);
          await withRegistrationRound(
            {
              randomness: Array.from(fixture.randomness),
              tierThresholds: fixture.thresholds,
              registeredUnits: [
                new anchor.BN(0),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              const receipt = await submitRegistration(user);
              expect(receipt.meta!.err).to.equal(null);
              const [roundAfter, ticketAfter] = await Promise.all([
                program.account.round.fetch(activeRound),
                program.account.ticket.fetch(ticket),
              ]);
              expect(fixture.score).to.equal(fixture.thresholds[tier]);
              expect(
                roundAfter.registeredUnits.map((value) => value.toString())
              ).to.deep.equal(tier === 1 ? ["0", "1", "0"] : ["0", "0", "1"]);
              expect(winnerTier(ticketAfter.outcome)).to.equal(expectedName);
            }
          );
        });
      }

      it("treats a non-winner as transient, closes the Ticket to Treasury, and rejects replay at deserialization", async () => {
        const user = registrationUsers[3];
        const ticket = await putTicketFixture(user.publicKey, 7);
        const { randomness, score } = findRandomness(
          ticket,
          (candidate) => candidate <= 252
        );
        const thresholds: [number, number, number] = [
          score + 1,
          score + 2,
          score + 3,
        ];

        await withRegistrationRound(
          {
            randomness: Array.from(randomness),
            tierThresholds: thresholds,
            registeredUnits: [
              new anchor.BN(4),
              new anchor.BN(5),
              new anchor.BN(6),
            ],
          },
          async () => {
            const treasuryBefore = await provider.connection.getBalance(
              provider.wallet.publicKey,
              "confirmed"
            );
            const receipt = await submitRegistration(user);
            expect(receipt.meta!.err).to.equal(null);
            const treasuryAfter = await provider.connection.getBalance(
              provider.wallet.publicKey,
              "confirmed"
            );
            expect(await provider.connection.getAccountInfo(ticket)).to.equal(
              null
            );
            expect(treasuryAfter - treasuryBefore).to.equal(
              ticketRent - receipt.meta!.fee
            );
            const roundAfter = await program.account.round.fetch(activeRound);
            expect(
              roundAfter.registeredUnits.map((value) => value.toString())
            ).to.deep.equal(["4", "5", "6"]);

            const roundBeforeReplay = await snapshot([activeRound]);
            const replay = await submitRegistration(user);
            expectReceiptError(replay, "AccountNotInitialized");
            expect(await snapshot([activeRound])).to.deep.equal(
              roundBeforeReplay
            );
            expect(await provider.connection.getAccountInfo(ticket)).to.equal(
              null
            );
          }
        );
      });

      it("separates wrong lifecycle state from registration deadline equality and expiry", async () => {
        const user = registrationUsers[4];
        const ticket = await putTicketFixture(user.publicKey, 1);
        const fixture = exactTierFixture(ticket, 0);
        const watched = [activeRound, ticket];

        await withRegistrationRound(
          {
            status: { selling: {} },
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
          },
          async () => {
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(registerAccounts(user.publicKey))
                .transaction(),
              "RoundNotRegistering",
              watched,
              [user]
            );
          }
        );

        for (const offset of [0, -1]) {
          const now = await chainTimestamp();
          await withRegistrationRound(
            {
              randomness: Array.from(fixture.randomness),
              tierThresholds: fixture.thresholds,
              registrationDeadline: now.add(new anchor.BN(offset)),
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .registerWinner()
                  .accountsStrict(registerAccounts(user.publicKey))
                  .transaction(),
                "RegistrationClosed",
                watched,
                [user]
              );
            }
          );
        }
      });

      it("rejects cross-player Ticket substitution with framework constraints", async () => {
        const owner = registrationUsers[5];
        const attacker = registrationUsers[6];
        const ownerTicket = await putTicketFixture(owner.publicKey, 1);
        const fixture = exactTierFixture(ownerTicket, 0);
        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
          },
          async () => {
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(
                  registerAccounts(attacker.publicKey, {
                    ticket: ownerTicket,
                  })
                )
                .transaction(),
              "ConstraintSeeds",
              [activeRound, ownerTicket],
              [attacker]
            );
          }
        );
      });

      it("rejects cross-Round Tickets, non-program Tickets, and a wrong Treasury", async () => {
        const user = registrationUsers[7];
        const ticket = await putTicketFixture(user.publicKey, 1);
        const fixture = exactTierFixture(ticket, 0);
        const currentRoundInfo = await provider.connection.getAccountInfo(
          activeRound,
          "confirmed"
        );
        const currentRound = await program.account.round.fetch(activeRound);
        const wrongRoundId = activeRoundId.add(new anchor.BN(9_999));
        const wrongRoundPdas = roundPdas(wrongRoundId);
        const wrongRoundData = await program.coder.accounts.encode("round", {
          ...currentRound,
          roundId: wrongRoundId,
          status: { registering: {} },
          bump: wrongRoundPdas.roundBump,
        } as never);
        await setAccount(wrongRoundPdas.round, {
          lamports: currentRoundInfo!.lamports,
          data: wrongRoundData,
          owner: program.programId,
          executable: false,
        });

        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
          },
          async () => {
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(
                  registerAccounts(user.publicKey, {
                    round: wrongRoundPdas.round,
                  })
                )
                .transaction(),
              "ConstraintSeeds",
              [activeRound, wrongRoundPdas.round, ticket],
              [user]
            );
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(
                  registerAccounts(user.publicKey, {
                    ticket: substituteSystemAccount,
                  })
                )
                .transaction(),
              "AccountOwnedByWrongProgram",
              [activeRound, ticket, substituteSystemAccount],
              [user]
            );
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(
                  registerAccounts(user.publicKey, {
                    treasury: substituteSystemAccount,
                  })
                )
                .transaction(),
              "ConstraintAddress",
              [activeRound, ticket, substituteSystemAccount],
              [user]
            );
          }
        );
      });

      it("persists winner replay protection without changing the ledger twice", async () => {
        const user = registrationUsers[8];
        const ticket = await putTicketFixture(user.publicKey, 2);
        const fixture = exactTierFixture(ticket, 1);
        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
            registeredUnits: [
              new anchor.BN(0),
              new anchor.BN(0),
              new anchor.BN(0),
            ],
          },
          async () => {
            expect((await submitRegistration(user)).meta!.err).to.equal(null);
            const beforeReplay = await snapshot([activeRound, ticket]);
            const replay = await submitRegistration(user);
            expectReceiptError(replay, "TicketAlreadyRegistered");
            expect(await snapshot([activeRound, ticket])).to.deep.equal(
              beforeReplay
            );
          }
        );
      });

      it("uses ArithmeticError for registered_units overflow with full rollback", async () => {
        const user = registrationUsers[9];
        const ticket = await putTicketFixture(user.publicKey, 1);
        const fixture = exactTierFixture(ticket, 0);
        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
            registeredUnits: [
              new anchor.BN("18446744073709551615"),
              new anchor.BN(0),
              new anchor.BN(0),
            ],
          },
          async () => {
            await expectRejectedWithoutChanges(
              await program.methods
                .registerWinner()
                .accountsStrict(registerAccounts(user.publicKey))
                .transaction(),
              "ArithmeticError",
              [activeRound, ticket],
              [user]
            );
          }
        );
      });

      it("rejects a malformed nested PrizeTier during account deserialization before the handler", async () => {
        const user = registrationUsers[11];
        const { ticket, bump } = ticketPda(user.publicKey);
        const malformed = await program.coder.accounts.encode("ticket", {
          user: user.publicKey,
          roundId: activeRoundId,
          quantity: 1,
          outcome: { winner: [{ tier0: {} }] },
          bump,
        } as never);
        malformed[malformed.length - 2] = 3;
        await setAccount(ticket, {
          lamports: ticketRent,
          data: malformed,
          owner: program.programId,
          executable: false,
        });
        const roundBefore = await snapshot([activeRound]);
        const receipt = await submitRegistration(user);
        expectReceiptError(receipt, "AccountDidNotDeserialize");
        expect(await snapshot([activeRound])).to.deep.equal(roundBefore);
      });

      it("rolls back winner ledger and Ticket outcome when a later instruction fails", async () => {
        const user = registrationUsers[10];
        const ticket = await putTicketFixture(user.publicKey, 3);
        const fixture = exactTierFixture(ticket, 2);
        await withRegistrationRound(
          {
            randomness: Array.from(fixture.randomness),
            tierThresholds: fixture.thresholds,
            registeredUnits: [
              new anchor.BN(0),
              new anchor.BN(0),
              new anchor.BN(0),
            ],
          },
          async () => {
            const watched = [activeRound, ticket];
            const before = await snapshot(watched);
            const transaction = await program.methods
              .registerWinner()
              .accountsStrict(registerAccounts(user.publicKey))
              .postInstructions([
                anchor.web3.SystemProgram.transfer({
                  fromPubkey: provider.wallet.publicKey,
                  toPubkey: rolloverVault,
                  lamports: Number.MAX_SAFE_INTEGER,
                }),
              ])
              .transaction();
            const receipt = await submitRecorded(transaction, [user]);
            expect(receipt.meta!.err).not.to.equal(null);
            expect(receipt.meta!.logMessages).to.include(
              `Program ${program.programId.toBase58()} success`
            );
            expect(await snapshot(watched)).to.deep.equal(before);
          }
        );
      });
    });

    describe("Phase 5 prize finalization and claim", function () {
      type PrizeTierNumber = 0 | 1 | 2;

      const phase5Users = Array.from({ length: 8 }, () =>
        anchor.web3.Keypair.generate()
      );
      const unauthorizedFinalizer = anchor.web3.Keypair.generate();
      const u64Max = new anchor.BN("18446744073709551615");
      const i64Max = new anchor.BN("9223372036854775807");

      function finalizeAccounts(
        overrides: Partial<{
          authority: anchor.web3.PublicKey;
          config: anchor.web3.PublicKey;
          round: anchor.web3.PublicKey;
        }> = {}
      ) {
        return {
          authority: provider.wallet.publicKey,
          config,
          round: activeRound,
          ...overrides,
        };
      }

      function claimAccounts(
        user: anchor.web3.PublicKey,
        overrides: Partial<{
          user: anchor.web3.PublicKey;
          config: anchor.web3.PublicKey;
          round: anchor.web3.PublicKey;
          ticket: anchor.web3.PublicKey;
          prizeVault: anchor.web3.PublicKey;
          treasury: anchor.web3.PublicKey;
          systemProgram: anchor.web3.PublicKey;
        }> = {}
      ) {
        return {
          user,
          config,
          round: activeRound,
          ticket: ticketPda(user).ticket,
          prizeVault: activePrizeVault,
          treasury: provider.wallet.publicKey,
          systemProgram,
          ...overrides,
        };
      }

      async function putPhase5Ticket(
        user: anchor.web3.PublicKey,
        quantity: number,
        tier: PrizeTierNumber | null
      ) {
        const { ticket, bump } = ticketPda(user);
        const tierName = tier === null ? null : (`tier${tier}` as const);
        const outcome =
          tierName === null
            ? { unregistered: {} }
            : { winner: [{ [tierName]: {} }] };
        const encoded = await program.coder.accounts.encode("ticket", {
          user,
          roundId: activeRoundId,
          quantity,
          outcome,
          bump,
        } as never);
        const data = Buffer.alloc(program.account.ticket.size);
        encoded.copy(data);
        await setAccount(ticket, {
          lamports: ticketRent,
          data,
          owner: program.programId,
          executable: false,
        });
        return ticket;
      }

      async function withPhase5Round(
        overrides: Record<string, unknown>,
        operation: () => Promise<void>,
        vaultBusinessLamports = 1_000_000
      ) {
        const [roundInfo, vaultInfo, current] = await Promise.all([
          provider.connection.getAccountInfo(activeRound, "confirmed"),
          provider.connection.getAccountInfo(activePrizeVault, "confirmed"),
          program.account.round.fetch(activeRound, "confirmed"),
        ]);
        expect(roundInfo).not.to.equal(null);
        expect(vaultInfo).not.to.equal(null);
        const data = await program.coder.accounts.encode("round", {
          ...current,
          ...overrides,
        } as never);
        await setAccount(activeRound, {
          lamports: roundInfo!.lamports,
          data,
          owner: roundInfo!.owner,
          executable: false,
        });
        await setAccount(activePrizeVault, {
          lamports: minimumRent + vaultBusinessLamports,
          data: Buffer.alloc(0),
          owner: systemProgram,
          executable: false,
        });
        try {
          await operation();
        } finally {
          await setAccount(activeRound, {
            lamports: roundInfo!.lamports,
            data: roundInfo!.data,
            owner: roundInfo!.owner,
            executable: false,
          });
          await setAccount(activePrizeVault, {
            lamports: vaultInfo!.lamports,
            data: vaultInfo!.data,
            owner: vaultInfo!.owner,
            executable: vaultInfo!.executable,
          });
        }
      }

      async function submitFinalize(
        overrides: Partial<ReturnType<typeof finalizeAccounts>> = {},
        signers: anchor.web3.Keypair[] = []
      ) {
        return submitRecorded(
          await program.methods
            .finalizeRegistration()
            .accountsStrict(finalizeAccounts(overrides))
            .transaction(),
          signers
        );
      }

      async function submitClaim(
        user: anchor.web3.Keypair,
        overrides: Partial<ReturnType<typeof claimAccounts>> = {}
      ) {
        return submitRecorded(
          await program.methods
            .claimPrize()
            .accountsStrict(claimAccounts(user.publicKey, overrides))
            .transaction(),
          [user]
        );
      }

      function parsedClaimEvent(
        receipt: Awaited<ReturnType<typeof submitRecorded>>
      ) {
        const parser = new anchor.EventParser(program.programId, program.coder);
        return Array.from(
          parser.parseLogs(receipt.meta!.logMessages ?? [])
        ).find(({ name }) => name === "prizeClaimed");
      }

      function findPhase5Randomness(
        ticket: anchor.web3.PublicKey,
        predicate: (score: number) => boolean
      ) {
        for (let counter = 0; counter < 1_000_000; counter += 1) {
          const randomness = Buffer.alloc(32);
          randomness.writeUInt32LE(counter, 0);
          const score = countLeadingZeroBits(
            deriveTicketHash(randomness, ticket)
          );
          if (predicate(score)) return { randomness, score };
        }
        throw new Error("unable to find a Phase 5 randomness fixture");
      }

      before(async () => {
        await provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            ...[...phase5Users, unauthorizedFinalizer].map((user) =>
              anchor.web3.SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: user.publicKey,
                lamports: minimumRent,
              })
            )
          ),
          [],
          { commitment: "confirmed" }
        );
      });

      describe("fixture-assisted finalize_registration", function () {
        it("freezes independent floor accounting, zero-unit pools, unallocated BPS, dust, and zero payouts", async () => {
          const nowBefore = await chainTimestamp();
          const salesProceeds = new anchor.BN(1_000);
          const rolloverIn = new anchor.BN(101);
          const prizeBase = salesProceeds.add(rolloverIn);
          const tierPoolBps = [2_500, 3_333, 1_000] as [number, number, number];
          const registeredUnits = [
            new anchor.BN(3),
            new anchor.BN(0),
            new anchor.BN(200),
          ];
          const expectedPools = tierPoolBps.map((bps) =>
            prizeBase.muln(bps).divn(10_000)
          );
          const expectedPerUnit = [
            expectedPools[0].div(registeredUnits[0]),
            new anchor.BN(0),
            expectedPools[2].div(registeredUnits[2]),
          ];
          expect(expectedPools.map((value) => value.toString())).to.deep.equal([
            "275",
            "366",
            "110",
          ]);
          expect(
            expectedPerUnit.map((value) => value.toString())
          ).to.deep.equal(["91", "0", "0"]);
          expect(tierPoolBps.reduce((sum, bps) => sum + bps, 0)).to.be.lessThan(
            10_000
          );

          await withPhase5Round(
            {
              status: { registering: {} },
              registrationDeadline: nowBefore.subn(1),
              claimDurationSecs: new anchor.BN(37),
              salesProceeds,
              rolloverIn,
              tierPoolBps,
              registeredUnits,
              prizePerUnit: [
                new anchor.BN(9),
                new anchor.BN(9),
                new anchor.BN(9),
              ],
            },
            async () => {
              const before = await program.account.round.fetch(activeRound);
              const receipt = await submitFinalize();
              expect(
                receipt.meta!.err,
                receipt.meta!.logMessages?.join("\n")
              ).to.equal(null);
              const afterTime = await chainTimestamp();
              const after = await program.account.round.fetch(activeRound);
              expect(after.status).to.deep.equal({ claiming: {} });
              expect(
                after.prizePerUnit.map((value) => value.toString())
              ).to.deep.equal(expectedPerUnit.map((value) => value.toString()));
              const finalizedAt = after.claimDeadline.sub(
                after.claimDurationSecs
              );
              expect(
                finalizedAt.gte(nowBefore) && finalizedAt.lte(afterTime)
              ).to.equal(true);
              expect(after.salesProceeds.eq(before.salesProceeds)).to.equal(
                true
              );
              expect(after.rolloverIn.eq(before.rolloverIn)).to.equal(true);
              expect(after.tierPoolBps).to.deep.equal(before.tierPoolBps);
              expect(
                after.registeredUnits.map((value) => value.toString())
              ).to.deep.equal(
                before.registeredUnits.map((value) => value.toString())
              );
            }
          );
        });

        it("accepts the exact registration deadline and rejects repeat finalization", async () => {
          const deadline = await chainTimestamp();
          await withPhase5Round(
            {
              status: { registering: {} },
              registrationDeadline: deadline,
              claimDurationSecs: new anchor.BN(100),
              salesProceeds: new anchor.BN(100),
              rolloverIn: new anchor.BN(0),
              tierPoolBps: [10_000, 0, 0],
              registeredUnits: [
                new anchor.BN(1),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              expect((await submitFinalize()).meta!.err).to.equal(null);
              const frozen = await snapshot([activeRound]);
              const replay = await submitFinalize();
              expectReceiptError(replay, "RoundNotRegistering");
              expect(await snapshot([activeRound])).to.deep.equal(frozen);
            }
          );
        });

        it("rejects too-early, wrong-lifecycle, and unauthorized finalization without mutation", async () => {
          const now = await chainTimestamp();
          for (const [overrides, code] of [
            [
              {
                status: { registering: {} },
                registrationDeadline: now.addn(1_000),
              },
              "RegistrationStillOpen",
            ],
            [
              {
                status: { randomnessPending: {} },
                registrationDeadline: now.subn(1),
              },
              "RoundNotRegistering",
            ],
          ] as const) {
            await withPhase5Round(overrides, async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .finalizeRegistration()
                  .accountsStrict(finalizeAccounts())
                  .transaction(),
                code,
                [activeRound]
              );
            });
          }

          await withPhase5Round(
            {
              status: { registering: {} },
              registrationDeadline: now.subn(1),
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .finalizeRegistration()
                  .accountsStrict(
                    finalizeAccounts({
                      authority: unauthorizedFinalizer.publicKey,
                    })
                  )
                  .transaction(),
                "ConstraintHasOne",
                [activeRound],
                [unauthorizedFinalizer]
              );
            }
          );
        });

        it("rejects an inactive canonical Round with ConstraintRaw", async () => {
          const current = await program.account.round.fetch(activeRound);
          const currentInfo = await provider.connection.getAccountInfo(
            activeRound,
            "confirmed"
          );
          const wrongRoundId = activeRoundId.add(new anchor.BN(50_000));
          const wrong = roundPdas(wrongRoundId);
          const wrongData = await program.coder.accounts.encode("round", {
            ...current,
            roundId: wrongRoundId,
            status: { registering: {} },
            registrationDeadline: (await chainTimestamp()).subn(1),
            bump: wrong.roundBump,
          } as never);
          await setAccount(wrong.round, {
            lamports: currentInfo!.lamports,
            data: wrongData,
            owner: program.programId,
            executable: false,
          });
          await expectRejectedWithoutChanges(
            await program.methods
              .finalizeRegistration()
              .accountsStrict(finalizeAccounts({ round: wrong.round }))
              .transaction(),
            "ConstraintRaw",
            [activeRound, wrong.round]
          );
        });

        for (const [label, overrides] of [
          [
            "prize_base addition",
            {
              salesProceeds: u64Max,
              rolloverIn: new anchor.BN(1),
              tierPoolBps: [0, 0, 0],
            },
          ],
          [
            "tier pool multiplication",
            {
              salesProceeds: u64Max,
              rolloverIn: new anchor.BN(0),
              tierPoolBps: [2, 0, 0],
            },
          ],
          [
            "claim deadline",
            {
              salesProceeds: new anchor.BN(0),
              rolloverIn: new anchor.BN(0),
              tierPoolBps: [0, 0, 0],
              claimDurationSecs: i64Max,
            },
          ],
        ] as const) {
          it(`uses ArithmeticError and rolls back ${label} overflow`, async () => {
            const now = await chainTimestamp();
            await withPhase5Round(
              {
                status: { registering: {} },
                registrationDeadline: now.subn(1),
                registeredUnits: [
                  new anchor.BN(1),
                  new anchor.BN(1),
                  new anchor.BN(1),
                ],
                prizePerUnit: [
                  new anchor.BN(7),
                  new anchor.BN(8),
                  new anchor.BN(9),
                ],
                ...overrides,
              },
              async () => {
                await expectRejectedWithoutChanges(
                  await program.methods
                    .finalizeRegistration()
                    .accountsStrict(finalizeAccounts())
                    .transaction(),
                  "ArithmeticError",
                  [activeRound]
                );
              }
            );
          });
        }

        it("rolls back successful finalization when a later instruction fails", async () => {
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { registering: {} },
              registrationDeadline: now.subn(1),
              salesProceeds: new anchor.BN(100),
              rolloverIn: new anchor.BN(0),
              tierPoolBps: [10_000, 0, 0],
              registeredUnits: [
                new anchor.BN(2),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              const before = await snapshot([activeRound]);
              const transaction = await program.methods
                .finalizeRegistration()
                .accountsStrict(finalizeAccounts())
                .postInstructions([
                  anchor.web3.SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: rolloverVault,
                    lamports: Number.MAX_SAFE_INTEGER,
                  }),
                ])
                .transaction();
              const receipt = await submitRecorded(transaction);
              expect(receipt.meta!.err).not.to.equal(null);
              expect(receipt.meta!.logMessages).to.include(
                `Program ${program.programId.toBase58()} success`
              );
              expect(await snapshot([activeRound])).to.deep.equal(before);
            }
          );
        });
      });

      describe("fixture-assisted claim_prize", function () {
        for (const [tier, quantity, perUnit] of [
          [0, 2, 11],
          [1, 3, 13],
          [2, 4, 17],
        ] as const) {
          it(`claims a Tier${tier} Winner with exact quantity-multiplied payout, close, and event`, async () => {
            const user = phase5Users[tier];
            const ticket = await putPhase5Ticket(
              user.publicKey,
              quantity,
              tier
            );
            const now = await chainTimestamp();
            const prizePerUnit = [
              new anchor.BN(11),
              new anchor.BN(13),
              new anchor.BN(17),
            ];
            const expectedAmount = perUnit * quantity;
            await withPhase5Round(
              {
                status: { claiming: {} },
                claimDeadline: now.addn(1_000),
                prizePerUnit,
              },
              async () => {
                const [userBefore, vaultBefore, treasuryBefore, roundBefore] =
                  await Promise.all([
                    provider.connection.getBalance(user.publicKey),
                    provider.connection.getBalance(activePrizeVault),
                    provider.connection.getBalance(provider.wallet.publicKey),
                    snapshot([activeRound]),
                  ]);
                const receipt = await submitClaim(user);
                expect(
                  receipt.meta!.err,
                  receipt.meta!.logMessages?.join("\n")
                ).to.equal(null);
                const [userAfter, vaultAfter, treasuryAfter, ticketAfter] =
                  await Promise.all([
                    provider.connection.getBalance(user.publicKey),
                    provider.connection.getBalance(activePrizeVault),
                    provider.connection.getBalance(provider.wallet.publicKey),
                    provider.connection.getAccountInfo(ticket),
                  ]);
                expect(userAfter - userBefore).to.equal(expectedAmount);
                expect(vaultBefore - vaultAfter).to.equal(expectedAmount);
                expect(vaultAfter).to.be.at.least(minimumRent);
                expect(treasuryAfter - treasuryBefore).to.equal(
                  ticketRent - receipt.meta!.fee
                );
                expect(ticketAfter).to.equal(null);
                expect(await snapshot([activeRound])).to.deep.equal(
                  roundBefore
                );

                const event = parsedClaimEvent(receipt);
                expect(event).not.to.equal(undefined);
                const data = event!.data as {
                  roundId: anchor.BN;
                  user: anchor.web3.PublicKey;
                  tier: Record<string, Record<string, never>>;
                  quantity: number;
                  amount: anchor.BN;
                };
                expect(data.roundId.eq(activeRoundId)).to.equal(true);
                expect(data.user.equals(user.publicKey)).to.equal(true);
                expect(Object.keys(data.tier)).to.deep.equal([`tier${tier}`]);
                expect(data.quantity).to.equal(quantity);
                expect(data.amount.eq(new anchor.BN(expectedAmount))).to.equal(
                  true
                );
              }
            );
          });
        }

        it("successfully consumes and emits a zero-amount Winner claim", async () => {
          const user = phase5Users[3];
          const ticket = await putPhase5Ticket(user.publicKey, 7, 1);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(10),
                new anchor.BN(0),
                new anchor.BN(20),
              ],
            },
            async () => {
              const vaultBefore = await provider.connection.getBalance(
                activePrizeVault
              );
              const receipt = await submitClaim(user);
              expect(receipt.meta!.err).to.equal(null);
              expect(
                await provider.connection.getBalance(activePrizeVault)
              ).to.equal(vaultBefore);
              expect(await provider.connection.getAccountInfo(ticket)).to.equal(
                null
              );
              const event = parsedClaimEvent(receipt)!;
              expect(
                (event.data as { amount: anchor.BN }).amount.isZero()
              ).to.equal(true);
            }
          );
        });

        it("rejects an Unregistered Ticket with TicketNotWinner and no partial effect", async () => {
          const user = phase5Users[4];
          const ticket = await putPhase5Ticket(user.publicKey, 2, null);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(50),
                new anchor.BN(60),
                new anchor.BN(70),
              ],
            },
            async () => {
              const watched = [activeRound, activePrizeVault, ticket];
              const before = await snapshot(watched);
              const [userBefore, treasuryBefore] = await Promise.all([
                provider.connection.getBalance(user.publicKey),
                provider.connection.getBalance(provider.wallet.publicKey),
              ]);
              const receipt = await submitClaim(user);
              expectReceiptError(receipt, "TicketNotWinner");
              expect(await snapshot(watched)).to.deep.equal(before);
              expect(
                await provider.connection.getBalance(user.publicKey)
              ).to.equal(userBefore);
              expect(
                (await provider.connection.getBalance(
                  provider.wallet.publicKey
                )) - treasuryBefore
              ).to.equal(-receipt.meta!.fee);
            }
          );
        });

        it("prevents double claim by consuming the canonical Ticket", async () => {
          const user = phase5Users[5];
          const ticket = await putPhase5Ticket(user.publicKey, 1, 0);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(99),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              expect((await submitClaim(user)).meta!.err).to.equal(null);
              expect(await provider.connection.getAccountInfo(ticket)).to.equal(
                null
              );
              const beforeReplay = await snapshot([
                activeRound,
                activePrizeVault,
                user.publicKey,
              ]);
              const replay = await submitClaim(user);
              expectReceiptError(replay, "AccountNotInitialized");
              expect(
                await snapshot([activeRound, activePrizeVault, user.publicKey])
              ).to.deep.equal(beforeReplay);
            }
          );
        });

        it("separates wrong lifecycle from exact and expired claim deadlines", async () => {
          const user = phase5Users[6];
          const ticket = await putPhase5Ticket(user.publicKey, 1, 0);
          const now = await chainTimestamp();
          for (const [overrides, code] of [
            [
              { status: { registering: {} }, claimDeadline: now.addn(1_000) },
              "RoundNotClaiming",
            ],
            [{ status: { claiming: {} }, claimDeadline: now }, "ClaimClosed"],
            [
              { status: { claiming: {} }, claimDeadline: now.subn(1) },
              "ClaimClosed",
            ],
          ] as const) {
            await withPhase5Round(overrides, async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(claimAccounts(user.publicKey))
                  .transaction(),
                code,
                [activeRound, activePrizeVault, ticket],
                [user]
              );
            });
          }
        });

        it("rejects wrong Player, inactive Round, Prize Vault, and Treasury structurally", async () => {
          const owner = phase5Users[0];
          const attacker = phase5Users[1];
          const ownerTicket = await putPhase5Ticket(owner.publicKey, 1, 0);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(10),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(
                    claimAccounts(attacker.publicKey, { ticket: ownerTicket })
                  )
                  .transaction(),
                "ConstraintSeeds",
                [activeRound, activePrizeVault, ownerTicket],
                [attacker]
              );

              const current = await program.account.round.fetch(activeRound);
              const currentInfo = await provider.connection.getAccountInfo(
                activeRound,
                "confirmed"
              );
              const wrongRoundId = activeRoundId.add(new anchor.BN(60_000));
              const wrong = roundPdas(wrongRoundId);
              const wrongData = await program.coder.accounts.encode("round", {
                ...current,
                roundId: wrongRoundId,
                status: { claiming: {} },
                claimDeadline: now.addn(1_000),
                bump: wrong.roundBump,
              } as never);
              await setAccount(wrong.round, {
                lamports: currentInfo!.lamports,
                data: wrongData,
                owner: program.programId,
                executable: false,
              });
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(
                    claimAccounts(owner.publicKey, { round: wrong.round })
                  )
                  .transaction(),
                "ConstraintRaw",
                [activeRound, wrong.round, activePrizeVault, ownerTicket],
                [owner]
              );
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(
                    claimAccounts(owner.publicKey, {
                      prizeVault: substituteSystemAccount,
                    })
                  )
                  .transaction(),
                "ConstraintSeeds",
                [activeRound, activePrizeVault, ownerTicket],
                [owner]
              );
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(
                    claimAccounts(owner.publicKey, {
                      treasury: substituteSystemAccount,
                    })
                  )
                  .transaction(),
                "ConstraintAddress",
                [activeRound, activePrizeVault, ownerTicket],
                [owner]
              );
            }
          );
        });

        it("uses ArithmeticError for payout multiplication overflow with full rollback", async () => {
          const user = phase5Users[2];
          const ticket = await putPhase5Ticket(user.publicKey, 2, 0);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [u64Max, new anchor.BN(0), new anchor.BN(0)],
            },
            async () => {
              await expectRejectedWithoutChanges(
                await program.methods
                  .claimPrize()
                  .accountsStrict(claimAccounts(user.publicKey))
                  .transaction(),
                "ArithmeticError",
                [activeRound, activePrizeVault, ticket, user.publicKey],
                [user]
              );
            }
          );
        });

        it("rolls back Ticket close and balances when an underfunded Vault transfer fails", async () => {
          const user = phase5Users[3];
          const ticket = await putPhase5Ticket(user.publicKey, 1, 0);
          const now = await chainTimestamp();
          const impossiblePayout = minimumRent + 100;
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(impossiblePayout),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              const before = await snapshot([
                activeRound,
                activePrizeVault,
                ticket,
                user.publicKey,
              ]);
              const receipt = await submitClaim(user);
              expect(receipt.meta!.err).not.to.equal(null);
              expect(
                (receipt.meta!.logMessages ?? []).some((line) =>
                  line.includes("Transfer: insufficient lamports")
                )
              ).to.equal(true);
              expect(
                await snapshot([
                  activeRound,
                  activePrizeVault,
                  ticket,
                  user.publicKey,
                ])
              ).to.deep.equal(before);
            },
            50
          );
        });

        it("rolls back payout, event transaction, and Ticket close when a later instruction fails", async () => {
          const user = phase5Users[4];
          const ticket = await putPhase5Ticket(user.publicKey, 3, 0);
          const now = await chainTimestamp();
          await withPhase5Round(
            {
              status: { claiming: {} },
              claimDeadline: now.addn(1_000),
              prizePerUnit: [
                new anchor.BN(12),
                new anchor.BN(0),
                new anchor.BN(0),
              ],
            },
            async () => {
              const watched = [
                activeRound,
                activePrizeVault,
                ticket,
                user.publicKey,
              ];
              const before = await snapshot(watched);
              const transaction = await program.methods
                .claimPrize()
                .accountsStrict(claimAccounts(user.publicKey))
                .postInstructions([
                  anchor.web3.SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: rolloverVault,
                    lamports: Number.MAX_SAFE_INTEGER,
                  }),
                ])
                .transaction();
              const receipt = await submitRecorded(transaction, [user]);
              expect(receipt.meta!.err).not.to.equal(null);
              expect(receipt.meta!.logMessages).to.include(
                `Program ${program.programId.toBase58()} success`
              );
              expect(await snapshot(watched)).to.deep.equal(before);
            }
          );
        });
      });

      it("runs a fixture-assisted Registering -> Winner -> Claiming -> paid claim transaction flow", async () => {
        const user = phase5Users[7];
        const quantity = 3;
        const ticket = await putPhase5Ticket(user.publicKey, quantity, null);
        const { randomness, score } = findPhase5Randomness(
          ticket,
          (candidate) => candidate >= 1 && candidate <= 253
        );
        const thresholds: [number, number, number] = [
          score,
          score + 1,
          score + 2,
        ];
        const registrationDeadline = (await chainTimestamp()).addn(100);
        const prizeBase = 120;

        await withPhase5Round(
          {
            status: { registering: {} },
            randomness: Array.from(randomness),
            tierThresholds: thresholds,
            registrationDeadline,
            claimDurationSecs: new anchor.BN(1_000),
            registeredUnits: [
              new anchor.BN(0),
              new anchor.BN(0),
              new anchor.BN(0),
            ],
            prizePerUnit: [
              new anchor.BN(0),
              new anchor.BN(0),
              new anchor.BN(0),
            ],
            tierPoolBps: [10_000, 0, 0],
            salesProceeds: new anchor.BN(prizeBase),
            rolloverIn: new anchor.BN(0),
          },
          async () => {
            const registration = await submitRecorded(
              await program.methods
                .registerWinner()
                .accountsStrict({
                  user: user.publicKey,
                  round: activeRound,
                  ticket,
                  config,
                  treasury: provider.wallet.publicKey,
                })
                .transaction(),
              [user]
            );
            expect(registration.meta!.err).to.equal(null);
            const registeredTicket = await program.account.ticket.fetch(ticket);
            const registeredWinner = (
              registeredTicket.outcome as unknown as {
                winner: Record<number, Record<string, Record<string, never>>>;
              }
            ).winner;
            expect(Object.keys(registeredWinner[0])).to.deep.equal(["tier0"]);

            await setChainTime(registrationDeadline);
            const finalization = await submitFinalize();
            expect(finalization.meta!.err).to.equal(null);
            const finalized = await program.account.round.fetch(activeRound);
            expect(finalized.status).to.deep.equal({ claiming: {} });
            expect(
              finalized.registeredUnits.map((value) => value.toString())
            ).to.deep.equal([String(quantity), "0", "0"]);
            expect(
              finalized.prizePerUnit.map((value) => value.toString())
            ).to.deep.equal([String(prizeBase / quantity), "0", "0"]);

            const userBefore = await provider.connection.getBalance(
              user.publicKey
            );
            const claim = await submitClaim(user);
            expect(claim.meta!.err).to.equal(null);
            expect(
              (await provider.connection.getBalance(user.publicKey)) -
                userBefore
            ).to.equal(prizeBase);
            expect(await provider.connection.getAccountInfo(ticket)).to.equal(
              null
            );
          },
          prizeBase
        );
      });
    });

    describe("Phase 6 round finalization and stale Ticket cleanup", function () {
      const finalizeRoundInIdl = rawIdl.instructions.some(
        ({ name }) => name === "finalize_round"
      );
      const cleanupInstruction = rawIdl.instructions.find(
        ({ name }) => name === "cleanup_expired_ticket"
      );
      const cleanupHasCanonicalTicketSeeds =
        cleanupInstruction?.accounts
          .find(({ name }) => name === "ticket")
          ?.pda?.seeds?.map(({ path }) => path)
          .join("|") === "|ticket.round_id|user";

      function phase6Builder(
        name: "finalizeRound" | "cleanupExpiredTicket"
      ): Phase6TransactionBuilder {
        const method = (
          program.methods as unknown as Record<
            string,
            (() => Phase6TransactionBuilder) | undefined
          >
        )[name];
        if (method === undefined) {
          throw new Error(`${name} is absent from the generated IDL`);
        }
        return method();
      }

      async function restoreAccount(
        address: anchor.web3.PublicKey,
        account: anchor.web3.AccountInfo<Buffer> | null
      ) {
        await setAccount(
          address,
          account === null
            ? {
                lamports: 0,
                data: Buffer.alloc(0),
                owner: systemProgram,
                executable: false,
              }
            : {
                lamports: account.lamports,
                data: account.data,
                owner: account.owner,
                executable: account.executable,
              }
        );
      }

      async function expectAnyRejectedWithoutChanges(
        transaction: anchor.web3.Transaction,
        addresses: anchor.web3.PublicKey[],
        signers: anchor.web3.Keypair[] = []
      ) {
        const before = await snapshot(addresses);
        const receipt = await submitRecorded(transaction, signers);
        expect(receipt.meta!.err).not.to.equal(null);
        expect(await snapshot(addresses)).to.deep.equal(before);
        return receipt;
      }

      (finalizeRoundInIdl ? describe : describe.skip)(
        "fixture-assisted finalize_round transactions",
        function () {
          const unauthorizedFinalizer = anchor.web3.Keypair.generate();

          function finalizeRoundAccounts(
            overrides: Partial<{
              authority: anchor.web3.PublicKey;
              config: anchor.web3.PublicKey;
              round: anchor.web3.PublicKey;
              prizeVault: anchor.web3.PublicKey;
              rolloverVault: anchor.web3.PublicKey;
              treasury: anchor.web3.PublicKey;
              systemProgram: anchor.web3.PublicKey;
            }> = {}
          ) {
            return {
              authority: provider.wallet.publicKey,
              config,
              round: activeRound,
              prizeVault: activePrizeVault,
              rolloverVault,
              treasury: provider.wallet.publicKey,
              systemProgram,
              ...overrides,
            };
          }

          async function submitFinalizeRound(
            overrides: Partial<ReturnType<typeof finalizeRoundAccounts>> = {},
            signers: anchor.web3.Keypair[] = [],
            postInstructions: anchor.web3.TransactionInstruction[] = []
          ) {
            return submitRecorded(
              await phase6Builder("finalizeRound")
                .accountsStrict(finalizeRoundAccounts(overrides))
                .postInstructions(postInstructions)
                .transaction(),
              signers
            );
          }

          async function expectFinalizeRejected(
            transaction: anchor.web3.Transaction,
            code: string,
            addresses: anchor.web3.PublicKey[],
            signers: anchor.web3.Keypair[] = []
          ) {
            const treasuryBefore = await provider.connection.getBalance(
              provider.wallet.publicKey,
              "confirmed"
            );
            const receipt = await expectRejectedWithoutChanges(
              transaction,
              code,
              addresses,
              signers
            );
            expect(
              (await provider.connection.getBalance(
                provider.wallet.publicKey,
                "confirmed"
              )) - treasuryBefore
            ).to.equal(-receipt.meta!.fee);
            return receipt;
          }

          async function withFinalizableRound(
            overrides: Record<string, unknown>,
            vaultLamports: number,
            operation: () => Promise<void>
          ) {
            const [configInfo, roundInfo, vaultInfo, rolloverInfo, current] =
              await Promise.all([
                provider.connection.getAccountInfo(config, "confirmed"),
                provider.connection.getAccountInfo(activeRound, "confirmed"),
                provider.connection.getAccountInfo(
                  activePrizeVault,
                  "confirmed"
                ),
                provider.connection.getAccountInfo(rolloverVault, "confirmed"),
                program.account.round.fetch(activeRound, "confirmed"),
              ]);
            expect(configInfo).not.to.equal(null);
            expect(roundInfo).not.to.equal(null);
            expect(vaultInfo).not.to.equal(null);
            expect(rolloverInfo).not.to.equal(null);
            const data = await program.coder.accounts.encode("round", {
              ...current,
              ...overrides,
            } as never);
            await setAccount(activeRound, {
              lamports: roundInfo!.lamports,
              data,
              owner: program.programId,
              executable: false,
            });
            await setAccount(activePrizeVault, {
              lamports: vaultLamports,
              data: Buffer.alloc(0),
              owner: systemProgram,
              executable: false,
            });
            try {
              await operation();
            } finally {
              await restoreAccount(config, configInfo);
              await restoreAccount(activeRound, roundInfo);
              await restoreAccount(activePrizeVault, vaultInfo);
              await restoreAccount(rolloverVault, rolloverInfo);
            }
          }

          function parsedFinalizeEvent(
            receipt: Awaited<ReturnType<typeof submitRecorded>>
          ) {
            const parser = new anchor.EventParser(
              program.programId,
              program.coder
            );
            return Array.from(
              parser.parseLogs(receipt.meta!.logMessages ?? [])
            ).find(({ name }) => name === "roundFinalized");
          }

          before(async () => {
            await provider.sendAndConfirm(
              new anchor.web3.Transaction().add(
                anchor.web3.SystemProgram.transfer({
                  fromPubkey: provider.wallet.publicKey,
                  toPubkey: unauthorizedFinalizer.publicKey,
                  lamports: 1_000_000,
                })
              )
            );
          });

          for (const [label, businessLamports] of [
            ["rent-only Prize Vault", 0],
            ["normal remaining business SOL", 10_000],
            ["floor dust", 1],
            ["unallocated BPS", 137],
            ["zero-winner tier pool", 251],
            ["expired unclaimed winner money", 509],
            ["large remaining balance", 5_000_000],
          ] as const) {
            it(`finalizes ${label} using actual Vault cash and exact rent split`, async () => {
              const now = await chainTimestamp();
              await withFinalizableRound(
                {
                  status: { claiming: {} },
                  claimDeadline: now.subn(1),
                },
                minimumRent + businessLamports,
                async () => {
                  const roundInfo = await provider.connection.getAccountInfo(
                    activeRound,
                    "confirmed"
                  );
                  expect(roundInfo).not.to.equal(null);
                  const [rolloverBefore, treasuryBefore] = await Promise.all([
                    provider.connection.getBalance(rolloverVault, "confirmed"),
                    provider.connection.getBalance(
                      provider.wallet.publicKey,
                      "confirmed"
                    ),
                  ]);
                  const receipt = await submitFinalizeRound();
                  expect(
                    receipt.meta!.err,
                    receipt.meta!.logMessages?.join("\n")
                  ).to.equal(null);
                  const [configAfter, rolloverAfter, treasuryAfter] =
                    await Promise.all([
                      program.account.lottoConfig.fetch(config, "confirmed"),
                      provider.connection.getBalance(
                        rolloverVault,
                        "confirmed"
                      ),
                      provider.connection.getBalance(
                        provider.wallet.publicKey,
                        "confirmed"
                      ),
                    ]);
                  expect(configAfter.activeRoundId).to.equal(null);
                  expect(
                    await provider.connection.getBalance(
                      activeRound,
                      "confirmed"
                    )
                  ).to.equal(0);
                  expect(
                    await provider.connection.getBalance(
                      activePrizeVault,
                      "confirmed"
                    )
                  ).to.equal(0);
                  expect(rolloverAfter - rolloverBefore).to.equal(
                    businessLamports
                  );
                  expect(treasuryAfter - treasuryBefore).to.equal(
                    minimumRent + roundInfo!.lamports - receipt.meta!.fee
                  );
                  const event = parsedFinalizeEvent(receipt);
                  expect(event).not.to.equal(undefined);
                  const data = event!.data as {
                    roundId: anchor.BN;
                    rolloverOut: anchor.BN;
                  };
                  expect(data.roundId.eq(activeRoundId)).to.equal(true);
                  expect(data.rolloverOut.toNumber()).to.equal(
                    businessLamports
                  );
                }
              );
            });
          }

          it("accepts the exact claim deadline", async () => {
            const deadline = (await chainTimestamp()).addn(10);
            await withFinalizableRound(
              { status: { claiming: {} }, claimDeadline: deadline },
              minimumRent,
              async () => {
                await setChainTime(deadline);
                const receipt = await submitFinalizeRound();
                expect(
                  receipt.meta!.err,
                  receipt.meta!.logMessages?.join("\n")
                ).to.equal(null);
              }
            );
          });

          it("rejects before the claim deadline with ClaimStillOpen and full rollback", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.addn(1_000),
              },
              minimumRent + 123,
              async () => {
                await expectFinalizeRejected(
                  await phase6Builder("finalizeRound")
                    .accountsStrict(finalizeRoundAccounts())
                    .transaction(),
                  "ClaimStillOpen",
                  [config, activeRound, activePrizeVault, rolloverVault]
                );
              }
            );
          });

          it("rejects a non-Claiming Round with RoundNotClaiming", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { registering: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 123,
              async () => {
                await expectFinalizeRejected(
                  await phase6Builder("finalizeRound")
                    .accountsStrict(finalizeRoundAccounts())
                    .transaction(),
                  "RoundNotClaiming",
                  [config, activeRound, activePrizeVault, rolloverVault]
                );
              }
            );
          });

          it("rejects a non-Config authority with ConstraintHasOne", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 123,
              async () => {
                await expectFinalizeRejected(
                  await phase6Builder("finalizeRound")
                    .accountsStrict(
                      finalizeRoundAccounts({
                        authority: unauthorizedFinalizer.publicKey,
                      })
                    )
                    .transaction(),
                  "ConstraintHasOne",
                  [config, activeRound, activePrizeVault, rolloverVault],
                  [unauthorizedFinalizer]
                );
              }
            );
          });

          it("rejects an inactive canonical Round with ConstraintRaw", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 123,
              async () => {
                const configInfo = await provider.connection.getAccountInfo(
                  config,
                  "confirmed"
                );
                const current = await program.account.lottoConfig.fetch(
                  config,
                  "confirmed"
                );
                expect(configInfo).not.to.equal(null);
                const data = await program.coder.accounts.encode(
                  "lottoConfig",
                  {
                    ...current,
                    activeRoundId: activeRoundId.addn(1),
                  } as never
                );
                await setAccount(config, {
                  lamports: configInfo!.lamports,
                  data,
                  owner: program.programId,
                  executable: false,
                });
                await expectFinalizeRejected(
                  await phase6Builder("finalizeRound")
                    .accountsStrict(finalizeRoundAccounts())
                    .transaction(),
                  "ConstraintRaw",
                  [config, activeRound, activePrizeVault, rolloverVault]
                );
              }
            );
          });

          for (const [label, overrides, code] of [
            [
              "Prize Vault",
              { prizeVault: substituteSystemAccount },
              "ConstraintSeeds",
            ],
            [
              "Rollover Vault",
              { rolloverVault: substituteSystemAccount },
              "ConstraintSeeds",
            ],
            [
              "Treasury",
              { treasury: substituteSystemAccount },
              "ConstraintAddress",
            ],
          ] as const) {
            it(`rejects a wrong ${label} without partial finalization`, async () => {
              const now = await chainTimestamp();
              await withFinalizableRound(
                {
                  status: { claiming: {} },
                  claimDeadline: now.subn(1),
                },
                minimumRent + 123,
                async () => {
                  await expectFinalizeRejected(
                    await phase6Builder("finalizeRound")
                      .accountsStrict(
                        finalizeRoundAccounts(
                          overrides as Partial<
                            ReturnType<typeof finalizeRoundAccounts>
                          >
                        )
                      )
                      .transaction(),
                    code,
                    [config, activeRound, activePrizeVault, rolloverVault]
                  );
                }
              );
            });
          }

          it("rejects an under-rent Prize Vault with ArithmeticError and rollback", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent - 1,
              async () => {
                await expectFinalizeRejected(
                  await phase6Builder("finalizeRound")
                    .accountsStrict(finalizeRoundAccounts())
                    .transaction(),
                  "ArithmeticError",
                  [config, activeRound, activePrizeVault, rolloverVault]
                );
              }
            );
          });

          it("rolls back the complete finalization when a later instruction fails", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 123,
              async () => {
                const watched = [
                  config,
                  activeRound,
                  activePrizeVault,
                  rolloverVault,
                ];
                const before = await snapshot(watched);
                const treasuryBefore = await provider.connection.getBalance(
                  provider.wallet.publicKey,
                  "confirmed"
                );
                const receipt = await submitFinalizeRound(
                  {},
                  [],
                  [
                    anchor.web3.SystemProgram.transfer({
                      fromPubkey: provider.wallet.publicKey,
                      toPubkey: substituteSystemAccount,
                      lamports: Number.MAX_SAFE_INTEGER,
                    }),
                  ]
                );
                expect(receipt.meta!.err).not.to.equal(null);
                expect(receipt.meta!.logMessages).to.include(
                  `Program ${program.programId.toBase58()} success`
                );
                expect(await snapshot(watched)).to.deep.equal(before);
                expect(
                  (await provider.connection.getBalance(
                    provider.wallet.publicKey,
                    "confirmed"
                  )) - treasuryBefore
                ).to.equal(-receipt.meta!.fee);
              }
            );
          });

          it("cannot finalize the same closed Round twice", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 123,
              async () => {
                const first = await submitFinalizeRound();
                expect(first.meta!.err).to.equal(null);
                const rolloverAfterFirst = await provider.connection.getBalance(
                  rolloverVault,
                  "confirmed"
                );
                const second = await submitFinalizeRound();
                expectReceiptError(second, "AccountNotInitialized");
                expect(
                  await provider.connection.getBalance(
                    rolloverVault,
                    "confirmed"
                  )
                ).to.equal(rolloverAfterFirst);
              }
            );
          });

          it("integrates with existing create_round after clearing the active pointer", async () => {
            const now = await chainTimestamp();
            await withFinalizableRound(
              {
                status: { claiming: {} },
                claimDeadline: now.subn(1),
              },
              minimumRent + 777,
              async () => {
                const before = await program.account.lottoConfig.fetch(config);
                const next = roundPdas(before.nextRoundId);
                const [nextRoundInfo, nextVaultInfo] = await Promise.all([
                  provider.connection.getAccountInfo(next.round, "confirmed"),
                  provider.connection.getAccountInfo(
                    next.prizeVault,
                    "confirmed"
                  ),
                ]);
                try {
                  const finalization = await submitFinalizeRound();
                  expect(finalization.meta!.err).to.equal(null);
                  const creation = await submitRecorded(
                    await program.methods
                      .createRound()
                      .accountsStrict(createAccounts(before.nextRoundId))
                      .transaction()
                  );
                  expect(
                    creation.meta!.err,
                    creation.meta!.logMessages?.join("\n")
                  ).to.equal(null);
                  const after = await program.account.lottoConfig.fetch(config);
                  expect(after.activeRoundId!.eq(before.nextRoundId)).to.equal(
                    true
                  );
                  expect(
                    await provider.connection.getBalance(rolloverVault)
                  ).to.equal(minimumRent);
                  expect(
                    await provider.connection.getBalance(next.prizeVault)
                  ).to.equal(minimumRent + 777);
                } finally {
                  await restoreAccount(next.round, nextRoundInfo);
                  await restoreAccount(next.prizeVault, nextVaultInfo);
                }
              }
            );
          });
        }
      );

      (cleanupHasCanonicalTicketSeeds ? describe : describe.skip)(
        "fixture-assisted cleanup_expired_ticket transactions",
        function () {
          type CleanupOutcome = "unregistered" | "winner";
          const cleanupUsers = Array.from({ length: 22 }, () =>
            anchor.web3.Keypair.generate()
          );

          function cleanupAccounts(
            user: anchor.web3.PublicKey,
            overrides: Partial<{
              user: anchor.web3.PublicKey;
              ticket: anchor.web3.PublicKey;
              round: anchor.web3.PublicKey;
            }> = {}
          ) {
            return {
              user,
              ticket: ticketPda(user).ticket,
              round: activeRound,
              ...overrides,
            };
          }

          async function submitCleanup(
            user: anchor.web3.Keypair,
            overrides: Partial<ReturnType<typeof cleanupAccounts>> = {},
            postInstructions: anchor.web3.TransactionInstruction[] = []
          ) {
            return submitRecorded(
              await phase6Builder("cleanupExpiredTicket")
                .accountsStrict(cleanupAccounts(user.publicKey, overrides))
                .postInstructions(postInstructions)
                .transaction(),
              [user]
            );
          }

          async function putCleanupTicket(
            user: anchor.web3.PublicKey,
            outcome: CleanupOutcome
          ) {
            const { ticket, bump } = ticketPda(user);
            const encoded = await program.coder.accounts.encode("ticket", {
              user,
              roundId: activeRoundId,
              quantity: 1,
              outcome:
                outcome === "unregistered"
                  ? { unregistered: {} }
                  : { winner: [{ tier0: {} }] },
              bump,
            } as never);
            const data = Buffer.alloc(program.account.ticket.size);
            encoded.copy(data);
            await setAccount(ticket, {
              lamports: ticketRent,
              data,
              owner: program.programId,
              executable: false,
            });
            return ticket;
          }

          async function withCleanupTicket(
            user: anchor.web3.PublicKey,
            outcome: CleanupOutcome,
            operation: (ticket: anchor.web3.PublicKey) => Promise<void>
          ) {
            const ticket = ticketPda(user).ticket;
            const original = await provider.connection.getAccountInfo(
              ticket,
              "confirmed"
            );
            await putCleanupTicket(user, outcome);
            try {
              await operation(ticket);
            } finally {
              await restoreAccount(ticket, original);
            }
          }

          async function withLiveCleanupRound(
            overrides: Record<string, unknown>,
            operation: () => Promise<void>
          ) {
            const [roundInfo, current] = await Promise.all([
              provider.connection.getAccountInfo(activeRound, "confirmed"),
              program.account.round.fetch(activeRound, "confirmed"),
            ]);
            expect(roundInfo).not.to.equal(null);
            const data = await program.coder.accounts.encode("round", {
              ...current,
              ...overrides,
            } as never);
            await setAccount(activeRound, {
              lamports: roundInfo!.lamports,
              data,
              owner: program.programId,
              executable: false,
            });
            try {
              await operation();
            } finally {
              await restoreAccount(activeRound, roundInfo);
            }
          }

          async function withClosedCleanupRound(
            operation: () => Promise<void>
          ) {
            const original = await provider.connection.getAccountInfo(
              activeRound,
              "confirmed"
            );
            await setAccount(activeRound, {
              lamports: 0,
              data: Buffer.alloc(0),
              owner: systemProgram,
              executable: false,
            });
            try {
              await operation();
            } finally {
              await restoreAccount(activeRound, original);
            }
          }

          async function expectCleanupSuccess(
            user: anchor.web3.Keypair,
            ticket: anchor.web3.PublicKey
          ) {
            const [userBefore, treasuryBefore, vaultBefore] = await Promise.all(
              [
                provider.connection.getBalance(user.publicKey, "confirmed"),
                provider.connection.getBalance(
                  provider.wallet.publicKey,
                  "confirmed"
                ),
                snapshot([activePrizeVault]),
              ]
            );
            const receipt = await submitCleanup(user);
            expect(
              receipt.meta!.err,
              receipt.meta!.logMessages?.join("\n")
            ).to.equal(null);
            expect(
              (await provider.connection.getBalance(
                user.publicKey,
                "confirmed"
              )) - userBefore
            ).to.equal(ticketRent);
            expect(
              (await provider.connection.getBalance(
                provider.wallet.publicKey,
                "confirmed"
              )) - treasuryBefore
            ).to.equal(-receipt.meta!.fee);
            expect(await provider.connection.getAccountInfo(ticket)).to.equal(
              null
            );
            expect(await snapshot([activePrizeVault])).to.deep.equal(
              vaultBefore
            );
          }

          async function expectCleanupRejected(
            user: anchor.web3.Keypair,
            ticket: anchor.web3.PublicKey
          ) {
            await expectAnyRejectedWithoutChanges(
              await phase6Builder("cleanupExpiredTicket")
                .accountsStrict(cleanupAccounts(user.publicKey))
                .transaction(),
              [ticket, activeRound, activePrizeVault, user.publicKey],
              [user]
            );
          }

          before(async () => {
            for (let offset = 0; offset < cleanupUsers.length; offset += 8) {
              await provider.sendAndConfirm(
                new anchor.web3.Transaction().add(
                  ...cleanupUsers.slice(offset, offset + 8).map((user) =>
                    anchor.web3.SystemProgram.transfer({
                      fromPubkey: provider.wallet.publicKey,
                      toPubkey: user.publicKey,
                      lamports: 1_000_000,
                    })
                  )
                )
              );
            }
          });

          for (const [label, status] of [
            ["Selling", { selling: {} }],
            ["RandomnessPending", { randomnessPending: {} }],
          ] as const) {
            it(`rejects an Unregistered Ticket while the Round is ${label}`, async () => {
              const user = cleanupUsers[label === "Selling" ? 0 : 1];
              await withCleanupTicket(
                user.publicKey,
                "unregistered",
                async (ticket) => {
                  await withLiveCleanupRound({ status }, async () => {
                    await expectCleanupRejected(user, ticket);
                  });
                }
              );
            });
          }

          it("rejects an Unregistered Ticket before the registration deadline", async () => {
            const user = cleanupUsers[2];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { registering: {} },
                    registrationDeadline: now.addn(1_000),
                  },
                  async () => expectCleanupRejected(user, ticket)
                );
              }
            );
          });

          it("cleans an Unregistered Ticket after the registration deadline", async () => {
            const user = cleanupUsers[3];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { registering: {} },
                    registrationDeadline: now.subn(1),
                  },
                  async () => expectCleanupSuccess(user, ticket)
                );
              }
            );
          });

          it("protects a Winner Ticket throughout Registering", async () => {
            const user = cleanupUsers[4];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "winner",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { registering: {} },
                    registrationDeadline: now.subn(1),
                  },
                  async () => expectCleanupRejected(user, ticket)
                );
              }
            );
          });

          it("cleans an Unregistered Ticket before the claim deadline", async () => {
            const user = cleanupUsers[5];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { claiming: {} },
                    claimDeadline: now.addn(1_000),
                  },
                  async () => expectCleanupSuccess(user, ticket)
                );
              }
            );
          });

          it("protects a Winner Ticket before the claim deadline", async () => {
            const user = cleanupUsers[6];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "winner",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { claiming: {} },
                    claimDeadline: now.addn(1_000),
                  },
                  async () => {
                    await expectRejectedWithoutChanges(
                      await phase6Builder("cleanupExpiredTicket")
                        .accountsStrict(cleanupAccounts(user.publicKey))
                        .transaction(),
                      "ClaimStillOpen",
                      [ticket, activeRound, activePrizeVault, user.publicKey],
                      [user]
                    );
                  }
                );
              }
            );
          });

          for (const [label, outcome, offset] of [
            ["Unregistered", "unregistered", 7],
            ["Winner", "winner", 8],
          ] as const) {
            it(`cleans a ${label} Ticket at the exact claim deadline`, async () => {
              const user = cleanupUsers[offset];
              const deadline = (await chainTimestamp()).addn(10);
              await withCleanupTicket(
                user.publicKey,
                outcome,
                async (ticket) => {
                  await withLiveCleanupRound(
                    {
                      status: { claiming: {} },
                      claimDeadline: deadline,
                    },
                    async () => {
                      await setChainTime(deadline);
                      await expectCleanupSuccess(user, ticket);
                    }
                  );
                }
              );
            });
          }

          for (const [label, outcome, offset] of [
            ["Unregistered", "unregistered", 19],
            ["Winner", "winner", 20],
          ] as const) {
            it(`cleans a ${label} Ticket after the claim deadline`, async () => {
              const user = cleanupUsers[offset];
              const now = await chainTimestamp();
              await withCleanupTicket(
                user.publicKey,
                outcome,
                async (ticket) => {
                  await withLiveCleanupRound(
                    {
                      status: { claiming: {} },
                      claimDeadline: now.subn(1),
                    },
                    async () => expectCleanupSuccess(user, ticket)
                  );
                }
              );
            });
          }

          for (const [label, outcome, offset] of [
            ["Unregistered", "unregistered", 9],
            ["Winner", "winner", 10],
          ] as const) {
            it(`cleans a ${label} Ticket after the canonical Round is closed`, async () => {
              const user = cleanupUsers[offset];
              await withCleanupTicket(
                user.publicKey,
                outcome,
                async (ticket) => {
                  await withClosedCleanupRound(async () => {
                    await expectCleanupSuccess(user, ticket);
                  });
                }
              );
            });
          }

          it("rejects a wrong Player and cannot redirect Ticket rent", async () => {
            const owner = cleanupUsers[11];
            const attacker = cleanupUsers[12];
            const now = await chainTimestamp();
            await withCleanupTicket(
              owner.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { claiming: {} },
                    claimDeadline: now.subn(1),
                  },
                  async () => {
                    await expectRejectedWithoutChanges(
                      await phase6Builder("cleanupExpiredTicket")
                        .accountsStrict(
                          cleanupAccounts(attacker.publicKey, { ticket })
                        )
                        .transaction(),
                      "ConstraintSeeds",
                      [ticket, activeRound, activePrizeVault, owner.publicKey],
                      [attacker]
                    );
                  }
                );
              }
            );
          });

          it("rejects a wrong Ticket", async () => {
            const user = cleanupUsers[13];
            const other = cleanupUsers[14];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withCleanupTicket(
                  other.publicKey,
                  "unregistered",
                  async (otherTicket) => {
                    await withLiveCleanupRound(
                      {
                        status: { claiming: {} },
                        claimDeadline: now.subn(1),
                      },
                      async () => {
                        await expectRejectedWithoutChanges(
                          await phase6Builder("cleanupExpiredTicket")
                            .accountsStrict(
                              cleanupAccounts(user.publicKey, {
                                ticket: otherTicket,
                              })
                            )
                            .transaction(),
                          "ConstraintSeeds",
                          [
                            ticket,
                            otherTicket,
                            activeRound,
                            activePrizeVault,
                            user.publicKey,
                          ],
                          [user]
                        );
                      }
                    );
                  }
                );
              }
            );
          });

          it("rejects a wrong Round PDA and an arbitrary fake closed account", async () => {
            const user = cleanupUsers[15];
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                for (const suppliedRound of [
                  roundPdas(activeRoundId.addn(1)).round,
                  substituteSystemAccount,
                ]) {
                  await expectRejectedWithoutChanges(
                    await phase6Builder("cleanupExpiredTicket")
                      .accountsStrict(
                        cleanupAccounts(user.publicKey, {
                          round: suppliedRound,
                        })
                      )
                      .transaction(),
                    "ConstraintSeeds",
                    [ticket, activeRound, activePrizeVault, user.publicKey],
                    [user]
                  );
                }
              }
            );
          });

          it("rejects malformed program-owned data at the canonical Round PDA", async () => {
            const user = cleanupUsers[16];
            const originalRound = await provider.connection.getAccountInfo(
              activeRound,
              "confirmed"
            );
            expect(originalRound).not.to.equal(null);
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await setAccount(activeRound, {
                  lamports: originalRound!.lamports,
                  data: Buffer.alloc(8),
                  owner: program.programId,
                  executable: false,
                });
                try {
                  await expectCleanupRejected(user, ticket);
                } finally {
                  await restoreAccount(activeRound, originalRound);
                }
              }
            );
          });

          it("rejects cleanup replay through framework account validation", async () => {
            const user = cleanupUsers[17];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { claiming: {} },
                    claimDeadline: now.subn(1),
                  },
                  async () => {
                    const first = await submitCleanup(user);
                    expect(first.meta!.err).to.equal(null);
                    const afterFirst = await provider.connection.getBalance(
                      user.publicKey,
                      "confirmed"
                    );
                    const replay = await submitCleanup(user);
                    expectReceiptError(replay, "AccountNotInitialized");
                    expect(
                      await provider.connection.getBalance(
                        user.publicKey,
                        "confirmed"
                      )
                    ).to.equal(afterFirst);
                    expect(
                      await provider.connection.getAccountInfo(ticket)
                    ).to.equal(null);
                  }
                );
              }
            );
          });

          it("rolls back Ticket close and rent movement when a later instruction fails", async () => {
            const user = cleanupUsers[18];
            const now = await chainTimestamp();
            await withCleanupTicket(
              user.publicKey,
              "unregistered",
              async (ticket) => {
                await withLiveCleanupRound(
                  {
                    status: { claiming: {} },
                    claimDeadline: now.subn(1),
                  },
                  async () => {
                    const watched = [
                      ticket,
                      activeRound,
                      activePrizeVault,
                      user.publicKey,
                    ];
                    const before = await snapshot(watched);
                    const receipt = await submitCleanup(user, {}, [
                      anchor.web3.SystemProgram.transfer({
                        fromPubkey: provider.wallet.publicKey,
                        toPubkey: substituteSystemAccount,
                        lamports: Number.MAX_SAFE_INTEGER,
                      }),
                    ]);
                    expect(receipt.meta!.err).not.to.equal(null);
                    expect(receipt.meta!.logMessages).to.include(
                      `Program ${program.programId.toBase58()} success`
                    );
                    expect(await snapshot(watched)).to.deep.equal(before);
                  }
                );
              }
            );
          });
        }
      );
    });
  });
});
