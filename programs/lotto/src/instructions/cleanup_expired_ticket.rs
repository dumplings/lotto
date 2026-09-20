use crate::constants::{ROUND_SEED, TICKET_SEED};
use crate::error::LottoError;
use crate::state::{Round, RoundStatus, Ticket, TicketOutcome};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CleanupExpiredTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [
            TICKET_SEED,
            ticket.round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump = ticket.bump,
        has_one = user,
    )]
    pub ticket: Account<'info, Ticket>,

    /// CHECK: 有种可能此刻round不存在了，所以通过seeds+bump推理生成理论PDA
    #[account(
        seeds = [
            ROUND_SEED,
            ticket.round_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub round: UncheckedAccount<'info>,
}

pub fn handle_cleanup_expired_ticket(ctx: Context<CleanupExpiredTicket>) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    let round_info = ctx.accounts.round.to_account_info();

    // round 还在
    if round_info.owner == &crate::ID {
        let now = Clock::get()?.unix_timestamp;
        let data = round_info.try_borrow_data()?;
        let mut data_slice: &[u8] = &data;

        let round = Round::try_deserialize(&mut data_slice)?;
        require!(
            round.round_id == ticket.round_id,
            LottoError::RoundCleanupStateInvalid,
        );

        match (ticket.outcome, round.status) {
            (TicketOutcome::Unregistered, RoundStatus::Registering) => {
                require!(
                    now >= round.registration_deadline,
                    LottoError::RoundCleanupStateInvalid,
                );
            }
            (TicketOutcome::Unregistered, RoundStatus::Claiming) => {}
            (TicketOutcome::Winner(_), RoundStatus::Claiming) => {
                require!(now >= round.claim_deadline, LottoError::ClaimStillOpen,);
            }
            _ => return err!(LottoError::RoundCleanupStateInvalid),
        }

        return Ok(());
    }

    // round 不存在了，已经被关闭了
    if round_info.owner == &system_program::ID && round_info.data_len() == 0 {
        return Ok(());
    }

    // round PDA 地址是对的，但是账户状态不对
    err!(LottoError::RoundCleanupStateInvalid)
}
