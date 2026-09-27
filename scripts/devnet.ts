// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { initConfig, status } from "./devnet/config.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { createRound } from "./devnet/round.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { buyTicket } from "./devnet/ticket.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as randomnessCommands from "./devnet/randomness.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { registerWinner } from "./devnet/registration.ts";
// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import * as finalizationCommands from "./devnet/finalization.ts";

const { randomnessStatus, requestRandomness, settleRandomness } =
  randomnessCommands;
const { finalizeRegistration, finalizeRound, roundStatus } =
  finalizationCommands;

const U32_MAX = 0xffff_ffff;

function parseQuantity(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error("Quantity must be a decimal positive integer");
  }

  const quantity = Number(value);

  if (!Number.isSafeInteger(quantity) || quantity === 0 || quantity > U32_MAX) {
    throw new Error(`Quantity must be in the range 1..=${U32_MAX}`);
  }

  return quantity;
}

function printUsage() {
  console.log("Usage:");
  console.log("  pnpm devnet <command>");
  console.log();
  console.log("Commands:");
  console.log("  status");
  console.log("  init-config");
  console.log("  create-round");
  console.log("  buy-ticket <quantity>");
  console.log("  randomness-status");
  console.log("  request-randomness");
  console.log("  settle-randomness");
  console.log("  register-winner");
  console.log("  round-status");
  console.log("  finalize-registration");
  console.log("  finalize-round");
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "status":
      await status();
      return;

    case "init-config":
      await initConfig();
      return;

    case "create-round":
      await createRound();
      return;

    case "buy-ticket":
      await buyTicket(parseQuantity(process.argv[3]));
      return;

    case "randomness-status":
      await randomnessStatus();
      return;

    case "request-randomness":
      await requestRandomness();
      return;

    case "settle-randomness":
      await settleRandomness();
      return;

    case "register-winner":
      await registerWinner();
      return;

    case "round-status":
      await roundStatus();
      return;

    case "finalize-registration":
      await finalizeRegistration();
      return;

    case "finalize-round":
      await finalizeRound();
      return;

    default:
      printUsage();
      process.exitCode = 1;
  }
}

(async function () {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
