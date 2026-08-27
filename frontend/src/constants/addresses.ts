const chainId = 31337;

const addresses = {
  31337: {
    tokens: {
      wbtc: {name : "wBTC", address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", index: 0n},
      cbbtc: {name : "cbBTC", address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", index: 1n},
      lbtc: {name : "LBTC", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", index: 2n}
    },
    pool: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    // I.5 — Une seule maison pour l'adresse, celle-ci. L'enchère n'a pas encore
    // d'entrée dans `ignition/deployments/chain-31337/deployed_addresses.json` :
    // `MerionModule` (MRN, Pool, Auction, puis `pool.setAuction`) n'a jamais
    // tourné sur cette chaîne, seuls les trois mocks et le Pool y figurent.
    // `null` plutôt qu'une adresse de fantaisie : les lectures se désactivent et
    // le panneau annonce une enchère non déployée, au lieu d'inonder
    // `ReadErrors` d'échecs qui ne disent rien de la chaîne. Reporter ici la
    // valeur de `MerionModule#Auction` dès que le module est déployé.
    auction: null as `0x${string}` | null
  }
} as const;

export const tokensInfo = Object.values(addresses[chainId].tokens);
export const deployedPool = addresses[chainId].pool;
export const deployedAuction = addresses[chainId].auction;

// Le loyer et les mises sont libellés en MRN, un ERC-20 à 18 décimales, là où
// les trois wrappers BTC en portent 8. La constante est nommée pour que la
// distinction se voie sur chaque ligne d'affichage.
export const MRN_DECIMALS = 18;
