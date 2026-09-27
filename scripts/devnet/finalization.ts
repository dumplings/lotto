import type { BN, IdlAccounts, web3 } from "@anchor-lang/core";

import type { Lotto } from "../../target/types/lotto";

// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as devnetContext from "./context.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { readChainTimestamp } from "./randomness.ts";

const {
  anchor,
  createDevnetContext,
  sendDevnetTransaction,
  u64ToLittleEndian,
} = devnetContext;

type DevnetContext = Awaited<ReturnType<typeof createDevnetContext>>;
type RoundAccount = IdlAccounts<Lotto>["round"];
type AccountInfo = web3.AccountInfo<Buffer>;

function formatStatus(status: object): string {
  const name = Object.keys(status)[0];

  if (name === undefined) {
    return JSON.stringify(status);
  }

  return `${name[0].toUpperCase()}${name.slice(1)}`;
}

function formatUnits(units: readonly BN[]): string[] {
  return units.map((value) => value.toString());
}

function equalUnits(left: readonly BN[], right: readonly BN[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value.eq(right[index]))
  );
}

function deriveRound(
  context: DevnetContext,
  instructionName: "finalize_registration" | "finalize_round",
  roundId: BN
) {
  const roundSeed = context.getInstructionAccountConstSeed(
    instructionName,
    "round"
  );

  return anchor.web3.PublicKey.findProgramAddressSync(
    [roundSeed, u64ToLittleEndian(roundId)],
    context.programId
  )[0];
}

function derivePrizeVault(context: DevnetContext, roundId: BN) {
  const prizeVaultSeed = context.getInstructionAccountConstSeed(
    "finalize_round",
    "prize_vault"
  );

  return anchor.web3.PublicKey.findProgramAddressSync(
    [prizeVaultSeed, u64ToLittleEndian(roundId)],
    context.programId
  )[0];
}

function verifyRolloverVault(context: DevnetContext) {
  const rolloverVaultSeed = context.getInstructionAccountConstSeed(
    "finalize_round",
    "rollover_vault"
  );
  const rolloverVaultFromFinalizeRound =
    anchor.web3.PublicKey.findProgramAddressSync(
      [rolloverVaultSeed],
      context.programId
    )[0];

  if (!rolloverVaultFromFinalizeRound.equals(context.rolloverVault)) {
    throw new Error(
      "finalize_round Rollover Vault does not match the canonical context PDA"
    );
  }
}

function printAccount(
  label: string,
  address: web3.PublicKey,
  accountInfo: AccountInfo | null
) {
  console.log(`${label}:`);
  console.log("  Address:", address.toBase58());
  console.log("  Exists:", accountInfo !== null);
  console.log(
    "  Owner:",
    accountInfo === null ? "N/A" : accountInfo.owner.toBase58()
  );
  console.log("  Lamports:", accountInfo?.lamports ?? 0);
  console.log("  Data length:", accountInfo?.data.length ?? 0);
}

function printDeadlineStatus(stage: string, deadline: BN, chainTimestamp: BN) {
  if (deadline.isZero()) {
    console.log(`${stage} deadline: not set`);
    console.log(`${stage} deadline reached: n/a`);
    return;
  }

  console.log(`${stage} deadline:`, deadline.toString());
  console.log(`${stage} deadline reached:`, chainTimestamp.gte(deadline));
}

function expectedPrizePerUnit(round: RoundAccount): BN[] {
  const prizeBase = round.salesProceeds.add(round.rolloverIn);

  return round.registeredUnits.map((registeredUnits, index) => {
    if (registeredUnits.isZero()) {
      return new anchor.BN(0);
    }

    const pool = prizeBase.muln(round.tierPoolBps[index]).divn(10_000);
    return pool.div(registeredUnits);
  });
}

async function getTransactionFee(
  context: DevnetContext,
  signature: string
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const transaction = await context.provider.connection.getTransaction(
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }
    );

    if (transaction !== null) {
      if (transaction.meta === null) {
        throw new Error(`Transaction metadata is missing: ${signature}`);
      }

      return transaction.meta.fee;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Confirmed transaction was not available: ${signature}`);
}

export async function roundStatus() {
  const context = await createDevnetContext();
  const [configAccount, chainTimestamp, rolloverVaultInfo] = await Promise.all([
    context.program.account.lottoConfig.fetch(context.config, "confirmed"),
    readChainTimestamp(context.provider),
    context.provider.connection.getAccountInfo(
      context.rolloverVault,
      "confirmed"
    ),
  ]);
  const roundId = configAccount.activeRoundId;

  console.log("=== Round Status ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);

  if (roundId === null) {
    console.log("Active Round: None");
    console.log("Chain timestamp:", chainTimestamp.toString());
    console.log();
    printAccount("Rollover Vault", context.rolloverVault, rolloverVaultInfo);
    return;
  }

  verifyRolloverVault(context);

  const round = deriveRound(context, "finalize_round", roundId);
  const prizeVault = derivePrizeVault(context, roundId);
  const [roundAccount, prizeVaultInfo] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    context.provider.connection.getAccountInfo(prizeVault, "confirmed"),
  ]);

  if (!roundAccount.roundId.eq(roundId)) {
    throw new Error("Active Round account does not match Config activeRoundId");
  }

  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Status:", formatStatus(roundAccount.status));
  console.log();
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log();
  printDeadlineStatus("Sale", roundAccount.saleDeadline, chainTimestamp);
  printDeadlineStatus(
    "Registration",
    roundAccount.registrationDeadline,
    chainTimestamp
  );
  printDeadlineStatus("Claim", roundAccount.claimDeadline, chainTimestamp);
  console.log();
  console.log("Randomness ready:", roundAccount.randomnessReady);
  console.log(
    "Randomness requested at:",
    roundAccount.randomnessRequestedAt.toString()
  );
  console.log(
    "Randomness received at:",
    roundAccount.randomnessReceivedAt.toString()
  );
  console.log();
  console.log("Sales proceeds:", roundAccount.salesProceeds.toString());
  console.log("Rollover in:", roundAccount.rolloverIn.toString());
  console.log("Registered units:", formatUnits(roundAccount.registeredUnits));
  console.log("Prize per unit:", formatUnits(roundAccount.prizePerUnit));
  console.log();
  printAccount("Prize Vault", prizeVault, prizeVaultInfo);
  console.log();
  printAccount("Rollover Vault", context.rolloverVault, rolloverVaultInfo);
}

export async function finalizeRegistration() {
  const context = await createDevnetContext();
  const configAccount = await context.program.account.lottoConfig.fetch(
    context.config,
    "confirmed"
  );
  const roundId = configAccount.activeRoundId;

  if (roundId === null) {
    throw new Error("No active round");
  }

  const round = deriveRound(context, "finalize_registration", roundId);
  const [roundBefore, chainTimestampBefore] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    readChainTimestamp(context.provider),
  ]);

  if (!roundBefore.roundId.eq(roundId)) {
    throw new Error("Active Round account does not match Config activeRoundId");
  }

  if (!("registering" in roundBefore.status)) {
    throw new Error(
      `Round is not Registering: ${formatStatus(roundBefore.status)}`
    );
  }

  if (chainTimestampBefore.lt(roundBefore.registrationDeadline)) {
    throw new Error(
      `Registration deadline has not been reached: chain timestamp ${chainTimestampBefore.toString()}, deadline ${roundBefore.registrationDeadline.toString()}`
    );
  }

  console.log("=== Finalize Registration ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("Authority:", context.provider.wallet.publicKey.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log();
  console.log("Chain timestamp:", chainTimestampBefore.toString());
  console.log(
    "Registration deadline:",
    roundBefore.registrationDeadline.toString()
  );
  console.log("Registered units:", formatUnits(roundBefore.registeredUnits));
  console.log("Sales proceeds:", roundBefore.salesProceeds.toString());
  console.log("Rollover in:", roundBefore.rolloverIn.toString());

  const transaction = await context.program.methods
    .finalizeRegistration()
    .accountsStrict({
      authority: context.provider.wallet.publicKey,
      config: context.config,
      round,
    })
    .transaction();
  const signature = await sendDevnetTransaction(context.provider, transaction);

  console.log("Transaction signature:", signature);

  const [roundAfter, chainTimestampAfter] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    readChainTimestamp(context.provider),
  ]);
  const expectedPrize = expectedPrizePerUnit(roundBefore);
  const finalizedAt = roundAfter.claimDeadline.sub(
    roundAfter.claimDurationSecs
  );
  const claimWindowOpen =
    "claiming" in roundAfter.status &&
    chainTimestampAfter.lt(roundAfter.claimDeadline);

  console.log();
  console.log("=== Round After Finalize Registration ===");
  console.log("Status:", formatStatus(roundAfter.status));
  console.log("Registered units:", formatUnits(roundAfter.registeredUnits));
  console.log("Prize per unit:", formatUnits(roundAfter.prizePerUnit));
  console.log("Claim duration secs:", roundAfter.claimDurationSecs.toString());
  console.log("Claim deadline:", roundAfter.claimDeadline.toString());
  console.log("Chain timestamp:", chainTimestampAfter.toString());
  console.log("Claim window open:", claimWindowOpen);

  if (!("claiming" in roundAfter.status)) {
    throw new Error(
      `Round did not enter Claiming: ${formatStatus(roundAfter.status)}`
    );
  }

  if (!equalUnits(roundAfter.registeredUnits, roundBefore.registeredUnits)) {
    throw new Error("Finalization changed registered units");
  }

  if (!equalUnits(roundAfter.prizePerUnit, expectedPrize)) {
    throw new Error(
      `Prize per unit does not match on-chain inputs: expected ${formatUnits(
        expectedPrize
      ).join(",")}`
    );
  }

  if (
    finalizedAt.lt(chainTimestampBefore) ||
    finalizedAt.gt(chainTimestampAfter)
  ) {
    throw new Error("Claim deadline was not established from transaction time");
  }
}

export async function finalizeRound() {
  const context = await createDevnetContext();
  const configBefore = await context.program.account.lottoConfig.fetch(
    context.config,
    "confirmed"
  );
  const roundId = configBefore.activeRoundId;

  if (roundId === null) {
    throw new Error("No active round");
  }

  verifyRolloverVault(context);

  const round = deriveRound(context, "finalize_round", roundId);
  const prizeVault = derivePrizeVault(context, roundId);
  const treasury = configBefore.treasury;
  const systemProgram = context.getInstructionAccountAddress(
    "finalize_round",
    "system_program"
  );
  const [
    roundBefore,
    chainTimestamp,
    roundInfoBefore,
    prizeVaultInfoBefore,
    rolloverVaultInfoBefore,
    treasuryBalanceBefore,
    treasuryInfoBefore,
    prizeVaultRentReserve,
  ] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    readChainTimestamp(context.provider),
    context.provider.connection.getAccountInfo(round, "confirmed"),
    context.provider.connection.getAccountInfo(prizeVault, "confirmed"),
    context.provider.connection.getAccountInfo(
      context.rolloverVault,
      "confirmed"
    ),
    context.provider.connection.getBalance(treasury, "confirmed"),
    context.provider.connection.getAccountInfo(treasury, "confirmed"),
    context.provider.connection.getMinimumBalanceForRentExemption(
      0,
      "confirmed"
    ),
  ]);

  if (!roundBefore.roundId.eq(roundId)) {
    throw new Error("Active Round account does not match Config activeRoundId");
  }

  if (!("claiming" in roundBefore.status)) {
    throw new Error(
      `Round is not Claiming: ${formatStatus(roundBefore.status)}`
    );
  }

  if (chainTimestamp.lt(roundBefore.claimDeadline)) {
    throw new Error(
      `Claim deadline has not been reached: chain timestamp ${chainTimestamp.toString()}, deadline ${roundBefore.claimDeadline.toString()}`
    );
  }

  if (roundInfoBefore === null) {
    throw new Error(`Round account is missing: ${round.toBase58()}`);
  }

  if (prizeVaultInfoBefore === null) {
    throw new Error(`Prize Vault is missing: ${prizeVault.toBase58()}`);
  }

  if (rolloverVaultInfoBefore === null) {
    throw new Error(
      `Rollover Vault is missing: ${context.rolloverVault.toBase58()}`
    );
  }

  if (!roundInfoBefore.owner.equals(context.programId)) {
    throw new Error("Round account is not owned by the Lotto Program");
  }

  if (
    !prizeVaultInfoBefore.owner.equals(anchor.web3.SystemProgram.programId) ||
    prizeVaultInfoBefore.data.length !== 0
  ) {
    throw new Error("Prize Vault is not a zero-data System account");
  }

  if (
    !rolloverVaultInfoBefore.owner.equals(
      anchor.web3.SystemProgram.programId
    ) ||
    rolloverVaultInfoBefore.data.length !== 0
  ) {
    throw new Error("Rollover Vault is not a zero-data System account");
  }

  if (!systemProgram.equals(anchor.web3.SystemProgram.programId)) {
    throw new Error("IDL System Program address is not canonical");
  }

  if (prizeVaultInfoBefore.lamports < prizeVaultRentReserve) {
    throw new Error("Prize Vault balance is below its rent reserve");
  }

  const expectedRolloverOut =
    prizeVaultInfoBefore.lamports - prizeVaultRentReserve;

  console.log("=== Finalize Round ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("Authority:", context.provider.wallet.publicKey.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Prize Vault:", prizeVault.toBase58());
  console.log("Rollover Vault:", context.rolloverVault.toBase58());
  console.log("Treasury:", treasury.toBase58());
  console.log();
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log("Claim deadline:", roundBefore.claimDeadline.toString());
  console.log("Config active round ID:", roundId.toString());
  console.log("Round status:", formatStatus(roundBefore.status));
  console.log("Sales proceeds:", roundBefore.salesProceeds.toString());
  console.log("Rollover in:", roundBefore.rolloverIn.toString());
  console.log("Prize per unit:", formatUnits(roundBefore.prizePerUnit));
  console.log("Registered units:", formatUnits(roundBefore.registeredUnits));
  console.log();
  printAccount("Round account before", round, roundInfoBefore);
  console.log();
  printAccount("Prize Vault before", prizeVault, prizeVaultInfoBefore);
  console.log("  Rent reserve:", prizeVaultRentReserve);
  console.log("  Business lamports:", expectedRolloverOut);
  console.log();
  printAccount(
    "Rollover Vault before",
    context.rolloverVault,
    rolloverVaultInfoBefore
  );
  console.log();
  printAccount("Treasury before", treasury, treasuryInfoBefore);
  console.log("  Balance:", treasuryBalanceBefore);

  const transaction = await context.program.methods
    .finalizeRound()
    .accountsStrict({
      authority: context.provider.wallet.publicKey,
      config: context.config,
      round,
      prizeVault,
      rolloverVault: context.rolloverVault,
      treasury,
      systemProgram,
    })
    .transaction();
  const signature = await sendDevnetTransaction(context.provider, transaction);

  console.log("Transaction signature:", signature);

  const [
    configAfter,
    roundInfoAfter,
    prizeVaultInfoAfter,
    rolloverVaultInfoAfter,
    treasuryBalanceAfter,
    treasuryInfoAfter,
    transactionFee,
  ] = await Promise.all([
    context.program.account.lottoConfig.fetch(context.config, "confirmed"),
    context.provider.connection.getAccountInfo(round, "confirmed"),
    context.provider.connection.getAccountInfo(prizeVault, "confirmed"),
    context.provider.connection.getAccountInfo(
      context.rolloverVault,
      "confirmed"
    ),
    context.provider.connection.getBalance(treasury, "confirmed"),
    context.provider.connection.getAccountInfo(treasury, "confirmed"),
    getTransactionFee(context, signature),
  ]);

  if (rolloverVaultInfoAfter === null) {
    throw new Error("Rollover Vault disappeared after finalization");
  }

  const rolloverDelta =
    rolloverVaultInfoAfter.lamports - rolloverVaultInfoBefore.lamports;
  const treasuryDelta = treasuryBalanceAfter - treasuryBalanceBefore;
  const grossTreasuryCloseFunds =
    roundInfoBefore.lamports + prizeVaultRentReserve;
  const treasuryPaysFee = treasury.equals(context.provider.wallet.publicKey);
  const expectedTreasuryDelta =
    grossTreasuryCloseFunds - (treasuryPaysFee ? transactionFee : 0);

  console.log();
  console.log("=== Round After Finalize ===");
  console.log(
    "Config active round ID:",
    configAfter.activeRoundId === null
      ? "None"
      : configAfter.activeRoundId.toString()
  );
  console.log();
  printAccount("Round account after", round, roundInfoAfter);
  console.log();
  printAccount("Prize Vault after", prizeVault, prizeVaultInfoAfter);
  console.log();
  printAccount(
    "Rollover Vault after",
    context.rolloverVault,
    rolloverVaultInfoAfter
  );
  console.log("  Balance delta:", rolloverDelta);
  console.log("  Expected business delta:", expectedRolloverOut);
  console.log();
  printAccount("Treasury after", treasury, treasuryInfoAfter);
  console.log("  Balance before:", treasuryBalanceBefore);
  console.log("  Balance after:", treasuryBalanceAfter);
  console.log("  Observed balance delta:", treasuryDelta);
  console.log("  Gross close funds:", grossTreasuryCloseFunds);
  console.log("  Transaction fee:", transactionFee);
  console.log("  Treasury is fee payer:", treasuryPaysFee);
  console.log("  Expected net delta:", expectedTreasuryDelta);

  if (configAfter.activeRoundId !== null) {
    throw new Error("Config activeRoundId was not cleared");
  }

  if (roundInfoAfter !== null) {
    throw new Error("Round account was not closed");
  }

  if (prizeVaultInfoAfter !== null) {
    throw new Error("Prize Vault was not closed");
  }

  if (rolloverDelta !== expectedRolloverOut) {
    throw new Error(
      `Rollover Vault delta mismatch: expected ${expectedRolloverOut}, received ${rolloverDelta}`
    );
  }

  if (treasuryDelta !== expectedTreasuryDelta) {
    throw new Error(
      `Treasury delta mismatch: expected ${expectedTreasuryDelta}, received ${treasuryDelta}`
    );
  }
}
