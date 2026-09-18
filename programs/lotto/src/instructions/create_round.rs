use crate::constants::{
    CLAIM_DURATION_SEC, LOTTO_CONFIG_SEED, PRIZE_VAULT_SEED, REGISTRATION_DURATION_SEC,
    ROLLOVER_VAULT_SEED, ROUND_SEED, SALE_DURATION_SEC, TIER_COUNT,
};
use crate::error::LottoError;
use crate::state::{LottoConfig, Round, RoundStatus};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, LottoConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, config.next_round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: zero-data，对应指定round_id的奖池
    #[account(
        init,
        payer = authority,
        space = 0,
        owner = System::id(),
        seeds = [PRIZE_VAULT_SEED, config.next_round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub prize_vault: UncheckedAccount<'info>,

    /// CHECK: 参考initialize_config
    #[account(
        mut,
        seeds = [ROLLOVER_VAULT_SEED],
        bump,
        owner = System::id(),
    )]
    pub rollover_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_round(ctx: Context<CreateRound>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        config.active_round_id.is_none(),
        LottoError::ActiveRoundExists
    );

    let round_id = config.next_round_id;
    let next_round_id = round_id.checked_add(1).ok_or(LottoError::ArithmeticError)?;

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.status = RoundStatus::Selling;

    let now = Clock::get()?.unix_timestamp;
    round.randomness_binding = [0; 32];
    round.randomness_requested_at = 0;
    round.randomness_received_at = 0;
    round.randomness_ready = false;
    round.randomness = [0; 32];

    round.sale_duration_secs = SALE_DURATION_SEC;
    round.registration_duration_secs = REGISTRATION_DURATION_SEC;
    round.claim_duration_secs = CLAIM_DURATION_SEC;
    round.sale_deadline = now
        .checked_add(SALE_DURATION_SEC)
        .ok_or(LottoError::ArithmeticError)?;
    round.registration_deadline = 0;
    round.claim_deadline = 0;

    round.ticket_price = config.ticket_price;
    round.tier_thresholds = config.tier_thresholds;
    round.tier_pool_bps = config.tier_pool_bps;

    round.registered_units = [0; TIER_COUNT];
    round.prize_per_unit = [0; TIER_COUNT];
    round.sales_proceeds = 0;

    let rollover_raw_balance = ctx.accounts.rollover_vault.to_account_info().lamports();
    let rollover_rent_reserve = Rent::get()?.minimum_balance(0);

    let rollover_amount = rollover_raw_balance
        .checked_sub(rollover_rent_reserve)
        .ok_or(LottoError::ArithmeticError)?;

    if rollover_amount > 0 {
        let bump_seed = [ctx.bumps.rollover_vault];
        let rollover_signer_seeds: &[&[u8]] = &[ROLLOVER_VAULT_SEED, &bump_seed];
        let signer_seeds = &[rollover_signer_seeds];
        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.rollover_vault.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
        };
        let cpi_context = CpiContext::new_with_signer(System::id(), cpi_accounts, signer_seeds);
        system_program::transfer(cpi_context, rollover_amount)?;
    }
    round.rollover_in = rollover_amount;
    let config = &mut ctx.accounts.config;
    config.active_round_id = Some(round_id);
    config.next_round_id = next_round_id;

    round.bump = ctx.bumps.round;

    msg!("Creating round {}", round_id);

    Ok(())
}
