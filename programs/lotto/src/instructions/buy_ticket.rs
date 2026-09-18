use crate::constants::{PRIZE_VAULT_SEED, ROUND_SEED, TICKET_SEED};
use crate::error::LottoError;
use crate::state::{Round, RoundStatus, Ticket, TicketOutcome};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct BuyTicket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Ticket::INIT_SPACE,
        seeds = [
            TICKET_SEED,
            round.round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
        ],
        bump,
    )]
    pub ticket: Account<'info, Ticket>,

    /// CHECK: 参考 initialize_config
    #[account(
        mut,
        seeds = [PRIZE_VAULT_SEED, round.round_id.to_le_bytes().as_ref()],
        bump,
        owner = System::id(),
    )]
    pub prize_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_buy_ticket(ctx: Context<BuyTicket>, quantity: u32) -> Result<()> {
    require!(quantity > 0, LottoError::InvalidTicketQuantity);
    let round = &mut ctx.accounts.round;
    require!(
        round.status == RoundStatus::Selling,
        LottoError::RoundNotSelling,
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.sale_deadline, LottoError::SaleClosed);

    let payment = round
        .ticket_price
        .checked_mul(u64::from(quantity))
        .ok_or(LottoError::ArithmeticError)?;

    let ticket = &mut ctx.accounts.ticket;
    let is_new_ticket = ticket.quantity == 0;

    if is_new_ticket {
        ticket.user = ctx.accounts.user.key();
        ticket.round_id = round.round_id;
        ticket.outcome = TicketOutcome::Unregistered;
        ticket.bump = ctx.bumps.ticket;
    }
    ticket.quantity = ticket
        .quantity
        .checked_add(quantity)
        .ok_or(LottoError::ArithmeticError)?;
    round.sales_proceeds = round
        .sales_proceeds
        .checked_add(payment)
        .ok_or(LottoError::ArithmeticError)?;
    let cpi_accounts = system_program::Transfer {
        from: ctx.accounts.user.to_account_info(),
        to: ctx.accounts.prize_vault.to_account_info(),
    };
    let cpi_context = CpiContext::new(System::id(), cpi_accounts);
    system_program::transfer(cpi_context, payment)?;

    Ok(())
}
