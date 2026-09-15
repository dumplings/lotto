use anchor_lang::prelude::*;

#[cfg(not(any(feature = "localnet", feature = "devnet", feature = "test-fast")))]
compile_error!("至少激活一个feature: localnet, devnet, 或 test-fast");

#[cfg(any(
    all(feature = "localnet", feature = "devnet"),
    all(feature = "localnet", feature = "test-fast"),
    all(feature = "devnet", feature = "test-fast")
))]
compile_error!("多个 feature 被同时激活");

// region VRF_QUEUE
// 本地测试+开发与devnet使用的key不一样
#[cfg(any(feature = "test-fast", feature = "localnet"))]
pub const VRF_QUEUE: Pubkey = ephemeral_vrf_sdk::consts::DEFAULT_TEST_QUEUE;
#[cfg(feature = "devnet")]
pub const VRF_QUEUE: Pubkey = ephemeral_vrf_sdk::consts::DEFAULT_QUEUE;
// endregion

// region 三个生命周期的时长
#[cfg(feature = "test-fast")]
pub const SALE_DURATION_SEC: i64 = 2;
#[cfg(feature = "test-fast")]
pub const REGISTRATION_DURATION_SEC: i64 = 2;
#[cfg(feature = "test-fast")]
pub const CLAIM_DURATION_SEC: i64 = 2;

#[cfg(feature = "localnet")]
pub const SALE_DURATION_SEC: i64 = 160;
#[cfg(feature = "localnet")]
pub const REGISTRATION_DURATION_SEC: i64 = 160;
#[cfg(feature = "localnet")]
pub const CLAIM_DURATION_SEC: i64 = 160;

#[cfg(feature = "devnet")]
pub const SALE_DURATION_SEC: i64 = 3_600;
#[cfg(feature = "devnet")]
pub const REGISTRATION_DURATION_SEC: i64 = 3_600;
#[cfg(feature = "devnet")]
pub const CLAIM_DURATION_SEC: i64 = 3_600;
// endregion

// region SEEDS
pub const LOTTO_CONFIG_SEED: &[u8] = b"lotto_config";
pub const ROUND_SEED: &[u8] = b"round";
pub const TICKET_SEED: &[u8] = b"ticket";
pub const PRIZE_VAULT_SEED: &[u8] = b"prize_vault_seed";
pub const ROLLOVER_VAULT_SEED: &[u8] = b"rollover_vault_seed";
// endregion

// 基点 https://www.ixopay.com/blog/what-is-a-basis-point-bps-and-how-is-it-calculated
pub const BPS_DENOMINATOR: u32 = 10_000;

pub const MAX_LEADING_ZERO_BITS: u16 = 256;
