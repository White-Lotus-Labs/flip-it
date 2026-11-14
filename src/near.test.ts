import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTRACT, DEMO_LINKS, formatNear, getBetPage, matchIntent, parseBetId, parseNear, returnedBetId, transactionResult, type Bet, type Intent } from './near.ts'
import { verifyBet } from './proof.ts'

const player = DEMO_LINKS.placed!.signer
const bet: Bet = {
  bet_id: '0', player, side: 'heads', stake: '10000000000000000000000',
  round: '33705432', round_at: '1793919660', expires_at: '1794006060',
  outcome: 'won', result: 'heads', payout: '20000000000000000000000', claim: 'paid',
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

test('verifies the known paid flip and rejects a changed round or payout', async () => {
  assert.equal(await verifyBet(bet), 'heads')
  await assert.rejects(verifyBet({ ...bet, round: '33705433' }), /signature failed/)
  await assert.rejects(verifyBet({ ...bet, payout: '1' }), /differs/)
})
