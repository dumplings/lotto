use crate::constants::{LOTTO_CONFIG_SEED, ROUND_SEED};
use crate::error::LottoError;
use crate::state::{LottoConfig, Round, RoundStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SettleRandomness<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, LottoConfig>,

    #[account(
        mut,
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
        constraint = Some(round.round_id) == config.active_round_id
    )]
    pub round: Account<'info, Round>,
}

pub fn handle_settle_randomness(ctx: Context<SettleRandomness>) -> Result<()> {
    let round = &mut ctx.accounts.round;

    require!(
        round.status == RoundStatus::RandomnessPending,
        LottoError::RoundNotRandomnessPending,
    );
    require!(round.randomness_ready, LottoError::RandomnessNotReady);

    let now = Clock::get()?.unix_timestamp;
    round.registration_deadline = now
        .checked_add(round.registration_duration_secs)
        .ok_or(LottoError::ArithmeticError)?;
    round.status = RoundStatus::Registering;

    Ok(())
}
