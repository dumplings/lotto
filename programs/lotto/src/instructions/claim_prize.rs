use crate::constants::{LOTTO_CONFIG_SEED, PRIZE_VAULT_SEED, ROUND_SEED, TICKET_SEED};
use crate::error::LottoError;
use crate::state::{LottoConfig, PrizeTier, Round, RoundStatus, Ticket, TicketOutcome};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, LottoConfig>,

    #[account(
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
        constraint = Some(round.round_id) == config.active_round_id,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        close = treasury,
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

    /// CHECK: 奖池，纯钱账户
    #[account(
        mut,
        seeds = [
            PRIZE_VAULT_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump,
        owner = System::id(),
    )]
    pub prize_vault: UncheckedAccount<'info>,

    /// CHECK: 回收 rent
    #[account(
        mut,
        address = config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct PrizeClaimed {
    pub round_id: u64,
    pub user: Pubkey,
    pub tier: PrizeTier,
    pub quantity: u32,
    pub amount: u64,
}

pub fn handle_claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
    let round = &ctx.accounts.round;
    let ticket = &ctx.accounts.ticket;

    require!(
        round.status == RoundStatus::Claiming,
        LottoError::RoundNotClaiming,
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.claim_deadline, LottoError::ClaimClosed,);

    let tier = match ticket.outcome {
        TicketOutcome::Winner(tier) => tier,
        TicketOutcome::Unregistered => {
            return err!(LottoError::TicketNotWinner);
        }
    };

    let quantity = u64::from(ticket.quantity);
    let claim_amount = round.prize_per_unit[tier.index()]
        .checked_mul(quantity)
        .ok_or(LottoError::ArithmeticError)?;

    let round_id_bytes = round.round_id.to_le_bytes();
    let vault_bump = ctx.bumps.prize_vault;
    let bump_seed = [vault_bump];

    let vault_signer_seeds: &[&[u8]] = &[PRIZE_VAULT_SEED, round_id_bytes.as_ref(), &bump_seed];
    let signer_seeds = &[vault_signer_seeds];

    if claim_amount > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.prize_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            claim_amount,
        )?;
    }

    emit!(PrizeClaimed {
        round_id: round.round_id,
        user: ctx.accounts.user.key(),
        tier,
        quantity: ticket.quantity,
        amount: claim_amount,
    });

    Ok(())
}
