import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.36",
        settings: {
          viaIR: true,
        },
      },
      production: {
        version: "0.8.36",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  chainDescriptors: {
    84532: {
      name: "Base Sepolia",
      chainType: "op",
      blockExplorers: {
        etherscan: {
          name: "Basescan",
          url: "https://sepolia-explorer.base.org",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      chainId: 84532,
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("BASE_SEPOLIA_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
