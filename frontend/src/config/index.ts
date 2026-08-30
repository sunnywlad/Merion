import { http } from 'wagmi'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { hardhat as hardhatBase, baseSepolia } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

const rawProjectId = process.env.NEXT_PUBLIC_PROJECT_ID
const baseRpcUrl = process.env.NEXT_PUBLIC_RPC_URL_BASE_SEPOLIA

if (!rawProjectId) {
  throw new Error('Project ID is not defined')
}
export const projectId: string = rawProjectId

// V.5 (perf H) — Hardhat ne déclare pas Multicall3 nativement sur 31337,
// ce qui fait crasher tous les `useReadContracts` côté front avec
// `ChainDoesNotSupportContract`. On déclare l'adresse canonique
// 0xca11bde05977b3631167028862be2a173976ca11 à plat pour court-circuiter
// le déploiement côté nœud. Plan §8 (l. 117-128). `hardhat.id` reste 31337.
const hardhat: AppKitNetwork = {
  ...hardhatBase,
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11'
    }
  }
}

// V.4 — `hardhat` ajouté aux networks AppKit pour que le wallet modal
// propose le réseau local (chain 31337) à côté de Base Sepolia. Le
// transport pour 31337 était déjà câblé en dessous, mais l'absence du
// réseau dans la liste rendait la bascule impossible côté UI. L'ordre
// reflète le défaut : Base Sepolia d'abord, Hardhat en option de dev.
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [baseSepolia, hardhat]

//Set up the Wagmi Adapter (Config)
export const wagmiAdapter = new WagmiAdapter({
  ssr: true,
  projectId,
  networks,
  pollingInterval: { [baseSepolia.id]: 12_000, [hardhat.id]: 4_000 }, // épingle le défaut, plan §3 RPC
  transports: {
    [hardhat.id]: http('http://127.0.0.1:8545'),
    [baseSepolia.id]: http(baseRpcUrl)
  }
})

export const config = wagmiAdapter.wagmiConfig
