import {
  CONTRACT, getBet, getTransaction, isTxHash, matchIntent, parseBetId,
  returnedBetId, transactionFailure, transactionResult,
  type Intent, type Method, type Bet,
} from './near.ts'
import { sendIntent } from './wallet.ts'

const intentKey = `coin-toss:${CONTRACT}:intent`
const lastKey = (account: string) => `coin-toss:${CONTRACT}:last:${account}`

export function readIntent(): Intent | null {
  try { return JSON.parse(localStorage.getItem(intentKey) ?? 'null') }
  catch { return null }
}

function saveIntent(intent: Intent | null) {
  if (intent) localStorage.setItem(intentKey, JSON.stringify(intent))
  else localStorage.removeItem(intentKey)
}

export function lastBet(account: string) {
  try { return parseBetId(JSON.parse(localStorage.getItem(lastKey(account)) ?? 'null')) }
  catch { return null }
}

export function openBetUrl(id: string | null) {
  const url = new URL(location.href)
  url.search = ''
  if (id !== null) url.searchParams.set('bet', id)
  history.replaceState(null, '', url)
}

export async function confirmIntent(intent: Intent): Promise<Bet | null> {
  if (!intent.hash) throw new Error('Check your wallet and enter the transaction hash to continue.')
  const tx = await getTransaction(intent.hash, intent.signer)
  matchIntent(tx, intent)
  const result = transactionResult(tx)
  if (result === undefined) {
    saveIntent(null)
    throw new Error(transactionFailure(tx))
  }
  if (intent.method === 'fund_bank') {
    if (!result || typeof result !== 'object' || !('free' in result)) throw new Error('The transaction result is unavailable. Keep its hash for recovery.')
    saveIntent(null)
    return null
  }
  const id = intent.method === 'place_bet' ? returnedBetId(result, intent.signer) : intent.args.bet_id
  if (!id || (intent.method === 'claim' ? typeof result !== 'boolean' : returnedBetId(result) !== id)) {
    throw new Error('The transaction result is unavailable. Keep its hash for recovery.')
  }
  const bet = await getBet(id)
  if (!bet) throw new Error('The bet is still loading. Retry this transaction check shortly.')
  if (intent.method === 'place_bet') localStorage.setItem(lastKey(intent.signer), JSON.stringify(id))
  saveIntent(null)
  openBetUrl(id)
  return bet
}

export async function transact(signer: string, method: Method, args: Record<string, string>, deposit = '0') {
  if (readIntent()) throw new Error('Finish checking the previous wallet action before sending another.')
  let intent: Intent = { id: crypto.randomUUID(), signer, method, args, deposit }
  saveIntent(intent)
  try {
    const response = await sendIntent(intent)
    const hash = response?.transaction?.hash ?? response?.transaction_outcome?.id
    if (!hash || !isTxHash(hash)) throw new Error('No transaction hash returned. Check your wallet before retrying.')
    intent = { ...intent, hash }
    saveIntent(intent)
    return await confirmIntent(intent)
  } catch (error) {
    if (!intent.hash && error instanceof Error && /user (rejected|cancelled|canceled|denied)|rejected by user|popup (window )?blocked|wallet account changed/i.test(error.message)) {
      saveIntent(null)
    }
    throw error
  }
}

export async function recoverTransaction(hash?: string) {
  let intent = readIntent()
  if (!intent) throw new Error('There is no wallet action to recover. Open your bet from History.')
  const params = new URL(location.href).searchParams
  const callbackHash = params.get('intent') === intent.id ? params.get('transactionHashes') : null
  const txHash = hash?.trim() || intent.hash || callbackHash
  if (!txHash || !isTxHash(txHash)) throw new Error('Enter the transaction hash from your wallet.')
  intent = { ...intent, hash: txHash }
  saveIntent(intent)
  return confirmIntent(intent)
}

export function clearIntent() {
  saveIntent(null)
}
