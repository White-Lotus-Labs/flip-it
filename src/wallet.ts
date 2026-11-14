import { NearConnector, type Account, type NearWalletBase } from '@hot-labs/near-connect'
import { CONTRACT, RPC, type Intent } from './near.ts'

const allowedWallets = new Set(['meteor-wallet', 'intear-wallet', 'near-cli'])

function isAllowedWallet(wallet: NearWalletBase) {
  return allowedWallets.has(wallet.manifest.id)
}

class CoinTossConnector extends NearConnector {
  override get availableWallets() {
    return super.availableWallets.filter(isAllowedWallet)
  }
}

let connector: CoinTossConnector | undefined

function getConnector() {
  connector ??= new CoinTossConnector({
    network: 'testnet',
    providers: { testnet: [RPC] },
    features: { signAndSendTransaction: true, signInWithoutAddKey: true },
    autoConnect: false,
  })
  return connector
}

export function watchWalletAccount(onChange: (account: string) => void) {
  const active = getConnector()
  let restoring = true
  const signIn = ({ wallet, accounts }: { wallet: NearWalletBase; accounts: Account[] }) => {
    restoring = false
    onChange(isAllowedWallet(wallet) ? accounts[0]?.accountId ?? '' : '')
  }
  const signOut = () => {
    restoring = false
    onChange('')
  }
  active.on('wallet:signIn', signIn)
  active.on('wallet:signOut', signOut)
  void active.getConnectedWallet().then(({ wallet, accounts }) => {
    if (restoring) signIn({ wallet, accounts })
  }).catch(() => {
    // A fresh browser has no previous wallet session to restore.
  })
  return () => {
    restoring = false
    active.off('wallet:signIn', signIn)
    active.off('wallet:signOut', signOut)
  }
}

export async function connectWallet() {
  const active = getConnector()
  await active.whenManifestLoaded
  if (active.availableWallets.length === 0) {
    throw new Error('Wallet options could not be loaded. Refresh and try again.')
  }
  await active.connect()
}

export async function disconnectWallet() {
  await getConnector().disconnect()
}

export async function sendIntent(intent: Intent) {
  const { wallet, accounts } = await getConnector().getConnectedWallet()
  if (!isAllowedWallet(wallet) || !accounts.some(account => account.accountId === intent.signer)) {
    throw new Error('The wallet account changed. Reconnect before signing.')
  }

  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  if (intent.args.bet_id) url.searchParams.set('bet', intent.args.bet_id)
  url.searchParams.set('intent', intent.id)
  history.replaceState(null, '', url)

  return wallet.signAndSendTransaction({
    network: 'testnet',
    signerId: intent.signer,
    receiverId: CONTRACT,
    actions: [{
      type: 'FunctionCall',
      params: {
        methodName: intent.method,
        args: intent.args,
        gas: '100000000000000',
        deposit: intent.deposit,
      },
    }],
  })
}
