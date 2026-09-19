use crate::constants::{LOTTO_CONFIG_SEED, ROUND_SEED, VRF_QUEUE};
use crate::error::LottoError;
use crate::state::{LottoConfig, Round, RoundStatus};
use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
use solana_sha256_hasher::hashv;

const RANDOMNESS_BINDING_DOMAIN: &[u8] = b"solana_lotto:randomness:v1";

fn derive_randomness_binding(program_id: &Pubkey, round: &Pubkey) -> [u8; 32] {
    hashv(&[
        RANDOMNESS_BINDING_DOMAIN,
        program_id.as_ref(),
        round.as_ref(),
    ])
    .to_bytes()
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    #[account(mut)]
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

    /// CHECK: 根据构建环境，可变的 MagicBlock VRF queue
    #[account(
        mut,
        address = VRF_QUEUE,
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

pub fn handle_request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
    let round = &ctx.accounts.round;

    require!(
        round.status == RoundStatus::Selling,
        LottoError::RoundNotSelling,
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.sale_deadline, LottoError::SaleStillOpen);

    let round_key = ctx.accounts.round.key();
    let binding = derive_randomness_binding(&crate::ID, &round_key);

    let request_ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.authority.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::ReceiveRandomness::DISCRIMINATOR.to_vec(),
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: round_key,
            is_signer: false,
            is_writable: true,
        }]),
        caller_seed: binding,
        callback_args: Some(binding.to_vec()),
    });
    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.authority.to_account_info(), &request_ix)?;

    let round = &mut ctx.accounts.round;
    round.randomness_binding = binding;
    round.randomness_requested_at = now;
    round.status = RoundStatus::RandomnessPending;

    msg!("Randomness binding: {:?}", binding);
    Ok(())
}
