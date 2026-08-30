// Mesure du cout de deploiement des cinq contrats, avec les arguments de
// constructeur REELS, ceux des modules Ignition de `ignition/modules/`.
//
// Pourquoi ce script en plus de `--gas-stats`. L'outil integre de Hardhat
// rapporte `deployment.min/max/avg/median` agrege sur toute la suite de
// tests : les contrats y sont deployes avec les arguments des fixtures, qui
// ne sont pas ceux de la production, et la moyenne melange des deploiements
// aux parametres differents. Ce script deploie UNE fois chacun, avec les
// arguments qui partiront en production, et rend un chiffre unique et
// reproductible. Les deux sources sont complementaires, pas redondantes :
// l'outil couvre le cout d'appel des fonctions, ce script couvre le cout de
// deploiement nominal.
//
// A lancer imperativement en profil `production`, sans quoi le bytecode
// mesure n'est pas celui qui sera deploye :
//
//   npx hardhat run scripts/measure-deployment.ts --build-profile production
//
// `runtimeSize` est la taille du bytecode deploye, en octets. C'est la
// metrique stable : elle ne depend ni des arguments, ni du nonce, ni de
// l'ordre des transactions. Le `gasUsed`, lui, inclut le cout du calldata du
// constructeur, donc il bouge avec les arguments.

import { artifacts, network } from "hardhat";

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const owner = deployer.account.address;

// Constantes recopiees des modules Ignition. Toute divergence ici rend la
// mesure fausse sans le dire : voir ignition/modules/pool.ts, auction.ts et
// mrnFaucet.ts.
const EPOCH_DURATION = 14400;
const PRIORITY_WINDOW = 240;
const MIN_FEE_NUM = 1;
const NOMINAL_FEE_NUM = 5;
const TREASURY = "0xE280AD145C1ab859A05D7a4b1Ba2E6AC208A1a85";

const AUCTION_WINDOW = 900;
const MAX_EXTENSION = 0;
const BID_SILENCE = 60;
const MIN_OPENING_BID = 10_000_000_000_000_000_000n;

const DRIP_AMOUNT = 5_000n * 10n ** 18n;
const DRIP_INTERVAL = 8 * 60 * 60;

type Row = { contrat: string; gasUsed: number; runtimeSize: number };
const rows: Row[] = [];

// Deploie, attend le recu, releve le gaz consomme et la taille runtime lue
// dans l'artefact. `sendDeploymentTransaction` (et non `deployContract`) est
// le seul point d'entree qui rend la transaction, donc le seul qui donne
// acces au `gasUsed`.
async function measure(name: string, args: unknown[], label = name) {
  const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction(
    name as never,
    args as never,
  );
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deploymentTransaction.hash,
  });
  const { deployedBytecode } = await artifacts.readArtifact(name);
  rows.push({
    contrat: label,
    gasUsed: Number(receipt.gasUsed),
    runtimeSize: (deployedBytecode.length - 2) / 2,
  });
  return contract;
}

const wbtc = await measure("MockWrappedBTC", ["Wrapped BTC", "wBTC"], "MockWrappedBTC (wBTC)");
const cbbtc = await measure("MockWrappedBTC", ["Coinbase BTC", "cbBTC"], "MockWrappedBTC (cbBTC)");
const lbtc = await measure("MockWrappedBTC", ["Lombard BTC", "LBTC"], "MockWrappedBTC (LBTC)");
const mrn = await measure("MRN", []);

const pool = await measure("Pool", [
  [wbtc.address, cbbtc.address, lbtc.address],
  EPOCH_DURATION,
  PRIORITY_WINDOW,
  MIN_FEE_NUM,
  NOMINAL_FEE_NUM,
  TREASURY,
  mrn.address,
  owner,
]);

await measure("Auction", [
  pool.address,
  mrn.address,
  AUCTION_WINDOW,
  MAX_EXTENSION,
  BID_SILENCE,
  MIN_OPENING_BID,
]);

await measure("MrnFaucet", [mrn.address, DRIP_AMOUNT, DRIP_INTERVAL, owner]);

console.log("\nCout de deploiement — arguments reels (ignition/modules/)\n");
console.log("| Contrat | Gaz de deploiement | Taille runtime (octets) |");
console.log("|---|---|---|");
for (const r of rows) {
  console.log(
    `| \`${r.contrat}\` | ${r.gasUsed.toLocaleString("fr-FR")} | ${r.runtimeSize.toLocaleString("fr-FR")} |`,
  );
}
const total = rows.reduce((sum, r) => sum + r.gasUsed, 0);
console.log(`\nTotal du deploiement complet : ${total.toLocaleString("fr-FR")} gaz`);
console.log("Limite EIP-170 : 24 576 octets par contrat.\n");
