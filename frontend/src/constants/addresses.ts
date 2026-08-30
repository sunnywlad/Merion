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
  // Entree Base Sepolia (chainId 84532), redeployee le 2026-08-30 par
  // `npx hardhat ignition deploy ignition/modules/merion.ts --network
  // baseSepolia --reset` apres passage de `PRIORITY_WINDOW` a 240 s.
  // Sept adresses neuves, une par contrat, plus la transaction
  // `Pool.setAuction` du batch final.
  84532: {
    tokens: [
      { name: "wBTC", address: "0x7A03f5560d04743194bBfD303D8345f8dAad4c72", index: 0n },
      { name: "cbBTC", address: "0xA913a98e22b05d335b3DAa441CCDbb582F5af265", index: 1n },
      { name: "LBTC", address: "0xdb87ACd86d4b06D637a206E1924818b1154420A3", index: 2n }
    ],
    pool: "0xd281B06b09589C12b70F9a52fcFa1aC71B2E953B" as `0x${string}`,
    auction: "0xa8BaF80093AA00EBB5416E10c908450124F8109f" as `0x${string}`,
    faucet: "0xd8C7aa392d43C045dCfd9E561111969495EACf31" as `0x${string}`,
    mrn: "0x28670e3EEb7801B053f4E9Ea808D45567698Ef03" as `0x${string}`
  }
} as const;

export type SupportedChainId = keyof typeof addresses;
export type ChainAddresses = (typeof addresses)[SupportedChainId];

/** Toutes les chaines pour lesquelles ce front a des adresses deployees. */
export const SUPPORTED_CHAIN_IDS = Object.keys(addresses).map(Number) as SupportedChainId[];

/** Noms lisibles, indexes par chaine, pour que l'UI ne recode jamais un ID en dur. */
export const CHAIN_NAMES: Record<SupportedChainId, string> = {
  31337: 'Hardhat (local)',
  84532: 'Base Sepolia',
};

/**
 * Le wallet est-il sur une chaine ou le pool existe reellement.
 *
 * Le test unique qui garde chaque ecriture. Il a remplace un `chainId !== 84532` code en dur
 * qui contredisait la table ci-dessus : les adresses etaient deja resolues par chaine, donc
 * un wallet Hardhat resolvait les bonnes adresses et etait quand meme refuse a chaque bouton.
 */
export function isSupportedChain(chainId: number | undefined): chainId is SupportedChainId {
  return chainId !== undefined && chainId in addresses;
}

/** Helper statique : chainId -> adresses, repli sur Base Sepolia. */
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
