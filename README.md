# Coin Toss

A NEAR testnet coin-toss game. Anyone can top up the vault, place a wager on heads
or tails, or submit a proof for a pending bet. New wins pay 1.98× the wager, including the original stake: 1% of the gross
2× winning payout stays in the bank. Outcomes remain 50/50. Each flip uses a
single bit of a hash of verified drand quicknet randomness. Network fees apply
separately. Bets accepted before the fee upgrade retain their original 2× payout.

- Contract: `coin-toss-mvp-20261105.testnet`
- Operator: `coin-toss-mvp-admin-20261105.testnet`
- [Deployment transaction](https://testnet.nearblocks.io/txns/FJDWcyPX9cpt2JmARyJ293SNUi4ShsTagMehc6bQEhin)
- Fee upgrade: bets **39 onward** use the 1% winning payout fee; bets 0–38 retain
  their original payout. [Upgrade transaction](https://testnet.nearblocks.io/txns/4yAZeaPj3YRg3GqPEfWvigdVJ8Mrcg29ND17VT9urFdy).
- [Contract on NearBlocks](https://testnet.nearblocks.io/address/coin-toss-mvp-20261105.testnet)

## Web app

The repository’s Flip Fun frontend is the app entry point at `index.html`. Its
Three.js coin, jar, wallet artwork, and synthesized sound are connected to the
NEAR testnet contract. The wallet chooser offers Meteor, Intear, and NEAR CLI.

```sh
npm ci
npm run dev -- --port 5183
npm test
npm run build
```

Vite serves the app locally. `npm run build` creates `dist/`. The browser reads
the bankroll and history from NEAR, fetches the bet’s assigned drand proof, and
asks the player to sign the reveal transaction. The contract pays winning bets
automatically. Pledge sends a contribution to the operator’s bankroll.

History provides public and connected-wallet views, with older bets loaded in
pages. `?bet=14` or `?receipt=14` opens an existing bet. A pending wallet action
is saved locally so its transaction hash can be checked after a redirect or
interruption. A failed payout, an expired refund, or an older unpaid win can be
claimed by its bettor. Proofs can be verified independently in the browser.

## Play on testnet

Install Node.js 22 or newer and run `npm ci`. You can view the bank or a receipt
without a signing key.

```sh
npm run coin-toss -- bank
npm run coin-toss -- receipt 0
npm run coin-toss -- verify 0
```

Bet 0 is a legacy worked example. Its 0.01 NEAR stake won and paid 0.02 NEAR.
Bet 39 demonstrates the new policy: a 0.01 NEAR win paid 0.0198 NEAR and
retained a 0.0002 NEAR fee in the bank. Both receipts can be independently verified.
[Settlement](https://testnet.nearblocks.io/txns/2BhvsWz9kXTjVfKPgNzxGJmP2uBoRcuKDWJGWicUERB6) ·
[Claim](https://testnet.nearblocks.io/txns/AkNaBUTkq3q83pehDUbibLTf43UehJ326WCnWx8fxD65)

Use a testnet account whose key is in `~/.near-credentials/testnet/`, or create a
fresh one with the testnet faucet. The following puts the generated key in the
project's ignored `.near-credentials` directory. Pick your own unused account ID.

```sh
export COIN_TOSS_CREDENTIALS="$PWD/.near-credentials"
export NEAR_ACCOUNT_ID=your-unique-coin-toss-player.testnet
npm run coin-toss -- account "$NEAR_ACCOUNT_ID"
npm run coin-toss -- bet heads 0.001
```

Copy the `bet_id` from the response. Replace `0` below with your bet ID. Settlement
waits for the committed round, generally 6–9 seconds from acceptance.
A winning bet pays the bettor automatically when settled. The bettor can claim
an expired refund, an older unpaid win, or a payout whose transfer failed.

```sh
npm run coin-toss -- settle 0
npm run coin-toss -- verify 0
```

`verify` checks the BLS signature independently of the contract and recomputes
the result and payout from the receipt. Any testnet signer can run `settle`.
`npm run coin-toss -- fund 1` adds one testnet NEAR to the house bankroll. Funding
is a contribution to the operator's bankroll. It creates no shares or redemption
claim. Bank and receipt amounts are in yoctoNEAR.

## Contract behavior

- New wagers are capped at 1% of the free bank, with a 0.001 NEAR contract minimum
  (the UI uses 0.01 NEAR steps). The
  contract also caps house exposure when accepting new bets at 10% of house
  equity. Accepting a wager reserves both the player's stake and the house's
  matching amount before any result is known.
- A wager binds to the first quicknet round scheduled strictly after its NEAR
  block timestamp plus six seconds. A valid proof can settle that bet exactly
  once. The verification key and round schedule are fixed in the WASM.
- The bit is `SHA256("coin-toss:v1" || 0x00 || contract_id || 0x00 ||
  u64be(bet_id) || SHA256(compressed_signature))[0] & 1`. Zero is heads.
- A proof can be submitted until 24 hours after the scheduled round. If the
  bet is still pending then, anyone can call `refund` and the bettor can claim
  the stake. A delayed submission never selects a different round.
- A win retains 1% of its gross 2× payout in free bankroll and sends the remaining
  1.98× to the bettor. The fee rounds down to whole yoctoNEAR. Losses and refunds
  incur no winning fee. The full 2× is conservatively reserved until settlement.
- `bank` exposes `win_fee_bps` and `fee_start_bet_id`; receipts include
  `win_payout`, `win_fee_bps`, and the actual `fee`. The proof verifier checks the
  payout against the on-chain policy and preserves legacy receipts.
- `place_bet` requires `expected_payout` so a stale client cannot silently accept
  changed payout terms.
- Settlement sends wins directly to the account that placed the bet. A failed
  payout becomes claimable by that account. The operator may pause new bets and
  withdraw free bankroll, which is kept separate from reserved payouts.
- Bet receipts remain in contract storage, which uses unallocated NEAR on the
  contract account. If it runs low, transfer testnet NEAR directly to that
  account for storage. The `fund` command instead increases the house bankroll.

This prototype assumes a normally advancing NEAR chain clock and relies on
drand's threshold and availability. The testnet deployment account retains an
upgrade key. The operator can pause wagers, and the browser fetches proofs from
drand for players to submit. It uses testnet tokens.

## Build and deploy your own instance

With Rust 1.99 or newer, the WASM target, and cargo-near installed:

```sh
rustup target add wasm32-unknown-unknown
cargo test --locked
cargo near build non-reproducible-wasm --locked --no-abi
npm ci
export COIN_TOSS_CREDENTIALS="$PWD/.near-credentials"
export COIN_TOSS_CONTRACT=your-unique-coin-toss.testnet
export NEAR_ACCOUNT_ID="$COIN_TOSS_CONTRACT"
npm run coin-toss -- account "$COIN_TOSS_CONTRACT"
npm run coin-toss -- deploy
npm run coin-toss -- fund 1
```

`deploy` also accepts an optional separate testnet account ID for the operator.
Initialization and deployment are submitted in one transaction.

## Upgrading the pre-fee testnet deployment

Build and test the new WASM first. Temporarily pause new bets from the operator
account, then sign `npm run coin-toss -- upgrade` from the contract account.
The CLI batches code deployment and the private `migrate` call in one transaction.
Migration preserves bank balances, reservations, pending bets, claims, and
in-flight transfers, and records the next bet ID as the fee activation boundary.
Earlier bets retain 2× payouts without rewriting their stored records. Publish
the updated UI, then resume bets from the operator account. Migration is intended
for the original pre-fee state and cannot be replayed on the upgraded state.
