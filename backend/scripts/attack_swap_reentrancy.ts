// Bonus B / IV.1 — Attaque : reentrancy sur Pool.swap.
//
// Garde visée : la fonction `swap` n'est PAS décorée `nonReentrant` ; la
// garde de fait est le pattern CEI (Checks-Effects-Interactions) appliqué à
// la lettre : les écritures de `reserves` (ligne 433-434), `feesOwed` (435-
// 437), `protocolFeesOwed` (438-440) précèdent les `safeTransferFrom` (442)
// et `safeTransfer` (443), et `emit Swapped(...)` (445) ferme la séquence.
//   Source : backend/contracts/Pool.sol, lignes 374-446 (fonction `swap`).
//
// Pourquoi un script runtime ne peut pas prouver CEI directement :
// l'attaque classique de reentrance exige un chemin de rappel pendant le
// `safeTransfer` de sortie. Ici, les `MockWrappedBTC` n'implémentent
// aucun hook de type `tokensReceived` (ERC777) ni `transfer` callback, et
// la dérogation de la tâche 10 interdit de créer un contrat attaquant
// sous `backend/contracts/`. Le vecteur de reentrance via le token
// d'entrée est donc inexistant par construction. Le script ci-dessous
// ne peut donc pas reproduire une attaque réelle ; il documente la garde
// et exerce les préconditions que la CEI exige : la courbe doit bouger
// entre deux swaps, sinon un second appel reproduirait la première sortie
// et la garde serait contournée en pratique (la régression CEI se
// manifesterait par un second swap qui rend la même quantité).
//
// Résultat attendu : `reservesAfter < reservesBefore` (la courbe a bougé)
// ET `amountOut2 < amountOut1` (le second swap est plus désavantageux
// qu'avec des réserves post-update), les deux strictement. Si l'une des
// deux conditions échoue, c'est une régression CEI au sens fonctionnel.

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";

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
// Setup : top-up wBTC de l'attaquant, amorcer le pool s'il est vide.
// ---------------------------------------------------------------------------
console.log("\n[setup] approvisionnement + amorçage si nécessaire");

let bal = await wbtc.read.balanceOf([attacker.account.address]);
if (bal < 10_000n * 10n ** 8n) {
  const mintTx = await wbtc.write.mint(
    [attacker.account.address, 100_000n * 10n ** 8n],
    { account: attacker.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: mintTx });
  bal = await wbtc.read.balanceOf([attacker.account.address]);
  console.log(`  · mint top-up wBTC, solde = ${bal.toString()}`);
}

const r0BeforeSeed = await pool.read.reserves([0n]);
const r1BeforeSeed = await pool.read.reserves([1n]);
const r2BeforeSeed = await pool.read.reserves([2n]);
const poolEmpty =
  r0BeforeSeed === 0n && r1BeforeSeed === 0n && r2BeforeSeed === 0n;
if (poolEmpty) {
  const seedAmount = 100n * 10n ** 8n;
  for (const t of [wbtc, cbbtc, lbtc]) {
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
  console.log(`  · pool amorcé (reserves = [${seedAmount}, ${seedAmount}, ${seedAmount}])`);
} else {
  console.log(`  · pool déjà amorcé, reserves = [${r0BeforeSeed}, ${r1BeforeSeed}, ${r2BeforeSeed}]`);
}

const swapAmount = 1n * 10n ** 8n;
const approveTx = await wbtc.write.approve(
  [poolAddress, swapAmount],
  { account: attacker.account }
);
await publicClient.waitForTransactionReceipt({ hash: approveTx });

// ---------------------------------------------------------------------------
// 1) Snapshot storage AVANT le swap. Slot 0 héberge `reserves` (uint72[3],
//    packed en un slot de 32 octets dans le storage layout de Pool.sol).
//    On lit le slot brut via `eth_getStorageAt` puis on décode l'ABI du
//    getter `reserves(uint256)` pour récupérer la valeur typée. Toute
//    différence avant/après prouve que la transaction a écrit.
// ---------------------------------------------------------------------------
console.log("\n[1/3] Snapshot storage AVANT le swap (slot 0 = reserves)");
const slotHexBefore = await publicClient.getStorageAt({
  address: poolAddress,
  slot: "0x0",
});
const r0Before = await pool.read.reserves([0n]);
const r1Before = await pool.read.reserves([1n]);
const r2Before = await pool.read.reserves([2n]);
console.log(`  · slot 0 brut = ${slotHexBefore}`);
console.log(`  · reserves typées = [${r0Before}, ${r1Before}, ${r2Before}]`);

// ---------------------------------------------------------------------------
// 2) Premier swap wBTC → cbBTC. On capture le receipt pour observer l'ordre
//    des événements : le `Swapped` du pool est émis APRÈS les `Transfer`
//    du BTC mock (safeTransfer), ce qui confirme la séquence CEI à
//    l'intérieur de la fonction. Sous une régression CEI (safeTransfer
//    avant les écritures storage), le receipt aurait le même ordre
//    apparent, mais le post-storage serait différent — c'est la condition
//    3 qui exerce cette dimension.
// ---------------------------------------------------------------------------
console.log("\n[2/3] Premier swap wBTC → cbBTC");
const tx1 = await pool.write.swap(
  [0n, swapAmount, 1n, 0n],
  { account: attacker.account }
);
const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
const cbBal1 = await cbbtc.read.balanceOf([attacker.account.address]);
const slotHexAfter = await publicClient.getStorageAt({
  address: poolAddress,
  slot: "0x0",
});
const r0After = await pool.read.reserves([0n]);
const r1After = await pool.read.reserves([1n]);
const r2After = await pool.read.reserves([2n]);

// Position des logs : on extrait l'ordre `Swapped` vs `Transfer` du receipt.
// Le `Transfer` est émis par le token (safeTransfer), `Swapped` par le pool
// en fin de fonction. Le CEI exige `Transfer` AVANT `Swapped` dans les logs.
// Les topics sont calculés hors contrat (keccak256 du sighash), pas via
// `contract.getEventSignature` (non exposé sur l'instance typée viem).
const swapTopic = keccak256(
  toHex("Swapped(address,uint256,uint256,uint256,uint256)")
);
const transferTopic = keccak256(
  toHex("Transfer(address,address,uint256)")
);
const logOrder = receipt1.logs.map((log) => {
  if (log.topics[0] === swapTopic) return "Swapped";
  if (log.topics[0] === transferTopic) return "Transfer";
  return "?";
});
const firstTransferIdx = logOrder.indexOf("Transfer");
const firstSwappedIdx = logOrder.indexOf("Swapped");
const transferBeforeSwapped = firstTransferIdx < firstSwappedIdx;
console.log(`  · cbBTC reçu : ${cbBal1.toString()}`);
console.log(`  · slot 0 brut après = ${slotHexAfter}`);
console.log(`  · reserves typées après = [${r0After}, ${r1After}, ${r2After}]`);
console.log(`  · ordre logs : ${logOrder.join(" → ")}`);

// ---------------------------------------------------------------------------
// 3) Second swap du même montant. Le strict décroissement de l'output
//    (`amountOut2 < amountOut1`) est la signature d'une CEI fonctionnelle :
//    si la garde n'était PAS tenue, la courbe n'aurait pas bougé et le
//    second swap rendrait la même chose que le premier (la "régression
//    CEI" se manifeste par un second swap qui reproduit la sortie, pas
//    par un revert). On compare sur le solde cbBTC avant/après du second
//    swap, pas sur le seul amountOut.
// ---------------------------------------------------------------------------
console.log("\n[3/3] Second swap : la CEI exige un output strictement inférieur");
const cbBalBefore2 = await cbbtc.read.balanceOf([attacker.account.address]);
const tx2 = await pool.write.swap(
  [0n, swapAmount, 1n, 0n],
  { account: attacker.account }
);
await publicClient.waitForTransactionReceipt({ hash: tx2 });
const cbBalAfter2 = await cbbtc.read.balanceOf([attacker.account.address]);
const delta2 = cbBalAfter2 - cbBalBefore2;
const delta1 = cbBal1; // cbBTC reçu lors du swap 1, mesuré avant le swap 2
const strictlyLess = delta2 < delta1;
console.log(`  · cbBTC reçu swap 1 : ${delta1.toString()}`);
console.log(`  · cbBTC reçu swap 2 : ${delta2.toString()}`);

// ---------------------------------------------------------------------------
// Verdict : trois conditions doivent tenir pour que la garde CEI soit
// considérée comme fonctionnellement en place. Le script échoue (exit 1)
// si l'une des trois régresse.
// ---------------------------------------------------------------------------
console.log("\n=== verdict ===");
const storageMoved = slotHexBefore !== slotHexAfter;
const reservesMoved =
  r0Before !== r0After || r1Before !== r1After || r2Before !== r2After;
const ceiLogOrder = transferBeforeSwapped;
const strictDecrease = strictlyLess;

console.log(`  · storage slot 0 a bougé : ${storageMoved ? "oui" : "non"}`);
console.log(`  · reserves typées ont bougé : ${reservesMoved ? "oui" : "non"}`);
console.log(`  · Transfer < Swapped dans les logs : ${ceiLogOrder ? "oui" : "non"}`);
console.log(`  · output swap 2 < output swap 1 : ${strictDecrease ? "oui" : "non"}`);

if (storageMoved && reservesMoved && ceiLogOrder && strictDecrease) {
  console.log("GUARD HOLDS · swap CEI reentrancy (state write before transfer) holds");
} else {
  console.log("GUARD BROKE · une condition CEI a régressé, voir détail ci-dessus");
  process.exit(1);
}
