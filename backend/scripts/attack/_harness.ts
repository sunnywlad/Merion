// SPDX-License-Identifier: MIT
//
// _harness.ts — Socle commun des scripts d'attaque (voie A, tâches 9 à 14).
//
// Ce module n'est PAS un script d'attaque : il pose les briques que les
// scripts à venir importent. Il n'est jamais exécuté seul.
//
//   1. connectToLocalNode()        — connexion au nœud Hardhat local (chaîne 31337),
//                                    pattern calqué sur backend/scripts/seed-faucet.ts:11-32.
//   2. loadAddresses()             — registre d'adresses depuis
//                                    ignition/deployments/chain-<id>/deployed_addresses.json.
//   3. loadContracts()             — handles viem typés via getContractAt.
//   4. bootstrapPool()             — pool opérationnel : liquidité initiale 1:1:1
//                                    par le déployeur + financement d'un compte
//                                    attaquant. Reste dans la bande (13 %, 53 %).
//   5. expectRevert()              — affirme le NOM de l'erreur custom OU le
//                                    message du revert à chaîne, via deux
//                                    registres fermés (ERROR_OWNER et
//                                    STRING_REVERT_OWNER).
//   6. recordAttack() + finalize()  — sortie normalisée « attaque / attendu /
//                                    observé / verdict » + récapitulatif OK / ÉCHEC.
//
// Erreurs supportées (extraites de Pool.sol, MrnFaucet.sol, Auction.sol, et des
// erreurs OpenZeppelin héritées par Pool) : voir le registre `ERROR_OWNER` plus
// bas. L'ajout d'une erreur dans une nouvelle tâche se fait en éditant ce seul
// registre, sans toucher au reste du harnais.

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constantes de la voie A
// ---------------------------------------------------------------------------

// Bandes du Pool (vérifiées le 2026-08-28 sur Pool.sol:21-22). Chaque reserve[i]
// doit rester dans ]floor/100, ceiling/100[ de la somme des trois réserves.
// `floor` et `ceiling` sont déclarés en pourcentages dans le contrat, pas en
// points de base : un script qui écrirait `total * FLOOR_PCT / 100n` est
// correct ; avec `FLOOR_BPS / 10000n`, il se trompe d'un facteur 100.
export const FLOOR_PCT = 13n;
export const CEILING_PCT = 53n;

// Quantité déposée à chaque jambe au bootstrap. 100 unités à 8 décimales
// (10^10) → réserves 100/100/100 → ratios 33/33/33, au centre de la bande.
export const BOOTSTRAP_AMOUNT = 100n * 10n ** 8n;

// Quantité fournie à l'attaquant par BTC mock. Suffit pour plusieurs
// swap / addLiquidity sans shortfall à l'intérieur des bandes.
export const ATTACKER_FUNDING = 5n * 10n ** 8n;

// Clés de registre attendues dans deployed_addresses.json. Toute clé absente
// fait échouer loadAddresses() avec un message explicite.
const REQUIRED_KEYS = [
  "LBTCModule#MockWrappedBTC",
  "WBTCModule#MockWrappedBTC",
  "cbBTCModule#MockWrappedBTC",
  "MRNModule#MRN",
  "MrnFaucetModule#MrnFaucet",
  "PoolModule#Pool",
  "AuctionModule#Auction",
] as const;

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface Addresses {
  lbtc: `0x${string}`;
  wbtc: `0x${string}`;
  cbBtc: `0x${string}`;
  mrn: `0x${string}`;
  faucet: `0x${string}`;
  pool: `0x${string}`;
  auction: `0x${string}`;
}

// Handles viem tels que rendus par getContractAt. Le typage exact vient de
// l'ABI générée par Hardhat ; on évite de le figer ici pour ne pas dupliquer
// le code généré.
export interface AttackContracts {
  pool: any;
  auction: any;
  faucet: any;
  mrn: any;
  lbtc: any;
  wbtc: any;
  cbBtc: any;
}

export interface AttackContext {
  viem: any;
  // Helpers de nœud (`time.setNextBlockTimestamp`, `mine`) tels que les
  // suites TypeScript les utilisent. `undefined` si la connexion ne les
  // expose pas ; `warpTo` retombe alors sur le JSON-RPC équivalent.
  networkHelpers?: any;
  publicClient: any;
  walletClients: any[];
  deployer: any;
  attacker: any;
  chainId: number;
  networkName: string;
  addresses: Addresses;
  contracts: AttackContracts;
}

// ---------------------------------------------------------------------------
// 1. Connexion au nœud Hardhat local (chaîne 31337)
// ---------------------------------------------------------------------------
//
// Pattern identique à backend/scripts/seed-faucet.ts:11-32 : on s'appuie sur
// la connexion implicite fournie par Hardhat (nœud local déjà lancé), on lit
// le chainId dynamiquement, et on prend le compte 0 du réseau ciblé comme
// déployeur.
export async function connectToLocalNode(): Promise<{
  viem: any;
  networkHelpers?: any;
  publicClient: any;
  walletClients: any[];
  deployer: any;
  attacker: any;
  chainId: number;
  networkName: string;
}> {
  const { viem, networkName, networkHelpers } = await network.getOrCreate() as any;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const walletClients = await viem.getWalletClients();
  const deployer = walletClients[0];
  if (!deployer) {
    throw new Error("Aucun wallet client disponible sur le réseau local");
  }
  // Le compte attaquant est le second compte de Hardhat. Sur la config par
  // défaut (20 comptes, 10 000 ETH chacun), c'est une adresse distincte du
  // déployeur avec un solde confortable pour tous les scripts à venir.
  const attacker = walletClients[1];
  if (!attacker) {
    throw new Error("Le réseau local doit fournir au moins deux comptes (déployeur + attaquant)");
  }
  return { viem, networkHelpers, publicClient, walletClients, deployer, attacker, chainId, networkName };
}

// ---------------------------------------------------------------------------
// 2. Chargeur d'adresses depuis deployed_addresses.json
// ---------------------------------------------------------------------------
//
// Source unique des adresses, identique à celle que le front consomme via
// `frontend/src/constants/addresses.ts`. Si une clé manque, on liste les clés
// manquantes plutôt que de planter sur la première : la sortie est lisible
// en séance et le déployeur sait quoi relancer.
export function loadAddresses(chainId: number): Addresses {
  const journalPath = join(
    "ignition", "deployments", `chain-${chainId}`, "deployed_addresses.json",
  );

  let registry: Record<string, string>;
  try {
    registry = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, string>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Impossible de lire ${journalPath} (${reason}). Le nœud est-il sur la chaîne ${chainId} ? ` +
      `Lancer d'abord 'npx hardhat ignition deploy ignition/modules/merion.ts --network localhost'.`,
    );
  }

  const missing = REQUIRED_KEYS.filter((k) => !(k in registry) || registry[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Adresses manquantes dans ${journalPath} : ${missing.join(", ")}. ` +
      `Lancer d'abord 'npx hardhat ignition deploy ignition/modules/merion.ts --network localhost'.`,
    );
  }

  return {
    lbtc: registry["LBTCModule#MockWrappedBTC"] as `0x${string}`,
    wbtc: registry["WBTCModule#MockWrappedBTC"] as `0x${string}`,
    cbBtc: registry["cbBTCModule#MockWrappedBTC"] as `0x${string}`,
    mrn: registry["MRNModule#MRN"] as `0x${string}`,
    faucet: registry["MrnFaucetModule#MrnFaucet"] as `0x${string}`,
    pool: registry["PoolModule#Pool"] as `0x${string}`,
    auction: registry["AuctionModule#Auction"] as `0x${string}`,
  };
}

// ---------------------------------------------------------------------------
// 3. Handles de contrats via viem.getContractAt
// ---------------------------------------------------------------------------
//
// Tous les handles sont chargés en parallèle : la connexion est déjà établie,
// les contrats sont déjà déployés à des adresses fixes, getContractAt ne fait
// pas d'I/O réseau au-delà du `multicall` initial.
export async function loadContracts(viem: any, addresses: Addresses): Promise<AttackContracts> {
  const [pool, auction, faucet, mrn, lbtc, wbtc, cbBtc] = await Promise.all([
    viem.getContractAt("Pool", addresses.pool),
    viem.getContractAt("Auction", addresses.auction),
    viem.getContractAt("MrnFaucet", addresses.faucet),
    viem.getContractAt("MRN", addresses.mrn),
    viem.getContractAt("MockWrappedBTC", addresses.lbtc),
    viem.getContractAt("MockWrappedBTC", addresses.wbtc),
    viem.getContractAt("MockWrappedBTC", addresses.cbBtc),
  ]);
  return { pool, auction, faucet, mrn, lbtc, wbtc, cbBtc };
}

// ---------------------------------------------------------------------------
// 4. Bootstrap d'un état de pool utilisable
// ---------------------------------------------------------------------------
//
// Deux étapes, dans l'ordre :
//   (a) liquidité initiale 1:1:1 déposée par le déployeur (la branche
//       bootstrap de Pool.addLiquidity force les trois réserves à la même
//       valeur, Pool.sol:330). Cette étape est idempotente : si
//       `totalSupply() > 0`, on saute (a) avec un log explicite. Sauter (a)
//       au 2e appel évite que la branche proportionnelle d'addLiquidity
//       (Pool.sol:337-348) ne consomme `ceilDiv(_amount * r_i / r_0)` sur
//       des réserves déréglées par un swap antérieur, ce qui ferait
//       dépasser BOOTSTRAP_AMOUNT pour une jambe et casserait l'approbation.
//   (b) approvisionnement de l'attaquant en BTC mock, avec approbation du
//       Pool pour qu'il puisse enchaîner swap / addLiquidity sans shortfall.
//       Cette étape tourne À CHAQUE appel, même quand (a) est sauté : sur
//       un nœud partagé entre scripts des tâches 9 à 14, le 2e script
//       hérite d'une allowance déjà entamée par les swaps du précédent, et
//       sauter (b) le laisserait sans fonds dès le premier swap.
//
// Le tout reste confortablement dans la bande (13 %, 53 %) : chaque réserve
// représente 33,33 % de la somme après l'étape (a).
export async function bootstrapPool(ctx: AttackContext): Promise<void> {
  const { contracts, deployer, attacker, publicClient } = ctx;
  const tokens: any[] = [contracts.lbtc, contracts.wbtc, contracts.cbBtc];

  // (a) — saut idempotent. Aucun mint/approve/addLiquidity avant cette
  // lecture : on ne consomme pas de gas tant qu'on n'est pas certain de
  // devoir bootstrapper.
  const totalSupply = (await contracts.pool.read.totalSupply()) as bigint;
  if (totalSupply === 0n) {
    // Mint + approve + addLiquidity pour chaque BTC mock. L'approbation
    // est posée à `2 * BOOTSTRAP_AMOUNT` (au lieu du strict nécessaire) :
    // la convention adoptée par le projet sur les approbations à longue
    // durée de vie (cf. `Auction.sol` constructeur qui pousse
    // `type(uint256).max` sur MRN) veut qu'on ne risque pas un shortfall
    // en milieu de script si un appel futur consomme plus que la jambe
    // d'ancrage.
    const deployerApproval = 2n * BOOTSTRAP_AMOUNT;
    for (const token of tokens) {
      const txMint = await token.write.mint([deployer.account.address, BOOTSTRAP_AMOUNT], {
        account: deployer.account,
      });
      await publicClient.waitForTransactionReceipt({ hash: txMint });
      const txApprove = await token.write.approve([contracts.pool.address, deployerApproval], {
        account: deployer.account,
      });
      await publicClient.waitForTransactionReceipt({ hash: txApprove });
    }
    // Le bootstrap de Pool (supply == 0) ancre sur l'index 0 et impose 1:1:1.
    const txBootstrap = await contracts.pool.write.addLiquidity(
      [0n, BOOTSTRAP_AMOUNT, 0n],
      { account: deployer.account },
    );
    await publicClient.waitForTransactionReceipt({ hash: txBootstrap });
  } else {
    console.log(
      `Bootstrap : pool déjà opérationnel (totalSupply=${totalSupply}), ` +
      `étape (a) sautée (no-op idempotent). L'étape (b) de financement de ` +
      `l'attaquant tourne quand même pour garantir l'allowance.`,
    );
  }

  // (b) Financement de l'attaquant. Mint direct sur chaque BTC mock (la
  // fonction `mint` de MockWrappedBTC est publique, contrat:16-18), puis
  // approve du Pool pour permettre les swaps qui suivront. Tourne à CHAQUE
  // appel : c'est ce qui garantit qu'un script 9-14 voit l'attaquant
  // financé, même quand le script précédent a entamé l'allowance.
  const attackerApproval = 2n * ATTACKER_FUNDING;
  for (const token of tokens) {
    const txMint = await token.write.mint([attacker.account.address, ATTACKER_FUNDING], {
      account: deployer.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: txMint });
    const txApprove = await token.write.approve(
      [contracts.pool.address, attackerApproval],
      { account: attacker.account },
    );
    await publicClient.waitForTransactionReceipt({ hash: txApprove });
  }
}

// ---------------------------------------------------------------------------
// 4 bis. Horloge du nœud local
// ---------------------------------------------------------------------------
//
// Les scripts d'audit F1/F3/F5 se formulent en TEMPS : un mandat périmé, une
// fenêtre d'enchère fermée, une tranche de rente écoulée sur un pool vide.
// Sur un nœud Hardhat local, le seul moyen d'y arriver est de pousser
// l'horloge du nœud.
//
// L'idiome du dépôt est `networkHelpers.time.setNextBlockTimestamp(ts)` suivi
// de `networkHelpers.mine()` : c'est exactement le `warpTo` de
// test/Pool.manager.test.ts:127-130, repris par toutes les suites
// TypeScript. On l'utilise ici plutôt qu'un appel JSON-RPC brut, pour ne pas
// entretenir une seconde façon de faire la même chose.
//
// `network.getOrCreate()` n'expose `networkHelpers` que si le plugin
// hardhat-network-helpers est chargé sur la connexion. Le repli sur
// `evm_setNextBlockTimestamp` / `evm_mine` — les deux méthodes que
// networkHelpers appelle lui-même — garde les scripts exécutables même dans
// ce cas, sans changer de sémantique.
//
// Ces méthodes ne sont PAS disponibles sur un vrai réseau : ces scripts-là
// sont, par construction, réservés au nœud local (chaîne 31337), comme tout
// le reste du dossier.

export async function chainNow(ctx: AttackContext): Promise<bigint> {
  const block = await ctx.publicClient.getBlock();
  return BigInt(block.timestamp);
}

// Avance l'horloge jusqu'à `timestamp` et mine un bloc. No-op si le nœud est
// déjà au-delà : `setNextBlockTimestamp` refuse un temps passé, et un script
// qui hérite d'un nœud déjà avancé doit continuer, pas planter.
export async function warpTo(ctx: AttackContext, timestamp: bigint): Promise<void> {
  const now = await chainNow(ctx);
  if (timestamp <= now) return;

  const helpers = ctx.networkHelpers;
  if (helpers) {
    await helpers.time.setNextBlockTimestamp(timestamp);
    await helpers.mine();
    return;
  }

  await ctx.publicClient.request({
    method: "evm_setNextBlockTimestamp",
    params: [`0x${timestamp.toString(16)}`],
  } as any);
  await ctx.publicClient.request({ method: "evm_mine", params: [] } as any);
}

// Avance de `seconds` secondes à partir de l'instant courant de la chaîne.
export async function warpBy(ctx: AttackContext, seconds: bigint): Promise<void> {
  await warpTo(ctx, (await chainNow(ctx)) + seconds);
}

// ---------------------------------------------------------------------------
// 5. expectRevert — affirme le NOM de l'erreur custom OU le message de chaîne
// ---------------------------------------------------------------------------
//
// Deux registres fermés, jamais de matching de chaîne libre :
//   - `ERROR_OWNER`       : nom d'erreur custom Solidity → contrat qui la
//                           déclare. L'assertion passe par
//                           `viem.assertions.revertWithCustomError`, qui
//                           décode le revert data via l'ABI du contrat.
//   - `STRING_REVERT_OWNER` : nom symbolique → message de revert à chaîne.
//                           L'assertion passe par
//                           `viem.assertions.revertWith`, qui exige une
//                           égalité exacte sur le message.
//
// Tout nom absent des deux registres provoque un throw explicite : c'est ce
// qui distingue une preuve d'un accident, conformément au brief.
//
// `revertWithCustomError` lève si la transaction réussit, si elle reverte
// avec une autre erreur custom, ou si elle ne reverte pas du tout (OOG,
// panic). Voir la skill hardhat-toolbox-viem.
type ContractKey = keyof AttackContracts;

const ERROR_OWNER: Record<string, ContractKey> = {
  // Pool.sol (lignes 87-120 du contrat).
  FeeTooHigh: "pool",
  EmptyFeeBand: "pool",
  ZeroEpochDuration: "pool",
  PriorityWindowTooLong: "pool",
  BadSlippage: "pool",
  ReserveOverflow: "pool",
  InsufficientReserve: "pool",
  ZeroOutput: "pool",
  NotBootstrapped: "pool",
  FloorTouched: "pool",
  CeilingTouched: "pool",
  NotAuctionOrOwner: "pool",
  EpochAlreadyStarted: "pool",
  ZeroManager: "pool",
  ManagerAlreadySet: "pool",
  AuctionAlreadySet: "pool",
  NotManager: "pool",
  OutsidePriorityWindow: "pool",
  FeeAlreadySetThisEpoch: "pool",
  FeeOutOfBand: "pool",
  ZeroFeesOwed: "pool",
  NotAuction: "pool",
  ZeroRentOwed: "pool",
  InvalidTreasury: "pool",
  DuplicateToken: "pool",
  InvalidTokenAddress: "pool",
  InvalidTokenDecimals: "pool",
  InvalidMrn: "pool",
  // Pool.sol — gardes ajoutees par la campagne d'audit (F6).
  // `OwnerEpochTooFar(uint256)` borne la voie d'amorcage de l'owner a
  // `currentEpoch() + 1`.
  OwnerEpochTooFar: "pool",
  // MrnFaucet.sol.
  FaucetEmpty: "faucet",
  TooEarly: "faucet",
  // Auction.sol.
  BidTooLow: "auction",
  WindowClosed: "auction",
  NoBidToRefund: "auction",
  NoBidToSettle: "auction",
  // Auction.sol — garde ajoutée par la campagne d'audit (F3).
  // `WindowStillOpen(uint256 closesAt)` refuse un `settle()` tant que la
  // fenêtre de mise du mandat vendu n'est pas fermée.
  WindowStillOpen: "auction",
  // OpenZeppelin via Pool (Pausable, Ownable, ReentrancyGuard). Le décodage
  // passe par l'ABI du Pool puisque c'est lui qui hérite et qui répercute
  // ces erreurs. `ReentrancyGuardReentrantCall` est devenue atteignable
  // avec la garde F4 posée sur addLiquidity / removeLiquidity / swap.
  EnforcedPause: "pool",
  OwnableUnauthorizedAccount: "pool",
  ReentrancyGuardReentrantCall: "pool",
};

// Erreurs à chaîne (revert `require(..., "message")`). Le nom symbolique est
// ajouté par _harness pour donner un point d'entrée stable côté scripts
// d'attaque, jamais comparé en chaîne libre à l'exécution : c'est
// `revertWith` qui exige une égalité exacte sur la valeur du registre.
const STRING_REVERT_OWNER: Record<string, string> = {
  // MockMisbehavingBTC.sol:65 — utilisé par les tâches SafeERC20 (G1) quand
  // un transfert est demandé alors que le solde est insuffisant.
  MockMisbehavingInsufficientBalance: "MockMisbehavingBTC: insufficient balance",
  // MockMisbehavingBTC.sol:86 — utilisé quand transferFrom est appelé sans
  // allowance suffisante.
  MockMisbehavingInsufficientAllowance: "MockMisbehavingBTC: insufficient allowance",
};

export async function expectRevert(
  ctx: AttackContext,
  promise: Promise<unknown>,
  errorName: string,
): Promise<void> {
  // Si le nom n'est enregistré nulle part, on jette — mais on avale d'abord
  // la promesse de transaction déjà en vol. Sans ce `.catch`, le rejet
  // latent deviendrait un `unhandledRejection` qui masquerait le message
  // explicite et salirait la sortie séance.
  promise.catch(() => {});

  const ownerKey = ERROR_OWNER[errorName];
  const stringMessage = STRING_REVERT_OWNER[errorName];
  if (!ownerKey && !stringMessage) {
    throw new Error(
      `Erreur "${errorName}" absente des registres _harness. ` +
      `Ajouter le mapping nom → contrat dans ERROR_OWNER (erreur custom) ou ` +
      `nom → message dans STRING_REVERT_OWNER (revert à chaîne), pour que ` +
      `l'assertion passe par viem.assertions.revertWithCustomError ou ` +
      `revertWith — jamais par matching de chaîne libre.`,
    );
  }

  if (ownerKey) {
    const contract = ctx.contracts[ownerKey];
    await ctx.viem.assertions.revertWithCustomError(promise, contract, errorName);
    return;
  }
  await ctx.viem.assertions.revertWith(promise, stringMessage as string);
}

// ---------------------------------------------------------------------------
// 6. Sortie normalisée pour les scripts d'attaque
// ---------------------------------------------------------------------------
//
// Chaque ligne d'attaque imprime un en-tête lisible en séance :
//
//   ── Attaque : <label>
//      Attendu  : <expected>
//      Observé  : <observed>
//      Verdict  : OK | ÉCHEC : <raison>
//
// En fin de script, `finalize()` imprime le récapitulatif global (OK ou ÉCHEC)
// et fait sortir le processus avec le code 0 ou 1. Le code de sortie est le
// seul signal qu'un orchestrateur peut attraper ; le texte reste pour la
// séance.

interface Verdict {
  label: string;
  ok: boolean;
  reason?: string;
}

const VERDICTS: Verdict[] = [];

export function recordAttack(label: string, expected: string, observed: string, ok: boolean, reason?: string): void {
  const verdict = ok ? "OK" : `ÉCHEC : ${reason ?? "inconnu"}`;
  console.log(`── Attaque : ${label}`);
  console.log(`   Attendu  : ${expected}`);
  console.log(`   Observé  : ${observed}`);
  console.log(`   Verdict  : ${verdict}`);
  VERDICTS.push({ label, ok, reason });
}

// Variante qui exécute un test et pousse un verdict à partir de son exception.
// `runner` enveloppe `expectRevert`, qui JETTE quand le revert attendu n'arrive
// pas. Donc :
//   - `try` qui passe  = la garde a tenu = verdict OK.
//   - `catch` qui jette = la garde n'a pas tenu = l'attaque a échoué à
//                         démontrer la violation = verdict ÉCHEC, et le
//                         message d'erreur du harnais explique pourquoi.
//
// `observed` porte ce que la transaction a fait (le message d'erreur du
// harnais dans le cas ÉCHEC, ou "aucune exception levée" dans le cas OK).
// `reason` n'est posé QUE dans le cas ÉCHEC (ok=false), pour rester cohérent
// avec la ligne de verdict imprimée par `recordAttack`.
export async function runAttack(
  label: string,
  expected: string,
  runner: () => Promise<void>,
): Promise<boolean> {
  try {
    await runner();
    recordAttack(label, expected, "aucune exception levée", true);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordAttack(label, expected, message, false, message);
    return false;
  }
}

// Vide le registre des verdicts. À appeler en début de chaque script si on
// importe plusieurs fois _harness dans le même process (rare).
export function resetVerdicts(): void {
  VERDICTS.length = 0;
}

export function finalize(): void {
  const total = VERDICTS.length;
  const passed = VERDICTS.filter((v) => v.ok).length;
  const failed = total - passed;
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  if (total === 0) {
    // Zéro verdict = rien n'a été testé. C'est suspect : un script qui rend
    // une sortie vide ne démontre rien. Texte neutre mais code de sortie 1
    // pour qu'un orchestrateur n'interprète pas le silence comme un OK.
    console.log("Récapitulatif : aucun verdict à récapituler");
    console.log("VERDICT FINAL : ÉCHEC (script n'a rien testé)");
    console.log("═══════════════════════════════════════════════════════════");
    process.exit(1);
  }
  console.log(`Récapitulatif : ${passed} / ${total} attaques passées`);
  if (failed === 0) {
    console.log("VERDICT FINAL : OK");
    console.log("═══════════════════════════════════════════════════════════");
    process.exit(0);
  }
  console.log(`VERDICT FINAL : ÉCHEC (${failed} attaque(s) en échec)`);
  console.log("═══════════════════════════════════════════════════════════");
  process.exit(1);
}

// `buildAttackContext` regroupe les trois premières briques en un seul appel
// pour les scripts qui n'ont pas besoin de bootstrap.
export async function buildAttackContext(): Promise<AttackContext> {
  const { viem, networkHelpers, publicClient, walletClients, deployer, attacker, chainId, networkName } =
    await connectToLocalNode();
  const addresses = loadAddresses(chainId);
  const contracts = await loadContracts(viem, addresses);
  return { viem, networkHelpers, publicClient, walletClients, deployer, attacker, chainId, networkName, addresses, contracts };
}
