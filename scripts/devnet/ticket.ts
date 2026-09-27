// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as devnetContext from "./context.ts";

const {
  anchor,
  createDevnetContext,
  sendDevnetTransaction,
  u64ToLittleEndian,
} = devnetContext;

const U32_MAX = 0xffff_ffff;
const MAX_SAFE_LAMPORTS = new anchor.BN(Number.MAX_SAFE_INTEGER);

type TicketAccountKind = "New" | "Existing";

export async function buyTicket(quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > U32_MAX) {
    throw new Error(`Quantity must be in the range 1..=${U32_MAX}`);
  }

  const {
    provider,
    program,
    programId,
    config,
    ticketSpace,
    getInstructionAccountConstSeed,
  } = await createDevnetContext();

  const buyer = provider.wallet.publicKey;
  const configAccount = await program.account.lottoConfig.fetch(
    config,
    "confirmed"
  );
  const roundId = configAccount.activeRoundId;

  if (roundId === null) {
    throw new Error("No active round");
  }

  const roundIdBytes = u64ToLittleEndian(roundId);
  const roundSeed = getInstructionAccountConstSeed("buy_ticket_v2", "round");
  const ticketSeed = getInstructionAccountConstSeed("buy_ticket_v2", "ticket");
  const prizeVaultSeed = getInstructionAccountConstSeed(
    "buy_ticket_v2",
    "prize_vault"
  );

  const [round] = anchor.web3.PublicKey.findProgramAddressSync(
    [roundSeed, roundIdBytes],
    programId
  );
  const [ticket] = anchor.web3.PublicKey.findProgramAddressSync(
    [ticketSeed, roundIdBytes, buyer.toBuffer()],
    programId
  );
  const [prizeVault] = anchor.web3.PublicKey.findProgramAddressSync(
    [prizeVaultSeed, roundIdBytes],
    programId
  );

  const [roundBefore, ticketInfoBefore] = await Promise.all([
    program.account.round.fetch(round, "confirmed"),
    provider.connection.getAccountInfo(ticket, "confirmed"),
  ]);

  if (!roundBefore.roundId.eq(roundId)) {
    throw new Error("Active Round account does not match Config activeRoundId");
  }

  let ticketAccountKind: TicketAccountKind;
  let previousQuantity = 0;

  if (
    ticketInfoBefore === null ||
    (ticketInfoBefore.owner.equals(anchor.web3.SystemProgram.programId) &&
      ticketInfoBefore.data.length === 0)
  ) {
    ticketAccountKind = "New";
  } else if (ticketInfoBefore.owner.equals(programId)) {
    ticketAccountKind = "Existing";
    const existingTicket = await program.account.ticket.fetch(
      ticket,
      "confirmed"
    );

    if (
      !existingTicket.user.equals(buyer) ||
      !existingTicket.roundId.eq(roundId)
    ) {
      throw new Error("Existing Ticket data does not match buyer and Round");
    }

    previousQuantity = existingTicket.quantity;
  } else {
    throw new Error(
      `Invalid Ticket account state: ${ticket.toBase58()} is owned by ${ticketInfoBefore.owner.toBase58()}`
    );
  }

  const expectedQuantity = previousQuantity + quantity;

  if (expectedQuantity > U32_MAX) {
    throw new Error("Ticket quantity would exceed u32 max");
  }

  const ticketSpaceValue = Number(ticketSpace.value);

  if (!Number.isSafeInteger(ticketSpaceValue) || ticketSpaceValue <= 0) {
    throw new Error(`Invalid TICKET_SPACE in IDL: ${ticketSpace.value}`);
  }

  const rentMinimum =
    await provider.connection.getMinimumBalanceForRentExemption(
      ticketSpaceValue,
      "confirmed"
    );
  const existingTicketLamports = ticketInfoBefore?.lamports ?? 0;
  const rentTopUp =
    ticketAccountKind === "New"
      ? Math.max(rentMinimum - existingTicketLamports, 0)
      : 0;
  const businessPayment = roundBefore.ticketPrice.mul(new anchor.BN(quantity));
  const expectedPayment = businessPayment.add(new anchor.BN(rentTopUp));

  if (expectedPayment.gt(MAX_SAFE_LAMPORTS)) {
    throw new Error(
      `Total payment does not fit a safe JavaScript number: ${expectedPayment.toString()}`
    );
  }

  console.log("=== Buy Ticket ===");
  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("Buyer:", buyer.toBase58());
  console.log("Round ID:", roundId.toString());
  console.log("Round PDA:", round.toBase58());
  console.log("Ticket PDA:", ticket.toBase58());
  console.log("Prize Vault:", prizeVault.toBase58());
  console.log("Quantity:", quantity);
  console.log("Ticket price:", roundBefore.ticketPrice.toString());
  console.log("Business payment:", businessPayment.toString());
  console.log("Ticket account kind:", ticketAccountKind);
  console.log("Rent minimum:", rentMinimum);
  console.log("Existing ticket lamports:", existingTicketLamports);
  console.log("Rent top-up:", rentTopUp);
  console.log("Total payment:", expectedPayment.toString());

  const paymentInstruction = anchor.web3.SystemProgram.transfer({
    fromPubkey: buyer,
    toPubkey: prizeVault,
    lamports: expectedPayment.toNumber(),
  });
  const buyInstruction = await program.methods
    .buyTicketV2(buyer, quantity)
    .accountsStrict({
      round,
      ticket,
      prizeVault,
      instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const transaction = new anchor.web3.Transaction();
  transaction.add(paymentInstruction);
  transaction.add(buyInstruction);

  const signature = await sendDevnetTransaction(provider, transaction);
  console.log("Transaction signature:", signature);

  const [roundAfter, ticketAfter, ticketInfoAfter, prizeVaultInfo] =
    await Promise.all([
      program.account.round.fetch(round, "confirmed"),
      program.account.ticket.fetch(ticket, "confirmed"),
      provider.connection.getAccountInfo(ticket, "confirmed"),
      provider.connection.getAccountInfo(prizeVault, "confirmed"),
    ]);

  if (!ticketAfter.user.equals(buyer)) {
    throw new Error("Ticket user does not match buyer");
  }

  if (!ticketAfter.roundId.eq(roundId)) {
    throw new Error("Ticket round ID does not match the active Round");
  }

  if (ticketAfter.quantity !== expectedQuantity) {
    throw new Error(
      `Ticket quantity mismatch: expected ${expectedQuantity}, got ${ticketAfter.quantity}`
    );
  }

  if (
    !roundAfter.salesProceeds.sub(roundBefore.salesProceeds).eq(businessPayment)
  ) {
    throw new Error(
      "Round sales proceeds did not increase by business payment"
    );
  }

  if (ticketInfoAfter === null || !ticketInfoAfter.owner.equals(programId)) {
    throw new Error("Ticket is not owned by the Lotto Program after purchase");
  }

  if (
    ticketAccountKind === "New" &&
    ticketInfoAfter.data.length !== ticketSpaceValue
  ) {
    throw new Error(
      "New Ticket account data length does not match TICKET_SPACE"
    );
  }

  if (prizeVaultInfo === null) {
    throw new Error(`Prize Vault is missing: ${prizeVault.toBase58()}`);
  }

  if (
    !prizeVaultInfo.owner.equals(anchor.web3.SystemProgram.programId) ||
    prizeVaultInfo.data.length !== 0
  ) {
    throw new Error("Prize Vault is not a zero-data System account");
  }

  console.log();
  console.log("=== Ticket After Purchase ===");
  console.log("Address:", ticket.toBase58());
  console.log("User:", ticketAfter.user.toBase58());
  console.log("Round ID:", ticketAfter.roundId.toString());
  console.log("Quantity:", ticketAfter.quantity);
  console.log("Outcome:", JSON.stringify(ticketAfter.outcome));
  console.log("Bump:", ticketAfter.bump);

  console.log();
  console.log("=== Round After Purchase ===");
  console.log("Sales proceeds:", roundAfter.salesProceeds.toString());

  console.log();
  console.log("=== Prize Vault After Purchase ===");
  console.log("Lamports:", prizeVaultInfo.lamports);
  console.log("Owner:", prizeVaultInfo.owner.toBase58());
  console.log("Data length:", prizeVaultInfo.data.length);
}
