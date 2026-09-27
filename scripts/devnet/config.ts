// @ts-ignore -- Node 24 executes TypeScript source and requires the .ts extension.
import { anchor, createDevnetContext } from "./context.ts";

const DEMO_CONFIG_ARGS = {
  ticketPrice: new anchor.BN(10_000_000),
  tierThresholds: [1, 2, 3] as [number, number, number],
  tierPoolBps: [3_334, 3_333, 3_333] as [number, number, number],
};

export async function status() {
  const {
    provider,
    programId,
    programData,
    config,
    configBump,
    rolloverVault,
    rolloverVaultBump,
    ticketSpace,
  } = await createDevnetContext();

  const [balance, programInfo, programDataInfo, configInfo, rolloverVaultInfo] =
    await Promise.all([
      provider.connection.getBalance(provider.wallet.publicKey),
      provider.connection.getAccountInfo(programId),
      provider.connection.getAccountInfo(programData),
      provider.connection.getAccountInfo(config),
      provider.connection.getAccountInfo(rolloverVault),
    ]);

  console.log("=== Devnet Environment ===");
  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("Operator:", provider.wallet.publicKey.toBase58());
  console.log("Balance:", balance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

  console.log();

  console.log("=== Lotto Program ===");
  console.log("Program ID:", programId.toBase58());
  console.log("Program exists:", programInfo !== null);

  if (programInfo !== null) {
    console.log("Program owner:", programInfo.owner.toBase58());
    console.log("Program executable:", programInfo.executable);
  }

  console.log();

  console.log("=== ProgramData ===");
  console.log("ProgramData:", programData.toBase58());
  console.log("ProgramData exists:", programDataInfo !== null);

  if (programDataInfo !== null) {
    console.log("ProgramData owner:", programDataInfo.owner.toBase58());
    console.log("ProgramData data length:", programDataInfo.data.length);
  }

  console.log();

  console.log("=== Config ===");
  console.log("Config PDA:", config.toBase58());
  console.log("Config bump:", configBump);
  console.log("Config exists:", configInfo !== null);

  console.log();

  console.log("=== Rollover Vault ===");
  console.log("Rollover Vault PDA:", rolloverVault.toBase58());
  console.log("Rollover Vault bump:", rolloverVaultBump);
  console.log("Rollover Vault exists:", rolloverVaultInfo !== null);

  console.log();

  console.log("=== IDL Constants ===");
  console.log(`TICKET_SPACE: ${ticketSpace.value} (${ticketSpace.type})`);
}

export async function initConfig() {
  const { provider, program, programId, programData, config, rolloverVault } =
    await createDevnetContext();

  const configInfo = await provider.connection.getAccountInfo(
    config,
    "confirmed"
  );

  if (configInfo !== null) {
    throw new Error(`Config already exists: ${config.toBase58()}`);
  }

  console.log("=== Initialize Config ===");
  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("Authority:", provider.wallet.publicKey.toBase58());
  console.log("Config:", config.toBase58());
  console.log("Rollover Vault:", rolloverVault.toBase58());
  console.log("Ticket price:", DEMO_CONFIG_ARGS.ticketPrice.toString());
  console.log("Tier thresholds:", DEMO_CONFIG_ARGS.tierThresholds);
  console.log("Tier pool BPS:", DEMO_CONFIG_ARGS.tierPoolBps);

  const initializeConfigCall = () =>
    program.methods.initializeConfig(DEMO_CONFIG_ARGS).accountsStrict({
      authority: provider.wallet.publicKey,
      config,
      rolloverVault,
      program: programId,
      programData,
      systemProgram: anchor.web3.SystemProgram.programId,
    });

  await initializeConfigCall().simulate({ commitment: "confirmed" });

  const signature = await initializeConfigCall().rpc({
    commitment: "confirmed",
  });
  console.log("Transaction signature:", signature);

  const [createdConfig, rolloverVaultInfo] = await Promise.all([
    program.account.lottoConfig.fetch(config, "confirmed"),
    provider.connection.getAccountInfo(rolloverVault, "confirmed"),
  ]);

  console.log();
  console.log("=== Config Created ===");
  console.log("Config address:", config.toBase58());
  console.log("Authority:", createdConfig.authority.toBase58());
  console.log("Treasury:", createdConfig.treasury.toBase58());
  console.log("Ticket price:", createdConfig.ticketPrice.toString());
  console.log("Tier thresholds:", createdConfig.tierThresholds);
  console.log("Tier pool BPS:", createdConfig.tierPoolBps);
  console.log("Next round ID:", createdConfig.nextRoundId.toString());
  console.log(
    "Active round ID:",
    createdConfig.activeRoundId === null
      ? "null"
      : createdConfig.activeRoundId.toString()
  );
  console.log("Bump:", createdConfig.bump);

  console.log();
  console.log("=== Rollover Vault Created ===");
  console.log("Address:", rolloverVault.toBase58());
  console.log("Exists:", rolloverVaultInfo !== null);

  if (rolloverVaultInfo !== null) {
    console.log("Owner:", rolloverVaultInfo.owner.toBase58());
    console.log("Lamports:", rolloverVaultInfo.lamports);
    console.log("Data length:", rolloverVaultInfo.data.length);
  }
}
