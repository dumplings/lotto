use anchor_lang::prelude::{
    AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, Pubkey,
};
use anchor_lang::{declare_id, Discriminator, Space};

declare_id!("6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm");

#[path = "../src/constants.rs"]
mod constants;
#[path = "../src/state.rs"]
mod state;

use state::{LottoConfig, PrizeTier, Round, RoundStatus, Ticket, TicketOutcome};

const ACCOUNT_DISCRIMINATOR_LEN: usize = 8;
const LOTTO_CONFIG_DATA_LEN: usize = 102;
const ROUND_DATA_LEN: usize = 223;
const TICKET_DATA_LEN: usize = 47;

fn borsh_bytes<T: AnchorSerialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    value.serialize(&mut bytes).unwrap();
    bytes
}

fn account_bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    value.try_serialize(&mut bytes).unwrap();
    bytes
}

fn max_sized_config() -> LottoConfig {
    LottoConfig {
        authority: Pubkey::new_from_array([1; 32]),
        treasury: Pubkey::new_from_array([2; 32]),
        next_round_id: u64::MAX,
        active_round_id: Some(u64::MAX),
        ticket_price: u64::MAX,
        tier_thresholds: [u16::MAX; constants::TIER_COUNT],
        tier_pool_bps: [u16::MAX; constants::TIER_COUNT],
        bump: u8::MAX,
    }
}

fn max_sized_round() -> Round {
    Round {
        round_id: u64::MAX,
        status: RoundStatus::Claiming,
        randomness_binding: [u8::MAX; 32],
        randomness_requested_at: i64::MAX,
        randomness_received_at: i64::MAX,
        randomness_ready: true,
        randomness: [u8::MAX; 32],
        sale_duration_secs: i64::MAX,
        registration_duration_secs: i64::MAX,
        claim_duration_secs: i64::MAX,
        sale_deadline: i64::MAX,
        registration_deadline: i64::MAX,
        claim_deadline: i64::MAX,
        ticket_price: u64::MAX,
        tier_thresholds: [u16::MAX; constants::TIER_COUNT],
        tier_pool_bps: [u16::MAX; constants::TIER_COUNT],
        registered_units: [u64::MAX; constants::TIER_COUNT],
        prize_per_unit: [u64::MAX; constants::TIER_COUNT],
        sales_proceeds: u64::MAX,
        rollover_in: u64::MAX,
        bump: u8::MAX,
    }
}

fn max_sized_ticket() -> Ticket {
    Ticket {
        user: Pubkey::new_from_array([3; 32]),
        round_id: u64::MAX,
        quantity: u32::MAX,
        outcome: TicketOutcome::Winner(PrizeTier::Tier2),
        bump: u8::MAX,
    }
}

#[test]
fn prize_tier_and_ticket_outcome_encoding_is_stable() {
    assert_eq!(borsh_bytes(&PrizeTier::Tier0), [0]);
    assert_eq!(borsh_bytes(&PrizeTier::Tier1), [1]);
    assert_eq!(borsh_bytes(&PrizeTier::Tier2), [2]);

    assert_eq!(borsh_bytes(&TicketOutcome::Unregistered), [0]);
    assert_eq!(
        borsh_bytes(&TicketOutcome::Winner(PrizeTier::Tier0)),
        [1, 0]
    );
    assert_eq!(
        borsh_bytes(&TicketOutcome::Winner(PrizeTier::Tier1)),
        [1, 1]
    );
    assert_eq!(
        borsh_bytes(&TicketOutcome::Winner(PrizeTier::Tier2)),
        [1, 2]
    );
}

#[test]
fn malformed_nested_prize_tier_is_rejected() {
    assert!(TicketOutcome::try_from_slice(&[1, 3]).is_err());

    let mut malformed_ticket = account_bytes(&max_sized_ticket());
    let outcome_offset = ACCOUNT_DISCRIMINATOR_LEN + 32 + 8 + 4;
    malformed_ticket[outcome_offset] = 1;
    malformed_ticket[outcome_offset + 1] = 3;

    let mut account_data = malformed_ticket.as_slice();
    assert!(Ticket::try_deserialize(&mut account_data).is_err());
}

#[test]
fn init_space_matches_max_borsh_and_account_serialization() {
    let config = max_sized_config();
    let round = max_sized_round();
    let ticket = max_sized_ticket();

    assert_eq!(LottoConfig::INIT_SPACE, LOTTO_CONFIG_DATA_LEN);
    assert_eq!(Round::INIT_SPACE, ROUND_DATA_LEN);
    assert_eq!(Ticket::INIT_SPACE, TICKET_DATA_LEN);

    assert_eq!(borsh_bytes(&config).len(), LOTTO_CONFIG_DATA_LEN);
    assert_eq!(borsh_bytes(&round).len(), ROUND_DATA_LEN);
    assert_eq!(borsh_bytes(&ticket).len(), TICKET_DATA_LEN);

    assert_eq!(LottoConfig::DISCRIMINATOR.len(), ACCOUNT_DISCRIMINATOR_LEN);
    assert_eq!(Round::DISCRIMINATOR.len(), ACCOUNT_DISCRIMINATOR_LEN);
    assert_eq!(Ticket::DISCRIMINATOR.len(), ACCOUNT_DISCRIMINATOR_LEN);

    assert_eq!(
        account_bytes(&config).len(),
        ACCOUNT_DISCRIMINATOR_LEN + LOTTO_CONFIG_DATA_LEN
    );
    assert_eq!(
        account_bytes(&round).len(),
        ACCOUNT_DISCRIMINATOR_LEN + ROUND_DATA_LEN
    );
    assert_eq!(
        account_bytes(&ticket).len(),
        ACCOUNT_DISCRIMINATOR_LEN + TICKET_DATA_LEN
    );
}

#[test]
fn phase0_state_decisions_have_no_legacy_residue() {
    let state_source = include_str!("../src/state.rs");
    let error_source = include_str!("../src/error.rs");

    assert!(state_source.contains("pub outcome: TicketOutcome"));
    assert!(state_source.contains("Winner(PrizeTier)"));
    assert!(!state_source.contains("claimed_units"));
    assert!(!state_source.contains("prize_tier"));
    assert!(!state_source.contains("Winner(u8)"));
    assert!(!error_source.contains("InvalidPrizeTier"));
    assert!(!error_source.contains("#[error_code]"));
}

#[test]
fn phase0_constants_and_program_id_are_stable() {
    assert_eq!(lotto::ID, ID);
    assert_eq!(constants::LOTTO_CONFIG_SEED, b"lotto_config");
    assert_eq!(constants::ROUND_SEED, b"round");
    assert_eq!(constants::TICKET_SEED, b"ticket");
    assert_eq!(constants::PRIZE_VAULT_SEED, b"prize_vault_seed");
    assert_eq!(constants::ROLLOVER_VAULT_SEED, b"rollover_vault_seed");
    assert_eq!(constants::BPS_DENOMINATOR, 10_000);
    assert_eq!(constants::TIER_COUNT, 3);
    assert_eq!(constants::MAX_LEADING_ZERO_BITS, 256);

    #[cfg(feature = "test-fast")]
    {
        assert_eq!(constants::SALE_DURATION_SEC, 2);
        assert_eq!(constants::REGISTRATION_DURATION_SEC, 2);
        assert_eq!(constants::CLAIM_DURATION_SEC, 2);
        assert_eq!(
            constants::VRF_QUEUE,
            ephemeral_vrf_sdk::consts::DEFAULT_TEST_QUEUE
        );
    }

    #[cfg(feature = "localnet")]
    {
        assert_eq!(constants::SALE_DURATION_SEC, 160);
        assert_eq!(constants::REGISTRATION_DURATION_SEC, 160);
        assert_eq!(constants::CLAIM_DURATION_SEC, 160);
        assert_eq!(
            constants::VRF_QUEUE,
            ephemeral_vrf_sdk::consts::DEFAULT_TEST_QUEUE
        );
    }

    #[cfg(feature = "devnet")]
    {
        assert_eq!(constants::SALE_DURATION_SEC, 3_600);
        assert_eq!(constants::REGISTRATION_DURATION_SEC, 3_600);
        assert_eq!(constants::CLAIM_DURATION_SEC, 3_600);
        assert_eq!(
            constants::VRF_QUEUE,
            ephemeral_vrf_sdk::consts::DEFAULT_QUEUE
        );
    }
}
