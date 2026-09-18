use crate::constants::{LOTTO_CONFIG_SEED, ROLLOVER_VAULT_SEED, TIER_COUNT};
use crate::error::LottoError;
use crate::state::LottoConfig;
use anchor_lang::prelude::*;

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct InitializeConfigArgs {
    pub ticket_price: u64,
    pub tier_thresholds: [u16; TIER_COUNT],
    pub tier_pool_bps: [u16; TIER_COUNT],
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + LottoConfig::INIT_SPACE,
        seeds = [LOTTO_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, LottoConfig>,

    /// CHECK: zero-data System Program account
    #[account(
        init,
        payer = authority,
        space = 0,
        owner = System::id(),
        seeds = [ROLLOVER_VAULT_SEED],
        bump
    )]
    pub rollover_vault: UncheckedAccount<'info>,

    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
    )]
    pub program: Program<'info, crate::program::Lotto>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ LottoError::UnauthorizedInitializer
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    args: InitializeConfigArgs,
) -> Result<()> {
    LottoConfig::validate_economic_params(
        args.ticket_price,
        &args.tier_thresholds,
        &args.tier_pool_bps,
    )?;

    let authority_key = ctx.accounts.authority.key();
    let config = &mut ctx.accounts.config;

    config.authority = authority_key;
    config.treasury = authority_key;
    config.next_round_id = 0;
    config.active_round_id = None;
    config.ticket_price = args.ticket_price;
    config.tier_thresholds = args.tier_thresholds;
    config.tier_pool_bps = args.tier_pool_bps;
    config.bump = ctx.bumps.config;

    Ok(())
}
