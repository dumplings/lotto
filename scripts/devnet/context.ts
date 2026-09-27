import os from "node:os";
import path from "node:path";
import * as anchor from "@anchor-lang/core";

import type { Lotto } from "../../target/types/lotto";

const { PublicKey } = anchor.web3;

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

const DEFAULT_WALLET_PATH = path.join(
  os.homedir(),
  ".config",
  "solana",
  "id.json"
);

// Solana runtime constant, not part of the Lotto protocol.
const UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

async function loadRuntimeIdl() {
  // @ts-ignore -- Node 24 supports runtime JSON imports with import attributes.
  const idlModule = await import("../../target/idl/lotto.json", {
    with: { type: "json" },
  });

  return idlModule.default as unknown as Lotto;
}

function createProvider(): anchor.AnchorProvider {
  process.env.ANCHOR_PROVIDER_URL ??= DEFAULT_RPC_URL;
  process.env.ANCHOR_WALLET ??= DEFAULT_WALLET_PATH;

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  return provider;
}

export function u64ToLittleEndian(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

export async function sendDevnetTransaction(
  provider: anchor.AnchorProvider,
  transaction: anchor.web3.Transaction
): Promise<string> {
  const {
    context,
    value: { blockhash, lastValidBlockHeight },
  } = await provider.connection.getLatestBlockhashAndContext("confirmed");

  transaction.feePayer = provider.wallet.publicKey;
  transaction.recentBlockhash = blockhash;

  const signedTransaction = await provider.wallet.signTransaction(transaction);
  const signature = await provider.connection.sendRawTransaction(
    signedTransaction.serialize(),
    {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      minContextSlot: context.slot,
    }
  );
  const confirmation = await provider.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err !== null) {
    throw new Error(
      `Transaction ${signature} failed: ${JSON.stringify(
        confirmation.value.err
      )}`
    );
  }

  return signature;
}

export async function createDevnetContext() {
  const runtimeIdl = await loadRuntimeIdl();

  function findInstruction(name: string) {
    const instruction = runtimeIdl.instructions.find(
      (candidate) => candidate.name === name
    );

    if (instruction === undefined) {
      throw new Error(`Instruction not found in IDL: ${name}`);
    }

    return instruction;
  }

  function deriveConstPdaFromIdl(
    instructionName: string,
    accountName: string,
    programId: anchor.web3.PublicKey
  ): [anchor.web3.PublicKey, number] {
    const instruction = findInstruction(instructionName);
    const account = instruction.accounts.find(
      (candidate) => candidate.name === accountName
    );

    if (account === undefined) {
      throw new Error(
        `Account not found in IDL: ${instructionName}.${accountName}`
      );
    }

    if (!("pda" in account) || account.pda === undefined) {
      throw new Error(
        `PDA metadata not found in IDL: ${instructionName}.${accountName}`
      );
    }

    const seeds = account.pda.seeds.map((seed) => {
      if (
        seed.kind !== "const" ||
        !("value" in seed) ||
        !Array.isArray(seed.value)
      ) {
        throw new Error(
          `${instructionName}.${accountName} contains a non-const PDA seed`
        );
      }

      return Buffer.from(seed.value);
    });

    return PublicKey.findProgramAddressSync(seeds, programId);
  }

  function getInstructionAccountConstSeed(
    instructionName: string,
    accountName: string
  ): Buffer {
    const instruction = findInstruction(instructionName);
    const account = instruction.accounts.find(
      (candidate) => candidate.name === accountName
    );

    if (account === undefined) {
      throw new Error(
        `Account not found in IDL: ${instructionName}.${accountName}`
      );
    }

    if (!("pda" in account) || account.pda === undefined) {
      throw new Error(
        `PDA metadata not found in IDL: ${instructionName}.${accountName}`
      );
    }

    const constSeeds = account.pda.seeds.filter(
      (seed) =>
        seed.kind === "const" && "value" in seed && Array.isArray(seed.value)
    );

    if (constSeeds.length !== 1 || !("value" in constSeeds[0])) {
      throw new Error(
        `Expected exactly one const PDA seed: ${instructionName}.${accountName}`
      );
    }

    return Buffer.from(constSeeds[0].value);
  }

  function getInstructionAccountAddress(
    instructionName: string,
    accountName: string
  ): anchor.web3.PublicKey {
    const instruction = findInstruction(instructionName);
    const account = instruction.accounts.find(
      (candidate) => candidate.name === accountName
    );

    if (account === undefined) {
      throw new Error(
        `Account not found in IDL: ${instructionName}.${accountName}`
      );
    }

    if (!("address" in account) || typeof account.address !== "string") {
      throw new Error(
        `Fixed address not found in IDL: ${instructionName}.${accountName}`
      );
    }

    return new PublicKey(account.address);
  }

  function getIdlConstant(name: string) {
    const constant = runtimeIdl.constants.find(
      (candidate) => candidate.name === name
    );

    if (constant === undefined) {
      throw new Error(`Constant not found in IDL: ${name}`);
    }

    return constant;
  }

  const provider = createProvider();
  const program = new anchor.Program<Lotto>(runtimeIdl, provider);
  const programId = program.programId;

  const [config, configBump] = deriveConstPdaFromIdl(
    "initialize_config",
    "config",
    programId
  );
  const [rolloverVault, rolloverVaultBump] = deriveConstPdaFromIdl(
    "initialize_config",
    "rollover_vault",
    programId
  );
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    UPGRADEABLE_LOADER_ID
  );

  return {
    provider,
    program,
    programId,
    programData,
    config,
    configBump,
    rolloverVault,
    rolloverVaultBump,
    getInstructionAccountConstSeed,
    getInstructionAccountAddress,
    ticketSpace: getIdlConstant("TICKET_SPACE"),
  };
}

export { anchor };
