import { expect } from "chai";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import type { Lotto } from "../target/types/lotto";

declare const process: {
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

describe("lotto Phase 0-1", function () {
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
    it("pins the reconstruction Program ID and only the Phase 1 instructions", () => {
      expect(program.programId.toBase58()).to.equal(
        "6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm"
      );
      expect(rawIdl.address).to.equal(program.programId.toBase58());
      expect(rawIdl.instructions.map(({ name }) => name)).to.deep.equal([
        "initialize_config",
        "update_config",
      ]);
      expect(program.idl.instructions.map(({ name }) => name)).to.deep.equal([
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

    it("pins the LottoConfig field order", () => {
      expect(rawIdl.accounts?.map(({ name }) => name)).to.deep.equal([
        "LottoConfig",
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

    it("establishes the complete Phase 1 append-only error baseline", () => {
      expect(rawIdl.errors).to.deep.equal([
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
});
