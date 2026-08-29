# chain-84532 — Base Sepolia

Stub registry that lets `scripts/seed-faucet.ts` find the deployed
addresses for the Base Sepolia network when invoked via
`npx hardhat run scripts/seed-faucet.ts --network baseSepolia`.

## Maintenance

Ignition writes this file automatically when run on chain 84532
(`npx hardhat ignition deploy ignition/modules/merion.ts --network baseSepolia`).
When you re-deploy to Base Sepolia, re-run ignition so the registry
stays in sync with the on-chain addresses. Without this file, the
seed-faucet script throws because it cannot resolve
`MRNModule#MRN` and `MrnFaucetModule#MrnFaucet`.
