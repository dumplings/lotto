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
}
