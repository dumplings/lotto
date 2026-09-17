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
}
