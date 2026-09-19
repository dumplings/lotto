use crate::constants::{LOTTO_CONFIG_SEED, ROUND_SEED, TICKET_SEED, TIER_COUNT};
use crate::error::LottoError;
use crate::state::{LottoConfig, PrizeTier, Round, RoundStatus, Ticket, TicketOutcome};
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

const TICKET_RANDOMNESS_DOMAIN: &[u8] = b"solana_lotto:ticket:v1";

fn count_leading_zero_bits(bytes: &[u8; 32]) -> u16 {
    let mut total = 0u16;
    for byte in bytes {
        if *byte == 0 {
            total += 8;
        } else {
            total += byte.leading_zeros() as u16;
            break;
        }
    }
    total
}

fn determine_prize_tier(
    randomness: &[u8; 32],
    ticket_key: &Pubkey,
    thresholds: &[u16; TIER_COUNT],
) -> Option<PrizeTier> {
    let hash = hashv(&[TICKET_RANDOMNESS_DOMAIN, randomness, ticket_key.as_ref()]).to_bytes();

    let score = count_leading_zero_bits(&hash);

    for tier in [PrizeTier::Tier2, PrizeTier::Tier1, PrizeTier::Tier0] {
        if score >= thresholds[tier.index()] {
            return Some(tier);
        }
    }
    None
}

#[derive(Accounts)]
pub struct RegisterWinner<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [
            TICKET_SEED,
            round.round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump = ticket.bump,
        has_one = user,
        constraint = ticket.round_id == round.round_id,
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, LottoConfig>,

    /// CHECK: 回收 rent 账户
    #[account(
        mut,
        address = config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,
}

pub fn handle_register_winner(ctx: Context<RegisterWinner>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let ticket = &mut ctx.accounts.ticket;

    require!(
        round.status == RoundStatus::Registering,
        LottoError::RoundNotRegistering,
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < round.registration_deadline,
        LottoError::RegistrationClosed
    );
    require!(
        ticket.outcome == TicketOutcome::Unregistered,
        LottoError::TicketAlreadyRegistered,
    );

    let ticket_key = ticket.key();
    let prize_tier = determine_prize_tier(&round.randomness, &ticket_key, &round.tier_thresholds);

    match prize_tier {
        Some(tier) => {
            let tier_index = tier.index();
            round.registered_units[tier_index] = round.registered_units[tier_index]
                .checked_add(u64::from(ticket.quantity))
                .ok_or(LottoError::ArithmeticError)?;
            ticket.outcome = TicketOutcome::Winner(tier);
        }
        None => {
            ticket.close(ctx.accounts.treasury.to_account_info())?;
        }
    }

    Ok(())
}
