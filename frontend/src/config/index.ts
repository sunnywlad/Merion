import { http } from 'wagmi'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { hardhat, baseSepolia } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

const rawProjectId = process.env.NEXT_PUBLIC_PROJECT_ID
const baseRpcUrl = process.env.NEXT_PUBLIC_RPC_URL_BASE_SEPOLIA

if (!rawProjectId) {
  throw new Error('Project ID is not defined')
}
export const projectId: string = rawProjectId
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
  transports: {
    [hardhat.id]: http('http://127.0.0.1:8545'),
    [baseSepolia.id]: http(baseRpcUrl)
  }
})

export const config = wagmiAdapter.wagmiConfig
