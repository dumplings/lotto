use crate::constants::{PRIZE_VAULT_SEED, ROUND_SEED, TICKET_SEED};
use crate::error::LottoError;
use crate::state::{Round, RoundStatus, Ticket, TicketOutcome};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction::SystemInstruction;
use anchor_lang::system_program;
use anchor_lang::system_program::System;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

#[constant]
pub const TICKET_SPACE: u64 = (Ticket::DISCRIMINATOR.len() + Ticket::INIT_SPACE) as u64;

#[derive(Accounts)]
#[instruction(buyer: Pubkey)]
pub struct BuyTicketV2<'info> {
    #[account(
        mut,
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK:
    /// Canonical Ticket PDA.
    /// May be an uninitialized System-owned account or an existing Lotto-owned Ticket.
    #[account(
        mut,
        seeds = [
            TICKET_SEED,
            round.round_id.to_le_bytes().as_ref(),
            buyer.as_ref(),
        ],
        bump,
    )]
    pub ticket: UncheckedAccount<'info>,

    /// CHECK:
    /// Canonical System-owned Prize Vault PDA.
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

    /// CHECK:
    /// Canonical Instructions Sysvar.
    #[account(
        address = solana_instructions_sysvar::ID,
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, Copy)]
enum TicketAccountKind {
    New,
    Existing,
}

pub fn handle_buy_ticket_v2(ctx: Context<BuyTicketV2>, buyer: Pubkey, quantity: u32) -> Result<()> {
    // Payment proof:
    // the immediately preceding top-level instruction must be a canonical
    // SystemProgram::transfer from buyer to this Round's Prize Vault.
    let paid_lamports = validate_payment_instruction(
        &ctx.accounts.instructions_sysvar,
        buyer,
        ctx.accounts.prize_vault.key(),
    )?;

    let ticket_info = ctx.accounts.ticket.to_account_info();
    let ticket_kind = classify_ticket_account(&ticket_info)?;

    require!(quantity > 0, LottoError::InvalidTicketQuantity);

    let round = &ctx.accounts.round;

    require!(
        round.status == RoundStatus::Selling,
        LottoError::RoundNotSelling,
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < round.sale_deadline, LottoError::SaleClosed);

    let round_id = round.round_id;

    let business_payment = round
        .ticket_price
        .checked_mul(u64::from(quantity))
        .ok_or(LottoError::ArithmeticError)?;

    let rent_top_up = match ticket_kind {
        TicketAccountKind::New => {
            let rent_minimum = Rent::get()?.minimum_balance(TICKET_SPACE as usize);
            rent_minimum.saturating_sub(ticket_info.lamports())
        }
        TicketAccountKind::Existing => 0,
    };

    let expected_payment = business_payment
        .checked_add(rent_top_up)
        .ok_or(LottoError::ArithmeticError)?;

    require!(
        paid_lamports == expected_payment,
        LottoError::PaymentAmountMismatch,
    );

    match ticket_kind {
        TicketAccountKind::New => initialize_ticket(
            &ctx.accounts.ticket,
            &ctx.accounts.prize_vault,
            buyer,
            round_id,
            quantity,
            ctx.bumps.ticket,
            ctx.bumps.prize_vault,
            rent_top_up,
        )?,

        TicketAccountKind::Existing => update_existing_ticket(
            &ctx.accounts.ticket,
            buyer,
            round_id,
            quantity,
            ctx.bumps.ticket,
        )?,
    }

    let round = &mut ctx.accounts.round;
    round.sales_proceeds = round
        .sales_proceeds
        .checked_add(business_payment)
        .ok_or(LottoError::ArithmeticError)?;

    Ok(())
}

fn validate_payment_instruction(
    instructions_sysvar: &UncheckedAccount,
    buyer: Pubkey,
    prize_vault: Pubkey,
) -> Result<u64> {
    let instructions_info = instructions_sysvar.to_account_info();

    let current_index = load_current_index_checked(&instructions_info)
        .map_err(|_| LottoError::InvalidPaymentInstruction)?;

    let previous_index = current_index
        .checked_sub(1)
        .ok_or(LottoError::InvalidPaymentInstruction)?;

    let previous_instruction =
        load_instruction_at_checked(previous_index as usize, &instructions_info)
            .map_err(|_| LottoError::InvalidPaymentInstruction)?;

    require!(
        previous_instruction.program_id == System::id(),
        LottoError::InvalidPaymentInstruction,
    );

    let system_instruction: SystemInstruction = bincode::deserialize(&previous_instruction.data)
        .map_err(|_| LottoError::InvalidPaymentInstruction)?;

    let lamports = match system_instruction {
        SystemInstruction::Transfer { lamports } => lamports,
        _ => return err!(LottoError::InvalidPaymentInstruction),
    };

    // bincode::deserialize may accept valid data followed by trailing bytes.
    // Re-serialize the decoded Transfer and require exact byte equality.
    let canonical_data = bincode::serialize(&SystemInstruction::Transfer { lamports })
        .map_err(|_| LottoError::InvalidPaymentInstruction)?;

    require!(
        previous_instruction.data.as_slice() == canonical_data.as_slice(),
        LottoError::InvalidPaymentInstruction,
    );

    require!(
        previous_instruction.accounts.len() == 2,
        LottoError::InvalidPaymentInstruction,
    );

    let source = &previous_instruction.accounts[0];
    let destination = &previous_instruction.accounts[1];

    require!(source.pubkey == buyer, LottoError::PaymentSourceMismatch,);

    require!(
        destination.pubkey == prize_vault,
        LottoError::PaymentDestinationMismatch,
    );

    Ok(lamports)
}

fn classify_ticket_account(ticket_info: &AccountInfo) -> Result<TicketAccountKind> {
    if ticket_info.owner == &System::id() && ticket_info.data_is_empty() {
        return Ok(TicketAccountKind::New);
    }

    if ticket_info.owner == &crate::ID {
        return Ok(TicketAccountKind::Existing);
    }

    err!(LottoError::InvalidTicketAccountState)
}

#[allow(clippy::too_many_arguments)]
fn initialize_ticket<'info>(
    ticket_account: &UncheckedAccount<'info>,
    prize_vault: &UncheckedAccount<'info>,
    buyer: Pubkey,
    round_id: u64,
    quantity: u32,
    ticket_bump: u8,
    prize_vault_bump: u8,
    rent_top_up: u64,
) -> Result<()> {
    let round_id_bytes = round_id.to_le_bytes();

    if rent_top_up > 0 {
        let vault_bump_seed = [prize_vault_bump];
        let vault_signer_seeds: &[&[u8]] =
            &[PRIZE_VAULT_SEED, round_id_bytes.as_ref(), &vault_bump_seed];
        let signer_seeds = &[vault_signer_seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                System::id(),
                system_program::Transfer {
                    from: prize_vault.to_account_info(),
                    to: ticket_account.to_account_info(),
                },
                signer_seeds,
            ),
            rent_top_up,
        )?;
    }

    let ticket_bump_seed = [ticket_bump];
    let ticket_signer_seeds: &[&[u8]] = &[
        TICKET_SEED,
        round_id_bytes.as_ref(),
        buyer.as_ref(),
        &ticket_bump_seed,
    ];
    let signer_seeds = &[ticket_signer_seeds];

    system_program::allocate(
        CpiContext::new_with_signer(
            System::id(),
            system_program::Allocate {
                account_to_allocate: ticket_account.to_account_info(),
            },
            signer_seeds,
        ),
        TICKET_SPACE as u64,
    )?;

    system_program::assign(
        CpiContext::new_with_signer(
            System::id(),
            system_program::Assign {
                account_to_assign: ticket_account.to_account_info(),
            },
            signer_seeds,
        ),
        &crate::ID,
    )?;

    let ticket = Ticket {
        user: buyer,
        round_id,
        quantity,
        outcome: TicketOutcome::Unregistered,
        bump: ticket_bump,
    };

    let ticket_info = ticket_account.to_account_info();
    let mut data = ticket_info.try_borrow_mut_data()?;
    ticket.try_serialize(&mut &mut data[..])?;

    Ok(())
}

fn update_existing_ticket(
    ticket_account: &UncheckedAccount,
    buyer: Pubkey,
    round_id: u64,
    quantity: u32,
    ticket_bump: u8,
) -> Result<()> {
    let ticket_info = ticket_account.to_account_info();

    let mut ticket = {
        let data = ticket_info.try_borrow_data()?;
        let mut data_slice: &[u8] = &data;

        Ticket::try_deserialize(&mut data_slice)
            .map_err(|_| LottoError::InvalidTicketAccountState)?
    };

    require!(ticket.user == buyer, LottoError::InvalidTicketAccountState,);

    require!(
        ticket.round_id == round_id,
        LottoError::InvalidTicketAccountState,
    );

    require!(
        ticket.bump == ticket_bump,
        LottoError::InvalidTicketAccountState,
    );

    ticket.quantity = ticket
        .quantity
        .checked_add(quantity)
        .ok_or(LottoError::ArithmeticError)?;

    let mut data = ticket_info.try_borrow_mut_data()?;
    ticket.try_serialize(&mut &mut data[..])?;

    Ok(())
}
