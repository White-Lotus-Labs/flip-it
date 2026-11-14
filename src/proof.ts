import { bls12_381 } from '@noble/curves/bls12-381'
import { CONTRACT, getBank, winningPayout, betFeeBps, type Bet } from './near.ts'

const KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d'
  + '1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a'
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'

function u64(value: string) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}

async function sha256(...inputs: Uint8Array[]) {
  const data = new Uint8Array(inputs.reduce((size, input) => size + input.length, 0))
  let offset = 0
  for (const input of inputs) {
    data.set(input, offset)
    offset += input.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export async function verifyBet(bet: Bet) {
  if (!bet.signature || !/^[a-f0-9]{96}$/.test(bet.signature)) throw new Error('This receipt has no drand proof.')
  const signature = Uint8Array.from(bet.signature.match(/../g)!, value => parseInt(value, 16))
  if (!bls12_381.verifyShortSignature(signature, await sha256(u64(bet.round)), KEY, { DST })) {
    throw new Error('The drand signature failed verification.')
  }
  const domain = new TextEncoder().encode('coin-toss:v1\0' + CONTRACT + '\0')
  const digest = await sha256(domain, u64(bet.bet_id), await sha256(signature))
  const side = digest[0] & 1 ? 'tails' : 'heads'
  const won = side === bet.side
  const bank = await getBank()
  const feeBps = betFeeBps(bet.bet_id, bank)
  const winPayout = winningPayout(bet.stake, feeBps)
  if (
    side !== bet.result || (won ? 'won' : 'lost') !== bet.outcome ||
    bet.win_fee_bps !== feeBps || BigInt(bet.win_payout) !== winPayout ||
    BigInt(bet.payout) !== (won ? winPayout : 0n) ||
    BigInt(bet.fee) !== (won ? 2n * BigInt(bet.stake) - winPayout : 0n)
  ) throw new Error('The independently calculated result differs from this receipt.')
  return side
}
