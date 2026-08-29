// V.4 — câblage bi-réseau (Hardhat 31337 + Base Sepolia 84532).
//
// Avant (V.3), le front était verrouillé sur 84532 par une constante de
// module, optimisé pour le push Vercel. Le défaut a été remis à 84532
// (Base Sepolia) pour le SSR et toute chaîne non supportée, mais les
// addresses sont maintenant lues dynamiquement par le hook
// `src/hooks/useAddresses.ts` à partir de la chaîne connectée.
//
// Les exports nommés `deployedPool`, `deployedMrn`, etc. ont été
// supprimés : leur valeur figée au chargement du module ne pouvait pas
// suivre un changement de wallet. Voir le hook pour la version
// réactive. Seuls `MRN_DECIMALS` (constant dans MRN.sol) et le helper
// `getAddressesForChain` restent en export statique.

export const DEFAULT_CHAIN_ID = 84532 as const;

const addresses = {
  31337: {
    tokens: [
      { name: "wBTC", address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", index: 0n },
      { name: "cbBTC", address: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", index: 1n },
      { name: "LBTC", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", index: 2n }
    ],
    pool: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" as `0x${string}`,
    // I.5/I.6 — Reporter la valeur de `AuctionModule#Auction` à chaque
    // redéploiement local.
    auction: "0x0165878A594ca255338adfa4d48449f69242Eb8F" as `0x${string}` | null,
    // V.0 — Faucet MRN déployé par `MerionModule`, à reporter depuis
    // `MrnFaucetModule#MrnFaucet` à chaque redéploiement local.
    faucet: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" as `0x${string}` | null,
    mrn: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`
  },
  // V.3 / Tache 16 (voie deploiement) — Entree Base Sepolia (chainId 84532)
  // deployee le 2026-08-28 par `npx hardhat ignition deploy MerionModule
  // --network baseSepolia --reset`. Sept adresses, une par contrat, plus
  // le bloc final 46080606 et la transaction `Pool.setAuction`
  // (0x3558488ff4b0043a15b490bc487da1866cb40a01deeabda1017de07376f127c7)
  // consignes dans `01-suivi/nuit-2026-08-29/journal-nuit.md`.
  84532: {
    tokens: [
      { name: "wBTC", address: "0x070c5032577FBA6e5E6D5A6072b2Fd7E597CBAA7", index: 0n },
      { name: "cbBTC", address: "0xABAa17eBAD405331cBCe6209886C3B90a54c1e37", index: 1n },
      { name: "LBTC", address: "0x8eA819fd72F27a486fC98533535B9DE2E31bd8F4", index: 2n }
    ],
    pool: "0x352be1F6649BD86015D54288440466878424b165" as `0x${string}`,
    auction: "0x639FC7B13129BB546152d9Af402fF0319bF46b0f" as `0x${string}`,
    faucet: "0x793ac63fe5Df272e141dd43BD6602BB89dfA9aE0" as `0x${string}`,
    mrn: "0x7904893B731484508B1f62F28A9b1393862d1390" as `0x${string}`
  }
} as const;

export type SupportedChainId = keyof typeof addresses;
export type ChainAddresses = (typeof addresses)[SupportedChainId];

/** Static helper : chainId → addresses, default to Base Sepolia. */
export function getAddressesForChain(chainId: number | undefined): ChainAddresses {
  if (chainId !== undefined && chainId in addresses) {
    return addresses[chainId as SupportedChainId];
  }
  return addresses[DEFAULT_CHAIN_ID];
}

// MRN est un ERC-20 à 18 décimales, là où les trois wrappers BTC en portent
// 8. La constante est nommée pour que la distinction se voie sur chaque
// ligne d'affichage. Indépendante de la chaîne (codée en dur dans MRN.sol).
export const MRN_DECIMALS = 18;
