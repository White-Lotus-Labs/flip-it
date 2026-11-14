import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { bls12_381 } from '@noble/curves/bls12-381'
import { Account, Connection, InMemorySigner, keyStores, KeyPair, providers, transactions, utils } from 'near-api-js'

const networkId = 'testnet'
const nodeUrl = 'https://rpc.testnet.fastnear.com'
const faucetUrl = 'https://helper.nearprotocol.com/account'
const beaconUrl = 'https://api.drand.sh/v2/beacons/quicknet/rounds'
const beaconKey = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d'
  + '1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a'
const beaconDst = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'
const contract = process.env.COIN_TOSS_CONTRACT ?? 'coin-toss-mvp-20261105.testnet'
const accountId = process.env.NEAR_ACCOUNT_ID
const wasmPath = new URL('../target/near/coin_toss.wasm', import.meta.url)
const credentialDir = process.env.COIN_TOSS_CREDENTIALS ?? join(homedir(), '.near-credentials')
const gas = 100_000_000_000_000n
const [command, ...args] = process.argv.slice(2)
const output = (value) => console.log(JSON.stringify(value, null, 2))

class FinalRpcProvider extends providers.JsonRpcProvider {
  sendTransaction(transaction) {
    return this.sendTransactionUntil(transaction, 'FINAL')
  }
}

function testnetAccount(id) {
  if (!id || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/.test(id) || id.length > 64) {
    throw new Error('Use a named .testnet account')
  }
  return id
}

function nearAmount(amount) {
  if (!/^\d+(?:\.\d{1,24})?$/.test(amount ?? '')) {
    throw new Error('Enter an amount in NEAR with up to 24 decimals')
  }
  return utils.format.parseNearAmount(amount)
}

function betId(value) {
  if (!/^\d+$/.test(value ?? '') || BigInt(value) >= 2n ** 64n) {
    throw new Error('Enter the bet ID from its receipt')
  }
  return BigInt(value).toString()
}

async function createAccount(id) {
  testnetAccount(id)
  const dir = join(credentialDir, networkId)
  const file = join(dir, `${id}.json`)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  let publicKey
  try {
    publicKey = JSON.parse(await readFile(file, 'utf8')).public_key
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const key = KeyPair.fromRandom('ed25519')
    publicKey = key.getPublicKey().toString()
    await writeFile(file, JSON.stringify({
      account_id: id,
      public_key: publicKey,
      private_key: key.toString(),
    }), { flag: 'wx', mode: 0o600 })
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey ?? '')) {
    throw new Error('Credential file has an invalid public key')
  }

  const response = await fetch(faucetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Faucet returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  }
  const result = await response.json()
  if (!result.status || !('SuccessValue' in result.status)) throw new Error('Faucet transaction failed')
  output({ account_id: id, tx: result.transaction.hash })
}

async function nearAccount(signed) {
  if (signed) testnetAccount(accountId)
  const provider = new FinalRpcProvider({ url: nodeUrl })
  const actual = await provider.status()
  if (actual.chain_id !== networkId) throw new Error('Expected the NEAR testnet RPC')
  const signer = new InMemorySigner(new keyStores.UnencryptedFileSystemKeyStore(credentialDir))
  return new Account(new Connection(networkId, provider, signer), signed ? accountId : contract)
}

async function view(methodName, args = {}) {
  const account = await nearAccount(false)
  return account.viewFunction({ contractId: contract, methodName, args, blockQuery: { finality: 'final' } })
}

async function call(methodName, args = {}, amount = '0') {
  const account = await nearAccount(true)
  const tx = await account.functionCall({
    contractId: contract,
    methodName,
    args,
    gas,
    attachedDeposit: BigInt(amount),
  })
  return { tx: tx.transaction.hash, result: providers.getTransactionLastResult(tx) }
}

async function deploy(owner = contract) {
  testnetAccount(owner)
  if (accountId !== contract) throw new Error('Deploy from the contract account')
  const account = await nearAccount(true)
  if ((await account.state()).code_hash !== '11111111111111111111111111111111') {
    throw new Error('Deployment account already has a contract')
  }
  const tx = await account.signAndSendTransaction({
    receiverId: contract,
    actions: [
      transactions.deployContract(await readFile(wasmPath)),
      transactions.functionCall('new', { owner }, gas, 0n),
    ],
  })
  output({ tx: tx.transaction.hash, contract, owner })
}

async function settle(id) {
  const bet = await view('get_bet', { bet_id: id })
  if (!bet || bet.outcome !== 'pending') throw new Error('Bet must exist and be pending')
  const wait = Number(bet.round_at) * 1000 - Date.now()
  if (wait > 0) await sleep(wait)
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${beaconUrl}/${bet.round}`, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const { round, signature } = await response.json()
      if (String(round) !== bet.round || !/^[0-9a-f]{96}$/.test(signature)) {
        throw new Error('Unexpected quicknet response')
      }
      return call('settle_bet', { bet_id: id, signature })
    }
    if (![404, 425, 429].includes(response.status) && response.status < 500) {
      throw new Error(`Quicknet returned HTTP ${response.status}`)
    }
    await sleep(2_000)
  }
  throw new Error('Round is unavailable. Retry settlement with the same bet ID.')
}

function hash(...buffers) {
  return createHash('sha256').update(Buffer.concat(buffers)).digest()
}

async function verify(id) {
  const bet = await view('get_bet', { bet_id: id })
  const bank = await view('bank')
  if (!bet?.signature) throw new Error('Bet has no verified beacon signature yet')
  const idBytes = Buffer.alloc(8)
  idBytes.writeBigUInt64BE(BigInt(id))
  const roundBytes = Buffer.alloc(8)
  roundBytes.writeBigUInt64BE(BigInt(bet.round))
  const signature = Buffer.from(bet.signature, 'hex')
  if (!bls12_381.verifyShortSignature(signature, hash(roundBytes), beaconKey, { DST: beaconDst })) {
    throw new Error('Receipt has an invalid drand signature')
  }
  const randomness = hash(signature)
  const digest = hash(Buffer.from('coin-toss:v1\0'), Buffer.from(contract), Buffer.from([0]), idBytes, randomness)
  const result = digest[0] & 1 ? 'tails' : 'heads'
  const outcome = result === bet.side ? 'won' : 'lost'
  const feeBps = BigInt(id) < BigInt(bank.fee_start_bet_id) ? 0 : bank.win_fee_bps
  const gross = 2n * BigInt(bet.stake)
  const winPayout = gross - gross * BigInt(feeBps) / 10_000n
  const payout = outcome === 'won' ? winPayout : 0n
  const fee = outcome === 'won' ? gross - winPayout : 0n
  if (bet.win_fee_bps !== feeBps || bet.win_payout !== winPayout.toString() || bet.fee !== fee.toString()) throw new Error('Receipt fee differs from on-chain payout policy')
  if (result !== bet.result || outcome !== bet.outcome || payout.toString() !== bet.payout) {
    throw new Error('Recomputed result does not match the on-chain receipt')
  }
  return { bet_id: id, round: bet.round, signature: bet.signature, result, outcome, payout: bet.payout, fee: bet.fee, win_fee_bps: feeBps }
}

async function main() {
  testnetAccount(contract)
  const [first, second] = args
  switch (command) {
    case 'account': return createAccount(first)
    case 'deploy': return deploy(first)
    case 'upgrade': {
      if (accountId !== contract) throw new Error('Upgrade from the contract account')
      if (!(await view('bank')).paused) throw new Error('Pause new bets before upgrading')
      const account = await nearAccount(true)
      const tx = await account.signAndSendTransaction({ receiverId: contract, actions: [
        transactions.deployContract(await readFile(wasmPath)),
        transactions.functionCall('migrate', {}, gas, 0n),
      ] })
      if (!tx.status || !('SuccessValue' in tx.status)) throw new Error('Contract upgrade failed')
      return output({ tx: tx.transaction.hash, bank: await view('bank') })
    }
    case 'bank': return output(await view('bank'))
    case 'fund': return output(await call('fund_bank', {}, nearAmount(first)))
    case 'bet':
      if (first !== 'heads' && first !== 'tails') throw new Error('Choose heads or tails')
      {
        const bank = await view('bank')
        const gross = BigInt(nearAmount(second)) * 2n
        const expected_payout = (gross - gross * BigInt(bank.win_fee_bps) / 10_000n).toString()
        return output(await call('place_bet', { side: first, expected_payout }, nearAmount(second)))
      }
    case 'receipt': return output(await view('get_bet', { bet_id: betId(first) }))
    case 'settle': return output(await settle(betId(first)))
    case 'verify': return output(await verify(betId(first)))
    case 'refund': return output(await call('refund_expired_bet', { bet_id: betId(first) }))
    case 'claim': return output(await call('claim', { bet_id: betId(first) }))
    case 'withdraw': return output(await call('withdraw_bank', { amount: nearAmount(first) }))
    case 'pause':
    case 'resume': return output(await call('set_paused', { paused: command === 'pause' }))
    default:
      throw new Error('Usage: npm run coin-toss -- account|deploy|upgrade|bank|fund|bet|receipt|settle|verify|refund|claim|withdraw|pause|resume [args]')
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
