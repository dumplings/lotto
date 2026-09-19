use anchor_lang::prelude::*;

#[error_code]
pub enum LottoError {
    #[msg("TicketPrice 需大于 0")]
    InvalidTicketPrice,
    #[msg("TierThresholds 需递增且处于 1..256")]
    InvalidTierThresholds,
    #[msg("TierPoolBPS 总和不能大于 10,000")]
    InvalidTierPoolBps,
    #[msg("当前 signer 不是 Program upgrade authority，无权初始化 Config")]
    UnauthorizedInitializer,
    #[msg("存在已激活 Round")]
    ActiveRoundExists,
    #[msg("Checked arithmetic operation failed")]
    ArithmeticError,
    #[msg("Ticket quantity 需大于 0")]
    InvalidTicketQuantity,
    #[msg("Round is not in Selling state")]
    RoundNotSelling,
    #[msg("售票已关闭")]
    SaleClosed,
    #[msg("当前仍处于销售期")]
    SaleStillOpen,
    #[msg("Randomness 状态已就位")]
    RandomnessAlreadyReady,
    #[msg("Round is not waiting for randomness")]
    RoundNotRandomnessPending,
    #[msg("Randomness has not been received yet")]
    RandomnessNotReady,
    #[msg("Randomness callback binding does not match the round")]
    RandomnessBindingMismatch,
    #[msg("Round is not in registration phase")]
    RoundNotRegistering,
    #[msg("Registration window is closed")]
    RegistrationClosed,
    #[msg("Ticket has already been registered")]
    TicketAlreadyRegistered,
}
