export const CONTRACT = 'coin-toss-mvp-20261105.testnet'
export const RPC = 'https://rpc.testnet.fastnear.com'
export const WALLET_DIRECTORY = 'https://wallet.near.org/'
export const EXPLORER = 'https://testnet.nearblocks.io'
const DRAND = 'https://api.drand.sh/v2/beacons/quicknet/rounds'
const ONE_NEAR = 10n ** 24n
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
const ACCOUNT = /^(?:[a-f0-9]{64}|[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet)$/

export type Side = 'heads' | 'tails'
export type Bet = {
  bet_id: string
  player: string
  side: Side
  stake: string
  round: string
  round_at: string
  expires_at: string
  outcome: 'pending' | 'won' | 'lost' | 'refunded'
  result: Side | null
  payout: string
  claim: 'unavailable' | 'available' | 'in_flight' | 'paid'
  signature: string | null
}
export type Bank = {
  free: string
  pending_payouts: string
  min_bet: string
  max_bet: string
  bet_count: string
  paused: boolean
}
export type Method = 'place_bet' | 'settle_bet' | 'claim' | 'refund_expired_bet' | 'fund_bank'
export type Intent = {
  id: string
  signer: string
  method: Method
  args: Record<string, string>
  deposit: string
  hash?: string
}
export type TxRef = { hash: string; signer: string }
export type TxLinks = { placed?: TxRef; settled?: TxRef; claimed?: TxRef }
type RpcTx = {
  final_execution_status: string
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] }
  status: { SuccessValue?: string; Failure?: unknown }
}

export const DEMO_LINKS: TxLinks = {
  placed: { hash: '3ieGuD66nafuD2FEcgx1K14pH83bZcWzmERtQ3oMitMY', signer: 'coin-toss-mvp-player-20261105.testnet' },
  settled: { hash: '2BhvsWz9kXTjVfKPgNzxGJmP2uBoRcuKDWJGWicUERB6', signer: 'coin-toss-mvp-admin-20261105.testnet' },
}
export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`
export const isTxHash = (value: string) => BASE58.test(value)
export const isTestnetAccount = (value: string) => value.length <= 64 && ACCOUNT.test(value)

export function parseNear(value: string): bigint | null {
  const match = /^(\d{1,24})(?:\.(\d{0,24}))?$/.exec(value)
  if (!match) return null
  return BigInt(match[1]) * ONE_NEAR + BigInt((match[2] ?? '').padEnd(24, '0'))
}

export function formatNear(value: string | bigint) {
  const digits = BigInt(value).toString().padStart(25, '0')
  const fraction = digits.slice(-24).replace(/0+$/, '')
  return digits.slice(0, -24) + (fraction ? '.' + fraction : '')
}

export function parseBetId(value: string | null) {
  if (!value || !/^\d{1,20}$/.test(value)) return null
  const id = BigInt(value)
  return id < (1n << 64n) ? id.toString() : null
}

function encodeJson(args: object) {
  const bytes = new TextEncoder().encode(JSON.stringify(args))
  return btoa(String.fromCharCode(...bytes))
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))))
}

async function rpc<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'coin-toss', method, params }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}. Try refreshing.`)
  const body = await response.json()
  if (body.error || body.result === undefined) {
    throw new Error(body.error?.cause?.name?.replaceAll('_', ' ') ?? body.error?.message ?? 'The NEAR RPC returned an empty response.')
  }
  return body.result as T
}

async function view<T>(method_name: string, args: object, signal?: AbortSignal): Promise<T> {
  const response = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function', account_id: CONTRACT, finality: 'final',
    method_name, args_base64: encodeJson(args),
  }, signal)
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(response.result))) as T
}

export const getBank = (signal?: AbortSignal) => view<Bank>('bank', {}, signal)
export const getBet = (id: string, signal?: AbortSignal) => view<Bet | null>('get_bet', { bet_id: id }, signal)

export async function getBetPage(before: string | null, signal: AbortSignal) {
  const end = BigInt(before ?? (await getBank(signal)).bet_count)
  const start = end > 8n ? end - 8n : 0n
  const ids = Array.from({ length: Number(end - start) }, (_, i) => (end - 1n - BigInt(i)).toString())
  const bets = await Promise.all(ids.map(async id => {
    const bet = await getBet(id, signal)
    if (!bet) throw new Error('A finalized bet could not be loaded.')
    return bet
  }))
  return { bets, next: start > 0n ? start.toString() : null }
}

export async function getBalance(account: string, signal?: AbortSignal) {
  const result = await rpc<{ amount: string }>('query', {
    request_type: 'view_account', account_id: account, finality: 'final',
  }, signal)
  return result.amount
}

export async function getProof(round: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${DRAND}/${round}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if ([404, 425].includes(response.status)) return null
  if (!response.ok) throw new Error('The drand relay is unavailable. This bet keeps its assigned round.')
  const proof = await response.json()
  if (String(proof.round) !== round || !/^[a-f0-9]{96}$/.test(proof.signature)) {
    throw new Error('The drand relay returned an unexpected proof.')
  }
  return proof.signature
}

export async function getTransaction(hash: string, signer: string, signal?: AbortSignal) {
  if (!isTxHash(hash) || !isTestnetAccount(signer)) throw new Error('Enter a valid transaction hash and testnet signer.')
  const tx = await rpc<RpcTx>('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' }, signal)
  if (tx.final_execution_status !== 'FINAL') throw new Error('The transaction is still confirming.')
  return tx
}

export function identifyCall(tx: RpcTx, hash: string, signer: string) {
  const { transaction } = tx
  if (
    transaction.hash !== hash || transaction.signer_id !== signer ||
    transaction.receiver_id !== CONTRACT || transaction.actions.length !== 1
  ) throw new Error('This transaction does not match Coin Toss and the specified signer.')
  const [action] = transaction.actions as { FunctionCall?: { method_name: string; args: string; deposit: string } }[]
  if (!action?.FunctionCall) throw new Error('This transaction does not call Coin Toss.')
  const call = action.FunctionCall
  return { method: call.method_name, args: decodeJson(call.args) as Record<string, string>, deposit: call.deposit }
}

export function matchIntent(tx: RpcTx, intent: Intent) {
  const call = identifyCall(tx, intent.hash ?? '', intent.signer)
  const expectedArgs = Object.entries(intent.args)
  if (
    call.method !== intent.method || call.deposit !== intent.deposit ||
    Object.keys(call.args).length !== expectedArgs.length ||
    expectedArgs.some(([key, value]) => call.args[key] !== value)
  ) throw new Error('This transaction does not match the action awaiting confirmation.')
}

export function transactionResult(tx: RpcTx): unknown {
  if (tx.status.Failure !== undefined) return undefined
  return tx.status.SuccessValue ? decodeJson(tx.status.SuccessValue) : null
}

export function returnedBetId(value: unknown, signer?: string) {
  if (typeof value !== 'object' || value === null || !('bet_id' in value)) return null
  if (signer && (!('player' in value) || value.player !== signer)) return null
  return typeof value.bet_id === 'string' ? parseBetId(value.bet_id) : null
}

export function transactionFailure(tx: RpcTx) {
  const raw = JSON.stringify(tx.status.Failure)
  if (raw.includes('current bankroll limit')) return 'The max bet changed before this wager landed. Check the updated limit.'
  if (raw.includes('New bets are paused')) return 'New bets are paused. Existing bets can still be settled and claimed.'
  if (raw.includes('already resolved')) return 'This bet was already resolved. Its receipt has been refreshed.'
  if (raw.includes('no payout to claim')) return 'There is no payout available to claim. Check the latest receipt.'
  if (raw.includes('unallocated NEAR')) return 'The contract needs more storage collateral before it can accept new bets.'
  if (raw.includes('Bet has expired')) return 'The settlement window expired. The stake is eligible for refund.'
  return 'The contract rejected this transaction. Check its details on NearBlocks.'
}
