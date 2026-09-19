pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use crate::instructions::*;
use anchor_lang::prelude::*;

declare_id!("6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm");

#[program]
pub mod lotto {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        handle_update_config(ctx, args)
    }

    pub fn create_round(ctx: Context<CreateRound>) -> Result<()> {
        handle_create_round(ctx)
    }

    pub fn buy_ticket(ctx: Context<BuyTicket>, quantity: u32) -> Result<()> {
        handle_buy_ticket(ctx, quantity)
    }

    pub fn receive_randomness(
        ctx: Context<ReceiveRandomness>,
        randomness: [u8; 32],
        binding: [u8; 32],
    ) -> Result<()> {
        handle_receive_randomness(ctx, randomness, binding)
    }

    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        handle_request_randomness(ctx)
    }

    pub fn settle_randomness(ctx: Context<SettleRandomness>) -> Result<()> {
        handle_settle_randomness(ctx)
    }

    pub fn register_winner(ctx: Context<RegisterWinner>) -> Result<()> {
        handle_register_winner(ctx)
    }
}
