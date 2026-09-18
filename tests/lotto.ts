import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import type { Lotto } from "../target/types/lotto";

declare const process: {
  env: Record<string, string | undefined>;
  getBuiltinModule(name: "fs"): {
    readFileSync(path: string, encoding: "utf8"): string;
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
    accounts: Array<{
      name: string;
      address?: string;
      relations?: string[];
      pda?: unknown;
      signer?: boolean;
      writable?: boolean;
    }>;
    args: Array<{ name: string; type: unknown }>;
  }>;
  accounts?: Array<{ name: string }>;
  types?: RawIdlType[];
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

const { readFileSync } = process.getBuiltinModule("fs");
const rawIdl = JSON.parse(
  readFileSync("target/idl/lotto.json", "utf8")
) as RawIdl;

describe("lotto Phase 0-2", function () {
  this.timeout(60_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.lotto as Program<Lotto>;
  const systemProgram = anchor.web3.SystemProgram.programId;
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
    it("pins the reconstruction Program ID and only the Phase 1-2 instructions", () => {
      expect(program.programId.toBase58()).to.equal(
        "6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm"
      );
      expect(rawIdl.address).to.equal(program.programId.toBase58());
      expect(rawIdl.instructions.map(({ name }) => name)).to.deep.equal([
        "buy_ticket",
        "create_round",
        "initialize_config",
        "update_config",
      ]);
      expect(program.idl.instructions.map(({ name }) => name)).to.deep.equal([
        "buyTicket",
        "createRound",
        "initializeConfig",
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
      const buy = instruction("buy_ticket");
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
        "user",
        "round",
        "ticket",
        "prize_vault",
        "system_program",
      ]);
      expect(buy.args).to.deep.equal([{ name: "quantity", type: "u32" }]);
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

    it("keeps the Phase 1 error ABI unchanged and pins the Phase 2 append", () => {
      expect(rawIdl.errors?.slice(0, 4)).to.deep.equal([
        {
          code: 6000,
          name: "InvalidTicketPrice",
          msg: "TicketPrice 需大于 0",
        },
        {
          code: 6001,
          name: "InvalidTierThresholds",
          msg: "TierThresholds 需递增且处于 1..256",
        },
        {
          code: 6002,
          name: "InvalidTierPoolBps",
          msg: "TierPoolBPS 总和不能大于 10,000",
        },
        {
          code: 6003,
          name: "UnauthorizedInitializer",
          msg: "当前 signer 不是 Program upgrade authority，无权初始化 Config",
        },
      ]);
      expect(rawIdl.errors?.slice(4)).to.deep.equal([
        {
          code: 6004,
          name: "ActiveRoundExists",
          msg: "存在已激活 Round",
        },
        {
          code: 6005,
          name: "ArithmeticError",
          msg: "Checked arithmetic operation failed",
        },
        {
          code: 6006,
          name: "InvalidTicketQuantity",
          msg: "Ticket quantity 需大于 0",
        },
        {
          code: 6007,
          name: "RoundNotSelling",
          msg: "Round is not in Selling state",
        },
        { code: 6008, name: "SaleClosed", msg: "售票已关闭" },
      ]);
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
    const playerA = anchor.web3.Keypair.generate();
    const playerB = anchor.web3.Keypair.generate();
    const zeroBuyer = anchor.web3.Keypair.generate();
    const maxQuantityBuyer = anchor.web3.Keypair.generate();
    const poorNewBuyer = anchor.web3.Keypair.generate();
    const poorRepeatBuyer = anchor.web3.Keypair.generate();
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

    function buyAccounts(user: anchor.web3.PublicKey) {
      return {
        user,
        round: activeRound,
        ticket: ticketPda(user).ticket,
        prizeVault: activePrizeVault,
        systemProgram,
      };
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
      overrides: Partial<ReturnType<typeof buyAccounts>> = {}
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
      const transaction = await program.methods
        .buyTicket(quantity)
        .accountsStrict(accounts)
        .transaction();
      return expectRejectedWithoutChanges(transaction, code, watched, [user]);
    }

    async function purchase(
      user: anchor.web3.Keypair,
      quantity: number,
      previousQuantity: number
    ) {
      const { ticket, bump } = ticketPda(user.publicKey);
      const ticketBefore = await provider.connection.getAccountInfo(
        ticket,
        "confirmed"
      );
      expect(ticketBefore === null).to.equal(previousQuantity === 0);
      const previous = ticketBefore
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
      const payment = phase2Price.mul(new anchor.BN(quantity));
      const receipt = await submitRecorded(
        await program.methods
          .buyTicket(quantity)
          .accountsStrict(buyAccounts(user.publicKey))
          .transaction(),
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
      expect(ticketInfo!.data.length).to.equal(program.account.ticket.size);
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
        roundAfter.salesProceeds.sub(roundBefore.salesProceeds).eq(payment)
      ).to.equal(true);
      expect(roundAfter.ticketPrice.eq(phase2Price)).to.equal(true);
      const vaultAfter = await provider.connection.getBalance(
        activePrizeVault,
        "confirmed"
      );
      expect(new anchor.BN(vaultAfter - vaultBefore).eq(payment)).to.equal(
        true
      );
      const userAfter = await provider.connection.getBalance(
        user.publicKey,
        "confirmed"
      );
      expect(
        new anchor.BN(userBefore - userAfter).eq(
          payment.add(new anchor.BN(previous === null ? ticketRent : 0))
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
      ticketRent = await provider.connection.getMinimumBalanceForRentExemption(
        program.account.ticket.size
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

    describe("buy_ticket", function () {
      before(async () => {
        const current = await program.account.lottoConfig.fetch(config);
        expect(current.activeRoundId?.eq(activeRoundId)).to.equal(true);
        const active = await program.account.round.fetch(activeRound);
        expect(active.saleDeadline.eq(saleDeadline)).to.equal(true);
        expect((await chainTimestamp()).lt(saleDeadline)).to.equal(true);
      });

      it("rejects zero quantity and rolls back init_if_needed rent", async () => {
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
          const receipt = await rejectBuy(playerA, 2, "ArithmeticError");
          expect(receipt.meta!.logMessages).to.include(
            `Program ${systemProgram.toBase58()} success`
          );
          expect(await snapshot(watched)).to.deep.equal(before);
        });
      } else {
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
          await purchase(playerA, 2, 3);
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
          await purchase(playerB, 4, 0);
          expect(
            await snapshot([ticketPda(playerA.publicKey).ticket])
          ).to.deep.equal(playerABefore);
        });

        it("checks u32 Ticket quantity addition and rolls back overflow", async () => {
          const maxQuantity = 0xffff_ffff;
          await purchase(maxQuantityBuyer, maxQuantity, 0);
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

        it("rolls back a newly initialized Ticket when the buyer cannot pay principal", async () => {
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(poorNewBuyer.publicKey).ticket,
            poorNewBuyer.publicKey,
          ];
          const before = await snapshot(watched);
          const receipt = await submitRecorded(
            await program.methods
              .buyTicket(1)
              .accountsStrict(buyAccounts(poorNewBuyer.publicKey))
              .transaction(),
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
          await purchase(poorRepeatBuyer, 1, 0);
          const watched = [
            activeRound,
            activePrizeVault,
            ticketPda(poorRepeatBuyer.publicKey).ticket,
            poorRepeatBuyer.publicKey,
          ];
          const before = await snapshot(watched);
          const receipt = await submitRecorded(
            await program.methods
              .buyTicket(2)
              .accountsStrict(buyAccounts(poorRepeatBuyer.publicKey))
              .transaction(),
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
  });
});
