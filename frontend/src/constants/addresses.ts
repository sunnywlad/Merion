const chainId = 31337;

const addresses = {
  31337: {
    tokens: {
      wbtc: {name : "wBTC", address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", index: 0n},
      cbbtc: {name : "cbBTC", address: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", index: 1n},
      lbtc: {name : "LBTC", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", index: 2n}
    },
    pool: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    // I.5/I.6 — `MerionModule` (MRN, Pool, Auction, Faucet, puis
    // `pool.setAuction`) tourne désormais sur cette chaîne : reporter ici
    // la valeur de `AuctionModule#Auction` à chaque redéploiement.
    auction: "0x0165878A594ca255338adfa4d48449f69242Eb8F" as `0x${string}` | null,
    // V.0 — Faucet MRN déployé par `MerionModule`, à reporter depuis
    // `MrnFaucetModule#MrnFaucet` à chaque redéploiement.
    faucet: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9" as `0x${string}` | null,
    mrn: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  },
  // V.3 / Tache 16 (voie deploiement) — Entree Base Sepolia (chainId 84532)
  // deployee le 2026-08-28 par `npx hardhat ignition deploy MerionModule
  // --network baseSepolia --reset`. Sept adresses, une par contrat, plus
  // le bloc final 46080606 et la transaction `Pool.setAuction`
  // (0x3558488ff4b0043a15b490bc487da1866cb40a01deeabda1017de07376f127c7)
  // consignes dans `01-suivi/nuit-2026-08-29/journal-nuit.md`. Le
  // `chainId` au-dessus reste 31337 ; la tache 18 rebascule sur 84532
  // apres verification Basescan.
  84532: {
    tokens: {
      wbtc: {name : "wBTC", address: "0x070c5032577FBA6e5E6D5A6072b2Fd7E597CBAA7" as `0x${string}` | null, index: 0n},
      cbbtc: {name : "cbBTC", address: "0xABAa17eBAD405331cBCe6209886C3B90a54c1e37" as `0x${string}` | null, index: 1n},
      lbtc: {name : "LBTC", address: "0x8eA819fd72F27a486fC98533535B9DE2E31bd8F4" as `0x${string}` | null, index: 2n}
    },
    pool: "0x352be1F6649BD86015D54288440466878424b165" as `0x${string}` | null,
    auction: "0x639FC7B13129BB546152d9Af402fF0319bF46b0f" as `0x${string}` | null,
    faucet: "0x793ac63fe5Df272e141dd43BD6602BB89dfA9aE0" as `0x${string}` | null,
    mrn: "0x7904893B731484508B1f62F28A9b1393862d1390" as `0x${string}` | null
  }
} as const;

export const tokensInfo = Object.values(addresses[chainId].tokens);
export const deployedPool = addresses[chainId].pool;
export const deployedAuction = addresses[chainId].auction;
export const deployedFaucet = addresses[chainId].faucet;
export const deployedMrn = addresses[chainId].mrn;

// Le loyer et les mises sont libellés en MRN, un ERC-20 à 18 décimales, là où
// les trois wrappers BTC en portent 8. La constante est nommée pour que la
// distinction se voie sur chaque ligne d'affichage.
export const MRN_DECIMALS = 18;
