use crate::constants::{BPS_DENOMINATOR, LOTTO_CONFIG_SEED, ROUND_SEED};
use crate::error::LottoError;
use crate::state::{LottoConfig, PrizeTier, Round, RoundStatus};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FinalizeRegistration<'info> {
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

pub fn handle_finalize_registration(ctx: Context<FinalizeRegistration>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.status == RoundStatus::Registering,
        LottoError::RoundNotRegistering
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= round.registration_deadline,
        LottoError::RegistrationStillOpen
    );

    let prize_base = round
        .sales_proceeds
        .checked_add(round.rollover_in)
        .ok_or(LottoError::ArithmeticError)?;

    for tier in PrizeTier::ALL.iter().rev() {
        let tier_index = tier.index();
        let pool = prize_base
            .checked_mul(u64::from(round.tier_pool_bps[tier_index]))
            .ok_or(LottoError::ArithmeticError)?
            / u64::from(BPS_DENOMINATOR);
        let registered_units = round.registered_units[tier_index];
        round.prize_per_unit[tier_index] = if registered_units == 0 {
            0
        } else {
            pool / registered_units
        }
    }

    round.claim_deadline = now
        .checked_add(round.claim_duration_secs)
        .ok_or(LottoError::ArithmeticError)?;

    round.status = RoundStatus::Claiming;

    Ok(())
}
