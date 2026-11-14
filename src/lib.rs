mod beacon;

use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require};

const MIN_BET: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const ROUND_LEAD: u64 = 6;
const PROOF_WINDOW: u64 = 86_400;
const CALLBACK_GAS: Gas = Gas::from_tgas(12);

#[derive(Clone, Copy, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Heads,
    Tails,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Pending,
    Won,
    Lost,
    Refunded,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
enum Claim {
    Unavailable,
    Available,
    InFlight,
    Paid,
}

#[near(serializers = [borsh])]
struct Bet {
    player: AccountId,
    side: Side,
    stake: u128,
    round: u64,
    outcome: Outcome,
    claim: Claim,
    signature: [u8; 48],
}

impl Bet {
    fn expires_at(&self) -> u64 {
        beacon::round_time(self.round) + PROOF_WINDOW
    }

    fn payout(&self) -> u128 {
        match self.outcome {
            Outcome::Won => self.stake * 2,
            Outcome::Refunded => self.stake,
            _ => 0,
        }
    }

    fn receipt(&self, bet_id: U64) -> BetReceipt {
        let settled = matches!(self.outcome, Outcome::Won | Outcome::Lost);
        let result = match self.outcome {
            Outcome::Won => Some(self.side),
            Outcome::Lost if self.side == Side::Heads => Some(Side::Tails),
            Outcome::Lost => Some(Side::Heads),
            _ => None,
        };
        BetReceipt {
            bet_id,
            player: self.player.clone(),
            side: self.side,
            stake: U128(self.stake),
            round: U64(self.round),
            round_at: U64(beacon::round_time(self.round)),
            expires_at: U64(self.expires_at()),
            outcome: self.outcome,
            result,
            payout: U128(self.payout()),
            claim: self.claim,
            signature: settled.then(|| hex::encode(self.signature)),
        }
    }
}

#[near(serializers = [json])]
pub struct BetReceipt {
    bet_id: U64,
    player: AccountId,
    side: Side,
    stake: U128,
    round: U64,
    round_at: U64,
    expires_at: U64,
    outcome: Outcome,
    result: Option<Side>,
    payout: U128,
    claim: Claim,
    signature: Option<String>,
}

#[near(serializers = [json])]
pub struct BankView {
    owner: AccountId,
    free: U128,
    pending_payouts: U128,
    claimable: U128,
    in_flight: U128,
    min_bet: U128,
    max_bet: U128,
    bet_count: U64,
    paused: bool,
    beacon_chain_hash: &'static str,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CoinToss {
    owner: AccountId,
    free: u128,
    pending_payouts: u128,
    claimable: u128,
    in_flight: u128,
    next_bet_id: u64,
    paused: bool,
    bets: LookupMap<u64, Bet>,
}

#[near]
impl CoinToss {
    #[init]
    #[private]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            free: 0,
            pending_payouts: 0,
            claimable: 0,
            in_flight: 0,
            next_bet_id: 0,
            paused: false,
            bets: LookupMap::new(b"bets".as_slice()),
        }
    }

    #[payable]
    pub fn fund_bank(&mut self) -> BankView {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "Attach NEAR to fund the bank");
        self.free += deposit;
        self.bank()
    }

    pub fn bank(&self) -> BankView {
        BankView {
            owner: self.owner.clone(),
            free: U128(self.free),
            pending_payouts: U128(self.pending_payouts),
            claimable: U128(self.claimable),
            in_flight: U128(self.in_flight),
            min_bet: U128(MIN_BET),
            max_bet: U128(self.max_bet()),
            bet_count: U64(self.next_bet_id),
            paused: self.paused,
            beacon_chain_hash: beacon::CHAIN_HASH,
        }
    }

    pub fn get_bet(&self, bet_id: U64) -> Option<BetReceipt> {
        self.bets.get(&bet_id.0).map(|bet| bet.receipt(bet_id))
    }

    #[payable]
    pub fn place_bet(&mut self, side: Side) -> BetReceipt {
        require!(!self.paused, "New bets are paused");
        let stake = env::attached_deposit().as_yoctonear();
        require!(stake >= MIN_BET, "Bet is below the minimum");
        require!(
            stake <= self.max_bet(),
            "Bet exceeds the current bankroll limit"
        );
        let bet_id = U64(self.next_bet_id);
        let bet = Bet {
            player: env::predecessor_account_id(),
            side,
            stake,
            round: beacon::round_after(now() + ROUND_LEAD),
            outcome: Outcome::Pending,
            claim: Claim::Unavailable,
            signature: [0; 48],
        };
        let receipt = bet.receipt(bet_id);
        self.next_bet_id += 1;
        self.free -= stake;
        self.pending_payouts += stake * 2;
        self.bets.insert(bet_id.0, bet);
        self.bets.flush();

        // Bet records have a fixed size after insertion. House equity and wagers
        // are separate from the account's unallocated storage collateral.
        let accounted = self.free + self.pending_payouts + self.claimable + self.in_flight;
        let collateral = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        require!(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(accounted)
                >= collateral,
            "Contract needs more unallocated NEAR for storage",
        );
        receipt
    }

    pub fn settle_bet(&mut self, bet_id: U64, signature: String) -> PromiseOrValue<BetReceipt> {
        let bet = self
            .bets
            .get_mut(&bet_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown bet"));
        require!(bet.outcome == Outcome::Pending, "Bet is already resolved");
        require!(
            now() >= beacon::round_time(bet.round),
            "Beacon round is in the future"
        );
        require!(now() < bet.expires_at(), "Bet has expired");
        let mut proof = [0; 48];
        require!(
            hex::decode_to_slice(signature, &mut proof).is_ok(),
            "Invalid signature encoding"
        );
        require!(
            beacon::verify(bet.round, &proof),
            "Invalid beacon proof for this round"
        );

        bet.signature = proof;
        let result =
            if beacon::result_bit(env::current_account_id().as_str(), bet_id.0, &proof) == 0 {
                Side::Heads
            } else {
                Side::Tails
            };
        self.pending_payouts -= bet.stake * 2;
        if result == bet.side {
            bet.outcome = Outcome::Won;
            bet.claim = Claim::Available;
            self.claimable += bet.payout();
            self.send_payout(bet_id)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_settlement_payout(bet_id),
                )
                .into()
        } else {
            bet.outcome = Outcome::Lost;
            self.free += bet.stake * 2;
            PromiseOrValue::Value(bet.receipt(bet_id))
        }
    }

    pub fn refund_expired_bet(&mut self, bet_id: U64) -> BetReceipt {
        let bet = self
            .bets
            .get_mut(&bet_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown bet"));
        require!(bet.outcome == Outcome::Pending, "Bet is already resolved");
        require!(
            now() >= bet.expires_at(),
            "Bet is still open for proof submission"
        );
        self.pending_payouts -= bet.stake * 2;
        self.free += bet.stake;
        self.claimable += bet.stake;
        bet.outcome = Outcome::Refunded;
        bet.claim = Claim::Available;
        bet.receipt(bet_id)
    }

    pub fn claim(&mut self, bet_id: U64) -> Promise {
        let bet = self
            .bets
            .get(&bet_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown bet"));
        require!(
            env::predecessor_account_id() == bet.player,
            "Only the bettor can claim"
        );
        self.send_payout(bet_id).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_claim(bet_id),
        )
    }

    #[private]
    pub fn on_settlement_payout(&mut self, bet_id: U64) -> BetReceipt {
        self.on_claim(bet_id);
        self.get_bet(bet_id)
            .unwrap_or_else(|| env::panic_str("Unknown bet"))
    }

    #[private]
    pub fn on_claim(&mut self, bet_id: U64) -> bool {
        let bet = self
            .bets
            .get_mut(&bet_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown bet"));
        require!(bet.claim == Claim::InFlight, "No claim transfer in flight");
        let amount = bet.payout();
        self.in_flight -= amount;
        let success = env::promise_result_checked(0, 0).is_ok();
        if success {
            bet.claim = Claim::Paid;
        } else {
            bet.claim = Claim::Available;
            self.claimable += amount;
        }
        success
    }

    pub fn withdraw_bank(&mut self, amount: U128) -> Promise {
        self.require_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.free,
            "Amount exceeds free bankroll"
        );
        self.free -= amount.0;
        self.in_flight += amount.0;
        Promise::new(self.owner.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw(amount),
            )
    }

    #[private]
    pub fn on_withdraw(&mut self, amount: U128) -> bool {
        self.in_flight -= amount.0;
        let success = env::promise_result_checked(0, 0).is_ok();
        if !success {
            self.free += amount.0;
        }
        success
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
    }
}

impl CoinToss {
    fn send_payout(&mut self, bet_id: U64) -> Promise {
        let bet = self
            .bets
            .get_mut(&bet_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown bet"));
        require!(bet.claim == Claim::Available, "There is no payout to claim");
        let amount = bet.payout();
        bet.claim = Claim::InFlight;
        self.claimable -= amount;
        self.in_flight += amount;
        Promise::new(bet.player.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    fn max_bet(&self) -> u128 {
        let reserved_house_risk = self.pending_payouts / 2;
        let house_equity = self.free + reserved_house_risk;
        let remaining_exposure = (house_equity / 10).saturating_sub(reserved_house_risk);
        (self.free / 100).min(remaining_exposure)
    }

    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can do this"
        );
    }
}

fn now() -> u64 {
    env::block_timestamp_ms() / 1_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_created_receipts};
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

    #[test]
    fn winning_settlement_pays_the_bettor_and_a_failed_transfer_stays_claimable() {
        let signature = "898a7998602631a38324d381fb225128656a3796320d69f19b4259ab4c6c3f52aa44a4a410054c49c1713c8db5d03fd2";
        let round_at = beacon::round_time(33_705_244);
        let mut proof = [0; 48];
        hex::decode_to_slice(signature, &mut proof).unwrap();
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .account_balance(NearToken::from_near(10))
            .block_timestamp((round_at - ROUND_LEAD - 1) * 1_000_000_000)
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        let mut game = CoinToss::new(accounts(2));
        game.fund_bank();

        context.attached_deposit(NearToken::from_yoctonear(MIN_BET));
        testing_env!(context.build());
        let side = if beacon::result_bit(accounts(0).as_str(), 0, &proof) == 0 {
            Side::Heads
        } else {
            Side::Tails
        };
        let bet = game.place_bet(side);

        context
            .predecessor_account_id(accounts(3))
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(round_at * 1_000_000_000);
        testing_env!(context.build());
        let PromiseOrValue::Promise(payout) = game.settle_bet(bet.bet_id, signature.into()) else {
            panic!("A win should schedule a payout");
        };
        payout.detach();
        assert!(get_created_receipts().iter().any(|receipt| {
            receipt.receiver_id == bet.player
                && receipt.actions.iter().any(|action| {
                    matches!(action, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == 2 * MIN_BET)
                })
        }));
        assert_eq!(game.in_flight, 2 * MIN_BET);
        assert_eq!(game.pending_payouts, 0);

        context.predecessor_account_id(accounts(0));
        testing_env!(context.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
        let receipt = game.on_settlement_payout(bet.bet_id);
        assert!(receipt.outcome == Outcome::Won);
        assert!(receipt.claim == Claim::Available);
        assert_eq!(game.claimable, 2 * MIN_BET);
        assert_eq!(game.in_flight, 0);
    }

    #[test]
    fn expired_bet_releases_the_house_reserve_and_failed_claim_can_retry() {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .account_balance(NearToken::from_near(10))
            .block_timestamp((beacon::GENESIS + 100) * 1_000_000_000)
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        let mut game = CoinToss::new(accounts(2));
        game.fund_bank();
        assert_eq!(game.max_bet(), NearToken::from_millinear(10).as_yoctonear());

        context.attached_deposit(NearToken::from_yoctonear(MIN_BET));
        testing_env!(context.build());
        let bet = game.place_bet(Side::Heads);
        assert_eq!(game.pending_payouts, 2 * MIN_BET);
        assert_eq!(game.free, NearToken::from_near(1).as_yoctonear() - MIN_BET);
        assert!(bet.round_at.0 > now() + ROUND_LEAD);

        context
            .block_timestamp(bet.expires_at.0 * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());
        let refund = game.refund_expired_bet(bet.bet_id);
        assert_eq!(refund.payout.0, MIN_BET);
        assert_eq!(game.pending_payouts, 0);
        assert_eq!(game.free, NearToken::from_near(1).as_yoctonear());

        game.claim(bet.bet_id).detach();
        assert_eq!(game.claimable, 0);
        assert_eq!(game.in_flight, MIN_BET);
        context.predecessor_account_id(accounts(0));
        testing_env!(
            context.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!game.on_claim(bet.bet_id));
        assert_eq!(game.claimable, MIN_BET);
        assert_eq!(game.in_flight, 0);

        context.predecessor_account_id(accounts(1));
        testing_env!(context.build());
        game.claim(bet.bet_id).detach();
        context.predecessor_account_id(accounts(0));
        testing_env!(
            context.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(game.on_claim(bet.bet_id));
        assert_eq!(game.claimable, 0);
        assert_eq!(game.in_flight, 0);
        assert!(game.get_bet(bet.bet_id).unwrap().claim == Claim::Paid);
    }
}
