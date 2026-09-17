use crate::constants::{LOTTO_CONFIG_SEED, TIER_COUNT};
use crate::state::LottoConfig;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateConfigArgs {
    pub ticket_price: u64,
    pub tier_thresholds: [u16; TIER_COUNT],
    pub tier_pool_bps: [u16; TIER_COUNT],
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, LottoConfig>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    LottoConfig::validate_economic_params(
        args.ticket_price,
        &args.tier_thresholds,
        &args.tier_pool_bps,
    )?;

    let config = &mut ctx.accounts.config;

    config.ticket_price = args.ticket_price;
    config.tier_thresholds = args.tier_thresholds;
    config.tier_pool_bps = args.tier_pool_bps;

    Ok(())
}
