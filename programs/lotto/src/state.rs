use crate::constants::{BPS_DENOMINATOR, MAX_LEADING_ZERO_BITS, TIER_COUNT};
use crate::error::LottoError;
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct LottoConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub next_round_id: u64,
    pub active_round_id: Option<u64>,
    pub ticket_price: u64,
    pub tier_thresholds: [u16; TIER_COUNT], // 判断中奖的阈值，分别对应三/二/一等奖
    pub tier_pool_bps: [u16; TIER_COUNT],   // 基点，总奖池占比
    pub bump: u8,
}

impl LottoConfig {
    pub fn validate_economic_params(
        ticket_price: u64,
        tier_thresholds: &[u16; TIER_COUNT],
        tier_pool_bps: &[u16; TIER_COUNT],
    ) -> Result<()> {
        require!(ticket_price > 0, LottoError::InvalidTicketPrice);

        let thresholds_are_valid = tier_thresholds[0] > 0
            && tier_thresholds
                .iter()
                .all(|threshold| *threshold <= MAX_LEADING_ZERO_BITS)
            && tier_thresholds.windows(2).all(|pair| pair[0] < pair[1]);
        require!(thresholds_are_valid, LottoError::InvalidTierThresholds);

        let total_bps: u32 = tier_pool_bps.iter().map(|bps| u32::from(*bps)).sum();
        require!(total_bps <= BPS_DENOMINATOR, LottoError::InvalidTierPoolBps);

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Debug, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    Selling,
    RandomnessPending,
    Registering,
    Claiming,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Debug, PartialEq, Eq, InitSpace)]
pub enum PrizeTier {
    Tier0,
    Tier1,
    Tier2,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub status: RoundStatus,

    pub randomness_binding: [u8; 32],
    pub randomness_requested_at: i64,
    pub randomness_received_at: i64,
    pub randomness_ready: bool,
    pub randomness: [u8; 32],

    pub sale_duration_secs: i64,
    pub registration_duration_secs: i64,
    pub claim_duration_secs: i64,

    pub sale_deadline: i64,
    pub registration_deadline: i64,
    pub claim_deadline: i64,

    pub ticket_price: u64,
    pub tier_thresholds: [u16; TIER_COUNT],
    pub tier_pool_bps: [u16; TIER_COUNT],

    pub registered_units: [u64; TIER_COUNT], // 已登记数
    pub prize_per_unit: [u64; TIER_COUNT],

    pub sales_proceeds: u64, // 本期售卖账本
    pub rollover_in: u64,

    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Debug, PartialEq, Eq, InitSpace)]
pub enum TicketOutcome {
    Unregistered,
    Winner(PrizeTier),
}

#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub user: Pubkey,
    pub round_id: u64,
    pub quantity: u32,
    pub outcome: TicketOutcome,
    pub bump: u8,
}
