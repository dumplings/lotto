use crate::constants::ROUND_SEED;
use crate::error::LottoError;
use crate::state::{Round, RoundStatus};
use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::vrf_callback;

#[vrf_callback]
#[derive(Accounts)]
pub struct ReceiveRandomness<'info> {
    #[account(
        mut,
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}

pub fn handle_receive_randomness(
    ctx: Context<ReceiveRandomness>,
    randomness: [u8; 32],
    binding: [u8; 32],
) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        round.status == RoundStatus::RandomnessPending,
        LottoError::RoundNotRandomnessPending,
    );
    require!(!round.randomness_ready, LottoError::RandomnessAlreadyReady,);
    require!(
        binding == round.randomness_binding,
        LottoError::RandomnessBindingMismatch,
    );

    let now = Clock::get()?.unix_timestamp;
    round.randomness = randomness;
    round.randomness_received_at = now;
    round.randomness_ready = true;

    Ok(())
}
