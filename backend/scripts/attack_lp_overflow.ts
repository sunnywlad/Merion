// Bonus B / IV.1 — Attaque : overflow du removeLiquidity.
//
// Garde visée : `removeLiquidity` ne doit permettre ni de brûler plus de
// parts LP qu'un appelant n'en possède, ni d'extraire plus de tokens que
// la fraction du pool représentée par les parts brûlées. Deux gardes
// travaillent de concert :
//   1. `amountsOut[i] = cachedReserves[i] * _burnedShares / supply` plafonne
//      la sortie par la part proportionnelle (la division entière par
//      `supply` borne la sortie à la fraction détenue).
//   2. `_burn(msg.sender, _burnedShares)` revert (via ERC20Burnable) si
//      `_burnedShares` dépasse le solde de l'appelant, ce qui empêche
//      l'attaquant d'invoquer la fonction avec un montant usurpé.
//
// Attaquant : EOA standard qui dépose de la liquidité, prend connaissance
// de son solde LP, puis tente de brûler le double. La garde tient : le
// burn revert avant tout transfert.
//
// Résultat attendu : la transaction reverte sur `_burn`. Si le brûlage
// passe et qu'un transfert a lieu, c'est `GUARD BROKE`.

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

const poolAddress = registry["PoolModule#Pool"] as `0x${string}` | undefined;
const wbtcAddress = registry["WBTCModule#MockWrappedBTC"] as `0x${string}` | undefined;
const cbbtcAddress = registry["cbBTCModule#MockWrappedBTC"] as `0x${string}` | undefined;
const lbtcAddress = registry["LBTCModule#MockWrappedBTC"] as `0x${string}` | undefined;
if (!poolAddress || !wbtcAddress || !cbbtcAddress || !lbtcAddress) {
  throw new Error(
    `Adresses pool / wBTC / cbBTC / lBTC manquantes dans ${journalPath}. ` +
    `Lancer d'abord \`npx hardhat ignition deploy ignition/modules/merion.ts --network ${networkName}\`.`
  );
}

console.log(`Réseau : ${networkName} (chainId ${chainId})`);
console.log(`Attaquant : ${attacker.account.address}`);
console.log(`Pool : ${poolAddress}`);

const pool = await viem.getContractAt("Pool", poolAddress);
const wbtc = await viem.getContractAt("MockWrappedBTC", wbtcAddress);
const cbbtc = await viem.getContractAt("MockWrappedBTC", cbbtcAddress);
const lbtc = await viem.getContractAt("MockWrappedBTC", lbtcAddress);

// ---------------------------------------------------------------------------
// Setup : amorcer le pool, déposer de la liquidité depuis l'attaquant pour
// avoir un solde LP. Si l'amorçage existe déjà, on dépose quand même
// (loadFixture) — on enchaîne addLiquidity en bypassant le seed.
// ---------------------------------------------------------------------------
console.log("\n[setup] amorçage et dépôt LP de l'attaquant");

// Approve + mint + addLiquidity. Trois approbations (les trois mocks),
// un seul addLiquidity.
const seedAmount = 100n * 10n ** 8n; // 100 tokens de chaque jambe
for (const t of [wbtc, cbbtc, lbtc]) {
  const m = await t.write.mint(
    [attacker.account.address, 10_000n * 10n ** 8n],
    { account: attacker.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: m });
  const a = await t.write.approve(
    [poolAddress, seedAmount],
    { account: attacker.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: a });
}

const addTx = await pool.write.addLiquidity(
  [0n, seedAmount, 0n],
  { account: attacker.account }
);
await publicClient.waitForTransactionReceipt({ hash: addTx });

const lpBalance = await pool.read.balanceOf([attacker.account.address]);
const supply = await pool.read.totalSupply();
console.log(`  · LP balance attaquant : ${lpBalance.toString()}`);
console.log(`  · LP total supply     : ${supply.toString()}`);

if (lpBalance === 0n) {
  throw new Error(
    "L'attaquant n'a pas reçu de LP après addLiquidity — abandon de l'attaque."
  );
}

// ---------------------------------------------------------------------------
// 1) Tentative de burn 2 × le solde LP. La garde ERC20Burnable._burn doit
//    revert (insufficient balance) AVANT tout transfert. Les _minOut sont
//    à zéro : on veut voir la garde de burn, pas le BadSlippage.
// ---------------------------------------------------------------------------
console.log("\n[1/1] Tentative de burn 2 × le solde LP");

const overflowShares = lpBalance * 2n;
let overflowReverted = false;
let overflowRevertReason = "unknown";
try {
  const tx = await pool.write.removeLiquidity(
    [overflowShares, [0n, 0n, 0n]],
    { account: attacker.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
} catch (e) {
  overflowReverted = true;
  overflowRevertReason = (e as Error).message.split("\n")[0];
}

if (overflowReverted) {
  console.log(`  · removeLiquidity(${overflowShares.toString()}) REVERTE (${overflowRevertReason})`);
  console.log("GUARD HOLDS · removeLiquidity burn cap (ERC20Burnable._burn) holds");
} else {
  console.log("GUARD BROKE · removeLiquidity a accepté un burn supérieur au solde");
  process.exit(1);
}
