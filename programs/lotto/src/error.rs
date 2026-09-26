use anchor_lang::prelude::*;

#[error_code]
pub enum LottoError {
    #[msg("TicketPrice 必须大于 0")]
    InvalidTicketPrice,

    #[msg("TierThresholds 必须严格递增，且每项位于 1..=256")]
    InvalidTierThresholds,

    #[msg("TierPoolBPS 总和不能超过 10,000")]
    InvalidTierPoolBps,

    #[msg("当前 signer 不是 Program Upgrade Authority，不能初始化 Config")]
    UnauthorizedInitializer,

    #[msg("当前已有激活中的 Round")]
    ActiveRoundExists,

    #[msg("算术运算失败")]
    ArithmeticError,

    #[msg("Ticket quantity 必须大于 0")]
    InvalidTicketQuantity,

    #[msg("Round 当前不处于 Selling 状态")]
    RoundNotSelling,

    #[msg("售票窗口已关闭")]
    SaleClosed,

    #[msg("售票窗口仍未结束")]
    SaleStillOpen,

    #[msg("Randomness 已经就绪")]
    RandomnessAlreadyReady,

    #[msg("Round 当前不处于 RandomnessPending 状态")]
    RoundNotRandomnessPending,

    #[msg("Randomness 尚未就绪")]
    RandomnessNotReady,

    #[msg("Randomness callback binding 与当前 Round 不匹配")]
    RandomnessBindingMismatch,

    #[msg("Round 当前不处于 Registering 状态")]
    RoundNotRegistering,

    #[msg("登记窗口已关闭")]
    RegistrationClosed,

    #[msg("Ticket 已完成登记，不能重复登记")]
    TicketAlreadyRegistered,

    #[msg("登记窗口仍未结束")]
    RegistrationStillOpen,

    #[msg("Round 当前不处于 Claiming 状态")]
    RoundNotClaiming,

    #[msg("兑奖窗口已关闭")]
    ClaimClosed,

    #[msg("Ticket 不是已登记的中奖 Ticket")]
    TicketNotWinner,

    #[msg("兑奖窗口仍未结束")]
    ClaimStillOpen,

    #[msg("Round account 既不是有效的 live Round，也不是有效的 closed Round")]
    RoundCleanupStateInvalid,

    #[msg("上一条 instruction 不是有效的购票付款 instruction")]
    InvalidPaymentInstruction,

    #[msg("付款来源与 buyer 不匹配")]
    PaymentSourceMismatch,

    #[msg("付款目标与 Prize Vault 不匹配")]
    PaymentDestinationMismatch,

    #[msg("付款金额与当前应付金额不匹配")]
    PaymentAmountMismatch,

    #[msg("Ticket account 当前状态无效")]
    InvalidTicketAccountState,
}
