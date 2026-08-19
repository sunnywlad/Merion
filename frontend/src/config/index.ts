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
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [hardhat]

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
