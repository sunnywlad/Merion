// V.0 — Approvisionne le faucet MRN avec 10 M de MRN depuis le déployeur.
// À lancer APRÈS `npx hardhat ignition deploy ignition/modules/merion.ts --network <net>` :
//
//   npx hardhat run scripts/seed-faucet.ts --network localhost
//
// Adresses lues depuis `ignition/deployments/chain-<id>/deployed_addresses.json`
// pour rester en phase avec ce que le front va chercher dans `addresses.ts`.
// Aucun argument : la résolution des adresses se fait dans le script, le déployeur
// est le compte 0 du réseau ciblé (sur Hardhat) ou la clé configurée (sur Sepolia).

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FUNDING_AMOUNT = 10_000_000n * 10n ** 18n; // 10 M MRN à 18 décimales

const { viem, networkName } = await network.getOrCreate();
const [deployer] = await viem.getWalletClients();
if (!deployer) throw new Error("Aucun wallet client disponible");

// `networkName` est `hardhatMainnet`, `hardhatOp`, `localhost`, `sepolia`, etc.
// L'id de chaîne lu dynamiquement évite d'avoir à le hardcoder.
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

// `ignition/deployments/chain-<id>/deployed_addresses.json` est le registre
// d'Ignition pour cette chaîne. Si le chemin n'existe pas, le déploiement
// n'a pas encore tourné.
const journalPath = join(
  "ignition", "deployments", `chain-${chainId}`, "deployed_addresses.json"
);
const registry = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, string>;

const faucetAddress = registry["MrnFaucetModule#MrnFaucet"] as `0x${string}` | undefined;
const mrnAddress = registry["MRNModule#MRN"] as `0x${string}` | undefined;

if (!faucetAddress || !mrnAddress) {
  throw new Error(
    `Adresses manquantes dans ${journalPath}. Lancer d'abord ` +
    `'npx hardhat ignition deploy ignition/modules/merion.ts --network ${networkName}'.`
  );
}

console.log(`Réseau : ${networkName} (chainId ${chainId})`);
console.log(`Déployeur : ${deployer.account.address}`);
console.log(`MRN       : ${mrnAddress}`);
console.log(`Faucet    : ${faucetAddress}`);

const mrn = await viem.getContractAt("MRN", mrnAddress);
const deployerBalance = await mrn.read.balanceOf([deployer.account.address]);
console.log(`Solde MRN déployeur : ${(Number(deployerBalance) / 1e18).toLocaleString("fr-FR")} MRN`);

if (deployerBalance < FUNDING_AMOUNT) {
  throw new Error(
    `Solde insuffisant : ${(Number(deployerBalance) / 1e18).toLocaleString("fr-FR")} MRN, ` +
    `il faut ${(Number(FUNDING_AMOUNT) / 1e18).toLocaleString("fr-FR")} MRN.`
  );
}

console.log("Transfert de 10 000 000 MRN vers le faucet...");
const txHash = await mrn.write.transfer([faucetAddress, FUNDING_AMOUNT], {
  account: deployer.account,
});
await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log(`OK · tx ${txHash}`);

const faucetBalance = await mrn.read.balanceOf([faucetAddress]);
console.log(
  `Solde faucet : ${(Number(faucetBalance) / 1e18).toLocaleString("fr-FR")} MRN ` +
  `(${(Number(faucetBalance) / 1e18 / 5000).toLocaleString("fr-FR")} drips possibles)`
);
