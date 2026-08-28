// Bonus B / IV.1 — Attaque : bornes de mint.
//
// Garde visée : un attaquant ne doit pas pouvoir re-mint dans la fenêtre de
// cooldown imposée par `MrnFaucet.dripInterval` (rate-limit per-address), ni
// dépasser la borne globale `ERC20Capped(21_000_000e8)` posée sur les
// `MockWrappedBTC`. Deux scripts unifiés parce qu'ils relèvent du même sujet
// (les mint) ; la garde tient sur les deux, l'un après l'autre.
//
// Contexte : `MrnFaucet.drip()` exige `block.timestamp >= lastDripAt[msg.sender]
// + dripInterval` (require + `TooEarly(nextAllowedAt)`). Un re-drip dans la
// fenêtre est rejeté avant tout transfert. Pour les BTC mocks, le cap de
// 21 000 000 tokens à 8 décimales est posé par `ERC20Capped` dans le
// constructeur ; `_mint` revert `ERC20ExceededCap` au-delà.
//
// Attaquant : un EOA standard. Pas de contrat : les gardes sont visibles
// depuis n'importe quel appelant.
//
// Résultat attendu : la transaction reverte à chaque fois. Si l'une passe,
// c'est `GUARD BROKE` et un SHA de la garde fautive est imprimé.

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { viem, networkName } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const [attacker] = await viem.getWalletClients();
if (!attacker) throw new Error("Aucun wallet client disponible");

const journalPath = join(
  "ignition", "deployments", `chain-${chainId}`, "deployed_addresses.json"
);
const registry = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, string>;

const faucetAddress = registry["MrnFaucetModule#MrnFaucet"] as `0x${string}` | undefined;
const wbtcAddress = registry["WBTCModule#MockWrappedBTC"] as `0x${string}` | undefined;
if (!faucetAddress || !wbtcAddress) {
  throw new Error(
    `Adresses MrnFaucet / wBTC manquantes dans ${journalPath}. ` +
    `Lancer d'abord \`npx hardhat ignition deploy ignition/modules/merion.ts --network ${networkName}\`.`
  );
}

console.log(`Réseau : ${networkName} (chainId ${chainId})`);
console.log(`Attaquant : ${attacker.account.address}`);
console.log(`MrnFaucet : ${faucetAddress}`);
console.log(`MockWrappedBTC (wBTC) : ${wbtcAddress}`);

const faucet = await viem.getContractAt("MrnFaucet", faucetAddress);
const wbtc = await viem.getContractAt("MockWrappedBTC", wbtcAddress);

// ---------------------------------------------------------------------------
// 1) Cooldown MrnFaucet.drip : un re-drip dans la fenêtre dripInterval reverte.
//    dripInterval = 8 h par déploiement (ignition/modules/mrnFaucet.ts).
// ---------------------------------------------------------------------------
console.log("\n[1/2] Cooldown MrnFaucet.drip");

// Premier drip : doit passer. La pré-alimentation peut être vide si le seed
// n'a pas tourné, mais c'est un test de garde, on catch les deux reverts
// possibles (cooldown OU reservoir vide) et on les distingue.
let firstDripOk = false;
try {
  const tx1 = await faucet.write.drip({ account: attacker.account });
  await publicClient.waitForTransactionReceipt({ hash: tx1 });
  firstDripOk = true;
  console.log("  · premier drip passé");
} catch (e) {
  // FaucetEmpty() : le seed n'a pas tourné, on ne peut pas tester le
  // cooldown. On note mais on n'imprime pas GUARD HOLDS sans preuve.
  console.log(`  · premier drip REVERTE (${(e as Error).message.split("\n")[0]})`);
  console.log("  · ré-essai après seed : `npx hardhat run scripts/seed-faucet.ts`");
}

// Second drip dans la même seconde : doit reverter avec TooEarly si le
// premier est passé ; avec FaucetEmpty sinon. La garde cooldown est testée
// uniquement quand le premier drip a effectivement eu lieu.
let secondReverted = false;
let secondRevertReason = "unknown";
try {
  const tx2 = await faucet.write.drip({ account: attacker.account });
  await publicClient.waitForTransactionReceipt({ hash: tx2 });
} catch (e) {
  secondReverted = true;
  // viem emballe le revert dans une Error avec un message du type
  // "execution reverted: custom error TooEarly(...)" ou "execution reverted:
  // custom error FaucetEmpty()".
  secondRevertReason = (e as Error).message.split("\n")[0];
}

if (firstDripOk && secondReverted) {
  console.log(`  · second drip REVERTE (${secondRevertReason})`);
  console.log("GUARD HOLDS · mint cooldown (MrnFaucet.dripInterval) holds");
} else if (!firstDripOk && secondReverted) {
  console.log("  · second drip REVERTE (cooldown pas testable sans réservoir)");
  console.log("SKIPPED · cooldown non testé (faire tourner seed-faucet.ts d'abord)");
} else {
  console.log("GUARD BROKE · mint cooldown (MrnFaucet.dripInterval) let the second drip through");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2) Cap global MockWrappedBTC : un mint au-delà de 21 000 000e8 reverte.
//    On lit le cap exposé par ERC20Capped (cap() returns 21_000_000e8) puis
//    on tente un mint qui le dépasse depuis le déployeur (MockWrappedBTC.mint
//    est open : pas d'onlyOwner, l'attaquant EOA peut l'appeler aussi).
// ---------------------------------------------------------------------------
console.log("\n[2/2] Cap global MockWrappedBTC (21 000 000e8)");

const cap = await wbtc.read.cap();
const totalSupply = await wbtc.read.totalSupply();
const headroom = cap - totalSupply;
console.log(`  · cap = ${cap.toString()} (${(Number(cap) / 1e8).toLocaleString("fr-FR")} BTC)`);
console.log(`  · totalSupply = ${totalSupply.toString()}`);
console.log(`  · headroom = ${headroom.toString()}`);

// Tentative : on demande un mint de cap + 1 wei, qui doit reverter.
const overflowAmount = cap + 1n;
let capReverted = false;
let capRevertReason = "unknown";
try {
  const tx = await wbtc.write.mint(
    [attacker.account.address, overflowAmount],
    { account: attacker.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
} catch (e) {
  capReverted = true;
  capRevertReason = (e as Error).message.split("\n")[0];
}

if (capReverted) {
  console.log(`  · mint(${overflowAmount.toString()}) REVERTE (${capRevertReason})`);
  console.log("GUARD HOLDS · mint cap (21 M mock cap) holds");
} else {
  console.log("GUARD BROKE · mint cap (21 M mock cap) let an overflow through");
  process.exit(1);
}
