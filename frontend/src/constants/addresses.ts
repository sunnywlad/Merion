const chainId = 31337;

const addresses = {
  31337: {
    tokens: {
      wbtc: {name : "wBTC", address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", index: 0n},
      cbbtc: {name : "cbBTC", address: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9", index: 1n},
      lbtc: {name : "LBTC", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", index: 2n}
    },
    pool: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    // I.5/I.6 — Une seule maison pour l'adresse, celle-ci. `MerionModule`
    // (MRN, Pool, Auction, puis `pool.setAuction`) tourne désormais sur cette
    // chaîne : reporter ici la valeur de `MerionModule#Auction` à chaque
    // redéploiement.
    auction: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707" as `0x${string}` | null,
    mrn: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  }
} as const;

export const tokensInfo = Object.values(addresses[chainId].tokens);
export const deployedPool = addresses[chainId].pool;
export const deployedAuction = addresses[chainId].auction;
export const deployedMrn = addresses[chainId].mrn;

// Le loyer et les mises sont libellés en MRN, un ERC-20 à 18 décimales, là où
// les trois wrappers BTC en portent 8. La constante est nommée pour que la
// distinction se voie sur chaque ligne d'affichage.
export const MRN_DECIMALS = 18;
