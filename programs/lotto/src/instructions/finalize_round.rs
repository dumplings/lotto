use crate::constants::{LOTTO_CONFIG_SEED, PRIZE_VAULT_SEED, ROLLOVER_VAULT_SEED, ROUND_SEED};
use crate::error::LottoError;
use crate::state::{LottoConfig, Round, RoundStatus};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [LOTTO_CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, LottoConfig>,

    #[account(
        mut,
        close = treasury,
        seeds = [
            ROUND_SEED,
            round.round_id.to_le_bytes().as_ref(),
        ],
        bump = round.bump,
        constraint = Some(round.round_id) == config.active_round_id
    )]
    pub round: Account<'info, Round>,

    /// CHECK: 对应 round 的奖池
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

    /// CHECK: 奖金回收池
    #[account(
        mut,
        seeds = [ROLLOVER_VAULT_SEED],
        bump,
        owner = System::id(),
    )]
    pub rollover_vault: UncheckedAccount<'info>,

    /// CHECK: 回收 rent
    #[account(
        mut,
        address = config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RoundFinalized {
    pub round_id: u64,
    pub rollover_out: u64,
}

pub fn handle_finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
    let round = &ctx.accounts.round;

    let now = Clock::get()?.unix_timestamp;
    require!(
        round.status == RoundStatus::Claiming,
        LottoError::RoundNotClaiming,
    );
    require!(now >= round.claim_deadline, LottoError::ClaimStillOpen);

    let rent_reserve = Rent::get()?.minimum_balance(0);
    let vault_balance = ctx.accounts.prize_vault.lamports();
    let rollover_out = vault_balance
        .checked_sub(rent_reserve)
        .ok_or(LottoError::ArithmeticError)?;

    let round_id_bytes = ctx.accounts.round.round_id.to_le_bytes();
    let vault_bump = ctx.bumps.prize_vault;
    let bump_seed = [vault_bump];

    let vault_signer_seeds: &[&[u8]] = &[PRIZE_VAULT_SEED, round_id_bytes.as_ref(), &bump_seed];
    let signer_seeds = &[vault_signer_seeds];

    if rollover_out > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.prize_vault.to_account_info(),
                    to: ctx.accounts.rollover_vault.to_account_info(),
                },
                signer_seeds,
            ),
            rollover_out,
        )?;
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.prize_vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            signer_seeds,
        ),
        rent_reserve,
    )?;

    emit!(RoundFinalized {
        round_id: round.round_id,
        rollover_out,
    });

    let config = &mut ctx.accounts.config;
    config.active_round_id = None;

    Ok(())
}
