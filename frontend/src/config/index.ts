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

// V.5 (perf H) — Le nœud Hardhat local ne prédéploie PAS Multicall3
// (`eth_getCode 0xca11…ca11` renvoie `0x`). Déclarer malgré tout son
// adresse canonique faisait appeler une non-adresse : viem recevait `0x`,
// échouait au décodage en `ContractFunctionExecutionError`, et ce type
// d'erreur court-circuite le repli automatique de wagmi vers des lectures
// unitaires. On laisse donc `contracts` vide : `useMerionReadContracts`
// passe `deployless: true` sur 31337 (bytecode Multicall3 inline via
// `eth_call`, testé contre le nœud), et à défaut wagmi retombe sur des
// `readContract` un-à-un. `hardhat.id` reste 31337.
const hardhat: AppKitNetwork = { ...hardhatBase }

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
    // Côté navigateur, on passe par le proxy même-origine `/rpc/hardhat`
    // (rewrite dans `next.config.ts`) pour contourner l'absence de CORS
    // sur le nœud local. Côté serveur (SSR, pas d'origine, pas de CORS),
    // on tape le nœud en direct.
    [hardhat.id]: http(
      typeof window === 'undefined' ? 'http://127.0.0.1:8545' : '/rpc/hardhat'
    ),
    [baseSepolia.id]: http(baseRpcUrl)
  }
})

export const config = wagmiAdapter.wagmiConfig
