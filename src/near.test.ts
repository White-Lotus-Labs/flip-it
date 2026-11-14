import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTRACT, DEMO_LINKS, floorNearCents, formatNear, formatNearDisplay, getBetPage, matchIntent, parseBetId, parseNear, returnedBetId, transactionResult, winningPayout, betFeeBps, type Bet, type Intent } from './near.ts'
import { verifyBet } from './proof.ts'

const player = DEMO_LINKS.placed!.signer
const bet: Bet = {
  bet_id: '0', player, side: 'heads', stake: '10000000000000000000000',
  round: '33705432', round_at: '1793919660', expires_at: '1794006060',
  outcome: 'won', result: 'heads', payout: '20000000000000000000000', claim: 'paid',
  win_fee_bps: 0, fee: '0', win_payout: '20000000000000000000000',
  signature: '816f00ce9eb65a799c651683a42ceb04deea2f98fa1bbb6154c286ce11414b143229ec11328f535e042303751627504e',
}

test('stakes and u64 IDs use exact integer arithmetic', () => {
  assert.equal(parseNear('0.009900000000000000000001'), 9900000000000000000001n)
  assert.equal(formatNear(9900000000000000000001n), '0.009900000000000000000001')
  assert.equal(parseNear('0.0000000000000000000000001'), null)
  assert.equal(parseNear('1e-3'), null)
  assert.equal(parseBetId('0'), '0')
  assert.equal(parseBetId('18446744073709551616'), null)
})

test('display rounding preserves small stakes and MAX never exceeds the exact limit', () => {
  assert.equal(formatNearDisplay(parseNear('100')!), '100.00')
  assert.equal(formatNearDisplay(parseNear('9.899010099')!), '9.90')
  assert.equal(formatNearDisplay(parseNear('0.995')!), '1.00')
  assert.equal(formatNearDisplay(0n), '0.00')
  assert.equal(formatNearDisplay(parseNear('0.001')!), '<0.01')
  const cap = parseNear('0.099989999999999999999999')!
  assert.equal(formatNearDisplay(floorNearCents(cap)), '0.09')
  assert.ok(floorNearCents(cap) <= cap)
  assert.equal(floorNearCents(parseNear('1')!), parseNear('1'))
})

test('history reads newest first and continues through bet zero without overlaps', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const { params } = JSON.parse(options.body as string)
    const { bet_id } = JSON.parse(atob(params.args_base64))
    const value = params.method_name === 'bank' ? { bet_count: '10' } : { ...bet, bet_id }
    return Response.json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } })
  })
  const signal = new AbortController().signal
  const latest = await getBetPage(null, signal)
  assert.deepEqual(latest.bets.map(bet => bet.bet_id), ['9', '8', '7', '6', '5', '4', '3', '2'])
  assert.equal(latest.next, '2')
  const older = await getBetPage(latest.next, signal)
  assert.deepEqual(older.bets.map(bet => bet.bet_id), ['1', '0'])
  assert.equal(older.next, null)
  assert.equal(fetch.mock.callCount(), 11)
})

test('wallet recovery accepts the exact wager and rejects altered intent', () => {
  const hash = DEMO_LINKS.placed!.hash
  const intent: Intent = { id: 'test', signer: player, method: 'place_bet', args: { side: 'heads' }, deposit: bet.stake, hash }
  const tx = {
    final_execution_status: 'FINAL',
    transaction: { hash, signer_id: player, receiver_id: CONTRACT, actions: [{
      FunctionCall: { method_name: 'place_bet', args: btoa('{"side":"heads"}'), deposit: bet.stake },
    }] },
    status: { SuccessValue: btoa(JSON.stringify(bet)) },
  }
  assert.doesNotThrow(() => matchIntent(tx, intent))
  assert.equal(returnedBetId(transactionResult(tx), player), '0')
  assert.throws(() => matchIntent(tx, { ...intent, deposit: '1' }))
  assert.throws(() => matchIntent(tx, { ...intent, args: { side: 'tails' } }))
  assert.throws(() => matchIntent(tx, { ...intent, signer: 'another.testnet' }))
})

test('verifies the known legacy paid flip and rejects a changed round or payout', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify({ win_fee_bps: 100, fee_start_bet_id: '1' }))) } }));
  assert.equal(await verifyBet(bet), 'heads')
  await assert.rejects(verifyBet({ ...bet, round: '33705433' }), /signature failed/)
  await assert.rejects(verifyBet({ ...bet, payout: '1' }), /differs/)
})


test('winning fee uses exact gross payout math and refunds are not fee-bearing', () => {
  assert.equal(winningPayout(parseNear('1')!, 100), parseNear('1.98'))
  assert.equal(winningPayout(parseNear('0.01')!, 100), parseNear('0.0198'))
  assert.equal(winningPayout(49n, 100), 98n)
  assert.equal(winningPayout(51n, 100), 101n)
  assert.equal(winningPayout(parseNear('1')!, 0), parseNear('2'))
  assert.equal(betFeeBps('38', { win_fee_bps: 100, fee_start_bet_id: '39' }), 0)
  assert.equal(betFeeBps('39', { win_fee_bps: 100, fee_start_bet_id: '39' }), 100)
  assert.throws(() => winningPayout(1n, -1))
})

test('verifier anchors new win fees to on-chain policy and rejects altered terms', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify({ win_fee_bps: 100, fee_start_bet_id: '0' }))) } }))
  const net = winningPayout(bet.stake, 100).toString()
  const current: Bet = { ...bet, payout: net, win_payout: net, win_fee_bps: 100, fee: (2n * BigInt(bet.stake) - BigInt(net)).toString() }
  assert.equal(await verifyBet(current), 'heads')
  await assert.rejects(verifyBet({ ...current, win_fee_bps: 0, payout: bet.payout, win_payout: bet.payout, fee: '0' }), /differs/)
  await assert.rejects(verifyBet({ ...current, fee: '1' }), /differs/)
  assert.equal(await verifyBet({ ...current, side: 'tails', outcome: 'lost', payout: '0', fee: '0' }), 'heads')
})
