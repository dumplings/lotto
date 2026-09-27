// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as devnetContext from "./context.ts";

const {
  anchor,
  createDevnetContext,
  sendDevnetTransaction,
  u64ToLittleEndian,
} = devnetContext;

export async function createRound() {
  const {
    provider,
    program,
    programId,
    config,
    rolloverVault,
    getInstructionAccountConstSeed,
  } = await createDevnetContext();

  const configBefore = await program.account.lottoConfig.fetch(
    config,
    "confirmed"
  );

  if (configBefore.activeRoundId !== null) {
    throw new Error(
      `Active round already exists: ${configBefore.activeRoundId.toString()}`
    );
  }

  const roundId = configBefore.nextRoundId;
  const roundIdBytes = u64ToLittleEndian(roundId);
  const roundSeed = getInstructionAccountConstSeed("create_round", "round");
  const prizeVaultSeed = getInstructionAccountConstSeed(
    "create_round",
    "prize_vault"
  );

  const [round] = anchor.web3.PublicKey.findProgramAddressSync(
    [roundSeed, roundIdBytes],
    programId
  );
  const [prizeVault] = anchor.web3.PublicKey.findProgramAddressSync(
    [prizeVaultSeed, roundIdBytes],
    programId
  );

  console.log("=== Create Round ===");
  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Prize Vault:", prizeVault.toBase58());
  console.log("Rollover Vault:", rolloverVault.toBase58());

  const transaction = await program.methods
    .createRound()
    .accountsStrict({
      authority: provider.wallet.publicKey,
      config,
      round,
      prizeVault,
      rolloverVault,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .transaction();
  const signature = await sendDevnetTransaction(provider, transaction);

  console.log("Transaction signature:", signature);

  const [configAfter, createdRound, prizeVaultInfo, rolloverVaultInfo] =
    await Promise.all([
      program.account.lottoConfig.fetch(config, "confirmed"),
      program.account.round.fetch(round, "confirmed"),
      provider.connection.getAccountInfo(prizeVault, "confirmed"),
      provider.connection.getAccountInfo(rolloverVault, "confirmed"),
    ]);

  const expectedNextRoundId = roundId.add(new anchor.BN(1));

  if (
    configAfter.activeRoundId === null ||
    !configAfter.activeRoundId.eq(roundId)
  ) {
    throw new Error("Config active round ID does not match the created Round");
  }

  if (!configAfter.nextRoundId.eq(expectedNextRoundId)) {
    throw new Error("Config next round ID did not advance by one");
  }

  if (!createdRound.roundId.eq(roundId)) {
    throw new Error("Created Round ID does not match the requested Round ID");
  }

  if (prizeVaultInfo === null) {
    throw new Error(`Prize Vault was not created: ${prizeVault.toBase58()}`);
  }

  if (
    !prizeVaultInfo.owner.equals(anchor.web3.SystemProgram.programId) ||
    prizeVaultInfo.data.length !== 0
  ) {
    throw new Error("Prize Vault is not a zero-data System account");
  }

  if (rolloverVaultInfo === null) {
    throw new Error(`Rollover Vault is missing: ${rolloverVault.toBase58()}`);
  }

  if (
    !rolloverVaultInfo.owner.equals(anchor.web3.SystemProgram.programId) ||
    rolloverVaultInfo.data.length !== 0
  ) {
    throw new Error("Rollover Vault is not a zero-data System account");
  }

  console.log();
  console.log("=== Config After Create Round ===");
  console.log("Next round ID:", configAfter.nextRoundId.toString());
  console.log("Active round ID:", configAfter.activeRoundId.toString());

  console.log();
  console.log("=== Round Created ===");
  console.log("Address:", round.toBase58());
  console.log("Round ID:", createdRound.roundId.toString());
  console.log("Status:", JSON.stringify(createdRound.status));
  console.log("Ticket price:", createdRound.ticketPrice.toString());
  console.log("Tier thresholds:", createdRound.tierThresholds);
  console.log("Tier pool BPS:", createdRound.tierPoolBps);
  console.log("Sale duration secs:", createdRound.saleDurationSecs.toString());
  console.log(
    "Registration duration secs:",
    createdRound.registrationDurationSecs.toString()
  );
  console.log(
    "Claim duration secs:",
    createdRound.claimDurationSecs.toString()
  );
  console.log("Sale deadline:", createdRound.saleDeadline.toString());
  console.log(
    "Registration deadline:",
    createdRound.registrationDeadline.toString()
  );
  console.log("Claim deadline:", createdRound.claimDeadline.toString());
  console.log("Sales proceeds:", createdRound.salesProceeds.toString());
  console.log("Rollover in:", createdRound.rolloverIn.toString());
  console.log(
    "Registered units:",
    createdRound.registeredUnits.map((value) => value.toString())
  );
  console.log(
    "Prize per unit:",
    createdRound.prizePerUnit.map((value) => value.toString())
  );
  console.log("Bump:", createdRound.bump);

  console.log();
  console.log("=== Prize Vault ===");
  console.log("Address:", prizeVault.toBase58());
  console.log("Owner:", prizeVaultInfo.owner.toBase58());
  console.log("Lamports:", prizeVaultInfo.lamports);
  console.log("Data length:", prizeVaultInfo.data.length);

  console.log();
  console.log("=== Rollover Vault ===");
  console.log("Address:", rolloverVault.toBase58());
  console.log("Owner:", rolloverVaultInfo.owner.toBase58());
  console.log("Lamports:", rolloverVaultInfo.lamports);
  console.log("Data length:", rolloverVaultInfo.data.length);
}
