import type { BN } from "@anchor-lang/core";

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

function winnerTierIndex(outcome: object): number | null {
  if (!("winner" in outcome) || !Array.isArray(outcome.winner)) {
    return null;
  }

  const tier = outcome.winner[0];

  if (typeof tier !== "object" || tier === null) {
    return null;
  }

  const tierName = Object.keys(tier)[0];

  switch (tierName) {
    case "tier0":
      return 0;
    case "tier1":
      return 1;
    case "tier2":
      return 2;
    default:
      return null;
  }
}

export async function registerWinner() {
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
    "register_winner",
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

  if (!("registering" in roundAccount.status)) {
    throw new Error(
      `Round is not Registering: ${formatStatus(roundAccount.status)}`
    );
  }

  if (!chainTimestamp.lt(roundAccount.registrationDeadline)) {
    throw new Error(
      `Registration window is closed: chain timestamp ${chainTimestamp.toString()}, deadline ${roundAccount.registrationDeadline.toString()}`
    );
  }

  const user = context.provider.wallet.publicKey;
  const ticketSeed = context.getInstructionAccountConstSeed(
    "register_winner",
    "ticket"
  );
  const [ticket] = anchor.web3.PublicKey.findProgramAddressSync(
    [ticketSeed, u64ToLittleEndian(roundId), user.toBuffer()],
    context.programId
  );
  const ticketInfo = await context.provider.connection.getAccountInfo(
    ticket,
    "confirmed"
  );

  if (ticketInfo === null) {
    throw new Error(`Ticket does not exist: ${ticket.toBase58()}`);
  }

  if (!ticketInfo.owner.equals(context.programId)) {
    throw new Error(
      `Ticket is not owned by the Lotto Program: ${ticket.toBase58()}`
    );
  }

  const ticketAccount = await context.program.account.ticket.fetch(
    ticket,
    "confirmed"
  );

  if (!ticketAccount.user.equals(user)) {
    throw new Error("Ticket user does not match the provider wallet");
  }

  if (!ticketAccount.roundId.eq(roundId)) {
    throw new Error("Ticket round ID does not match the active Round");
  }

  if (!("unregistered" in ticketAccount.outcome)) {
    throw new Error(
      `Ticket is already registered: ${JSON.stringify(ticketAccount.outcome)}`
    );
  }

  const treasury = configAccount.treasury;
  const registeredUnitsBefore = roundAccount.registeredUnits.map((value) =>
    value.clone()
  );
  const treasuryBalanceBefore = await context.provider.connection.getBalance(
    treasury,
    "confirmed"
  );

  console.log("=== Register Winner ===");
  console.log("RPC:", context.provider.connection.rpcEndpoint);
  console.log("User:", user.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Ticket PDA:", ticket.toBase58());
  console.log("Treasury:", treasury.toBase58());
  console.log("Chain timestamp:", chainTimestamp.toString());
  console.log(
    "Registration deadline:",
    roundAccount.registrationDeadline.toString()
  );
  console.log("Ticket quantity:", ticketAccount.quantity);
  console.log("Ticket outcome before:", JSON.stringify(ticketAccount.outcome));
  console.log("Registered units before:", formatUnits(registeredUnitsBefore));
  console.log("Treasury balance before:", treasuryBalanceBefore);

  const transaction = await context.program.methods
    .registerWinner()
    .accountsStrict({
      user,
      round,
      ticket,
      config: context.config,
      treasury,
    })
    .transaction();
  const signature = await sendDevnetTransaction(context.provider, transaction);

  console.log("Transaction signature:", signature);

  const [roundAfter, ticketInfoAfter, treasuryBalanceAfter] = await Promise.all(
    [
      context.program.account.round.fetch(round, "confirmed"),
      context.provider.connection.getAccountInfo(ticket, "confirmed"),
      context.provider.connection.getBalance(treasury, "confirmed"),
    ]
  );
  const registeredUnitsAfter = roundAfter.registeredUnits;

  console.log();
  console.log("=== Registration Result ===");
  console.log("Ticket closed:", ticketInfoAfter === null);
  console.log("Registered units before:", formatUnits(registeredUnitsBefore));
  console.log("Registered units after:", formatUnits(registeredUnitsAfter));
  console.log("Treasury balance before:", treasuryBalanceBefore);
  console.log("Treasury balance after:", treasuryBalanceAfter);

  if (ticketInfoAfter === null) {
    const unitsChanged = registeredUnitsAfter.some(
      (value, index) => !value.eq(registeredUnitsBefore[index])
    );

    if (unitsChanged) {
      throw new Error("Non-winner registration changed registered units");
    }

    console.log("Registration result: Non-winner");
    return;
  }

  if (!ticketInfoAfter.owner.equals(context.programId)) {
    throw new Error("Remaining Ticket is not owned by the Lotto Program");
  }

  const ticketAfter = await context.program.account.ticket.fetch(
    ticket,
    "confirmed"
  );
  const tierIndex = winnerTierIndex(ticketAfter.outcome);

  if (tierIndex === null) {
    throw new Error(
      `Remaining Ticket does not have a Winner outcome: ${JSON.stringify(
        ticketAfter.outcome
      )}`
    );
  }

  for (let index = 0; index < registeredUnitsAfter.length; index += 1) {
    const expected = registeredUnitsBefore[index].add(
      new anchor.BN(index === tierIndex ? ticketAccount.quantity : 0)
    );

    if (!registeredUnitsAfter[index].eq(expected)) {
      throw new Error(`Registered units mismatch at tier ${index}`);
    }
  }

  console.log("Registration result: Winner");
  console.log("Outcome:", JSON.stringify(ticketAfter.outcome));
}
