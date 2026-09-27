import type { AnchorProvider, IdlAccounts } from "@anchor-lang/core";

import type { Lotto } from "../../target/types/lotto";

// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as devnetContext from "./context.ts";

const {
  anchor,
  createDevnetContext,
  sendDevnetTransaction,
  u64ToLittleEndian,
} = devnetContext;

type RoundAccount = IdlAccounts<Lotto>["round"];

export async function readChainTimestamp(provider: AnchorProvider) {
  const clockInfo = await provider.connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  if (clockInfo === null) {
    throw new Error("Clock sysvar account is missing");
  }

  if (clockInfo.data.length < 40) {
    throw new Error(
      `Clock sysvar data is too short: ${clockInfo.data.length} bytes`
    );
  }

  return new anchor.BN(clockInfo.data.subarray(32, 40), "le").fromTwos(64);
}

function formatBytes(bytes: readonly number[]): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function formatStatus(status: object): string {
  const name = Object.keys(status)[0];

  if (name === undefined) {
    return JSON.stringify(status);
  }

  return `${name[0].toUpperCase()}${name.slice(1)}`;
}

function printRandomnessState(roundAccount: RoundAccount) {
  console.log("Status:", formatStatus(roundAccount.status));
  console.log("Randomness ready:", roundAccount.randomnessReady);
  console.log(
    "Randomness requested at:",
    roundAccount.randomnessRequestedAt.toString()
  );
  console.log(
    "Randomness received at:",
    roundAccount.randomnessReceivedAt.toString()
  );
  console.log(
    "Randomness binding:",
    formatBytes(roundAccount.randomnessBinding)
  );
  console.log("Randomness:", formatBytes(roundAccount.randomness));
}

async function loadActiveRound() {
  const context = await createDevnetContext();
  const configAccount = await context.program.account.lottoConfig.fetch(
    context.config,
    "confirmed"
  );
  const roundId = configAccount.activeRoundId;

  if (roundId === null) {
    throw new Error("No active round");
  }

  const roundSeed = context.getInstructionAccountConstSeed(
    "request_randomness",
    "round"
  );
  const [round] = anchor.web3.PublicKey.findProgramAddressSync(
    [roundSeed, u64ToLittleEndian(roundId)],
    context.programId
  );
  const [roundAccount, chainTimestamp] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    readChainTimestamp(context.provider),
  ]);

  if (!roundAccount.roundId.eq(roundId)) {
    throw new Error("Active Round account does not match Config activeRoundId");
  }

  return { context, roundId, round, roundAccount, chainTimestamp };
}

export async function randomnessStatus() {
  const { context, roundId, round, roundAccount, chainTimestamp } =
    await loadActiveRound();

  console.log("=== Randomness Status ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log();
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log("Sale deadline:", roundAccount.saleDeadline.toString());
  console.log(
    "Sale deadline reached:",
    chainTimestamp.gte(roundAccount.saleDeadline)
  );
  console.log();
  printRandomnessState(roundAccount);
}

export async function requestRandomness() {
  const { context, roundId, round, roundAccount, chainTimestamp } =
    await loadActiveRound();

  if (!("selling" in roundAccount.status)) {
    throw new Error(
      `Round is not Selling: ${formatStatus(roundAccount.status)}`
    );
  }

  if (chainTimestamp.lt(roundAccount.saleDeadline)) {
    throw new Error(
      `Sale deadline has not been reached: chain timestamp ${chainTimestamp.toString()}, deadline ${roundAccount.saleDeadline.toString()}`
    );
  }

  if (roundAccount.randomnessReady) {
    throw new Error("Round randomness is already ready");
  }

  const oracleQueue = context.getInstructionAccountAddress(
    "request_randomness",
    "oracle_queue"
  );
  const vrfProgram = context.getInstructionAccountAddress(
    "request_randomness",
    "vrf_program"
  );
  const slotHashes = context.getInstructionAccountAddress(
    "request_randomness",
    "slot_hashes"
  );
  const systemProgram = context.getInstructionAccountAddress(
    "request_randomness",
    "system_program"
  );
  const programIdentitySeed = context.getInstructionAccountConstSeed(
    "request_randomness",
    "program_identity"
  );
  const [programIdentity] = anchor.web3.PublicKey.findProgramAddressSync(
    [programIdentitySeed],
    context.programId
  );

  if (!slotHashes.equals(anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY)) {
    throw new Error("IDL Slot Hashes address is not the canonical sysvar");
  }

  if (!systemProgram.equals(anchor.web3.SystemProgram.programId)) {
    throw new Error("IDL System Program address is not canonical");
  }

  const [oracleQueueInfo, vrfProgramInfo, programIdentityInfo] =
    await Promise.all([
      context.provider.connection.getAccountInfo(oracleQueue, "confirmed"),
      context.provider.connection.getAccountInfo(vrfProgram, "confirmed"),
      context.provider.connection.getAccountInfo(programIdentity, "confirmed"),
    ]);

  if (oracleQueueInfo === null) {
    throw new Error(`Oracle queue is missing: ${oracleQueue.toBase58()}`);
  }

  if (vrfProgramInfo === null) {
    throw new Error(`VRF Program is missing: ${vrfProgram.toBase58()}`);
  }

  if (!vrfProgramInfo.executable) {
    throw new Error(`VRF Program is not executable: ${vrfProgram.toBase58()}`);
  }

  console.log("=== Request Randomness ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("Authority:", context.provider.wallet.publicKey.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log();
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log("Sale deadline:", roundAccount.saleDeadline.toString());
  console.log();
  console.log("Oracle queue:", oracleQueue.toBase58());
  console.log("Program identity:", programIdentity.toBase58());
  console.log("Program identity exists:", programIdentityInfo !== null);
  console.log("VRF program:", vrfProgram.toBase58());
  console.log("Slot hashes:", slotHashes.toBase58());
  console.log("System program:", systemProgram.toBase58());
  console.log();
  console.log("Randomness ready before request:", roundAccount.randomnessReady);
  console.log(
    "Round status before request:",
    formatStatus(roundAccount.status)
  );

  const transaction = await context.program.methods
    .requestRandomness()
    .accountsStrict({
      authority: context.provider.wallet.publicKey,
      config: context.config,
      round,
      oracleQueue,
      programIdentity,
      vrfProgram,
      slotHashes,
      systemProgram,
    })
    .transaction();
  const signature = await sendDevnetTransaction(context.provider, transaction);

  console.log("Transaction signature:", signature);

  const roundAfter = await context.program.account.round.fetch(
    round,
    "confirmed"
  );

  console.log();
  console.log("=== Round After Request ===");
  printRandomnessState(roundAfter);

  if (!("randomnessPending" in roundAfter.status)) {
    throw new Error(
      `Round did not enter RandomnessPending: ${formatStatus(
        roundAfter.status
      )}`
    );
  }
}

export async function settleRandomness() {
  const { context, roundId, round, roundAccount } = await loadActiveRound();

  if (!("randomnessPending" in roundAccount.status)) {
    throw new Error(
      `Round is not RandomnessPending: ${formatStatus(roundAccount.status)}`
    );
  }

  if (!roundAccount.randomnessReady) {
    throw new Error("Round randomness is not ready");
  }

  if (roundAccount.randomnessRequestedAt.lten(0)) {
    throw new Error("Round randomnessRequestedAt is not positive");
  }

  if (roundAccount.randomnessReceivedAt.lten(0)) {
    throw new Error("Round randomnessReceivedAt is not positive");
  }

  console.log("=== Settle Randomness ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("Authority:", context.provider.wallet.publicKey.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Status before:", formatStatus(roundAccount.status));
  console.log("Randomness ready:", roundAccount.randomnessReady);
  console.log(
    "Randomness requested at:",
    roundAccount.randomnessRequestedAt.toString()
  );
  console.log(
    "Randomness received at:",
    roundAccount.randomnessReceivedAt.toString()
  );
  console.log("Randomness:", formatBytes(roundAccount.randomness));

  const transaction = await context.program.methods
    .settleRandomness()
    .accountsStrict({
      authority: context.provider.wallet.publicKey,
      config: context.config,
      round,
    })
    .transaction();
  const signature = await sendDevnetTransaction(context.provider, transaction);

  console.log("Transaction signature:", signature);

  const [roundAfter, chainTimestamp] = await Promise.all([
    context.program.account.round.fetch(round, "confirmed"),
    readChainTimestamp(context.provider),
  ]);
  const registrationWindowOpen =
    "registering" in roundAfter.status &&
    chainTimestamp.lt(roundAfter.registrationDeadline);

  console.log();
  console.log("=== Round After Settlement ===");
  console.log("Status:", formatStatus(roundAfter.status));
  console.log(
    "Registration duration secs:",
    roundAfter.registrationDurationSecs.toString()
  );
  console.log(
    "Registration deadline:",
    roundAfter.registrationDeadline.toString()
  );
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log("Registration window open:", registrationWindowOpen);

  if (!("registering" in roundAfter.status)) {
    throw new Error(
      `Round did not enter Registering: ${formatStatus(roundAfter.status)}`
    );
  }

  if (!roundAfter.registrationDeadline.gt(chainTimestamp)) {
    throw new Error("Registration deadline is not after the chain timestamp");
  }
}
