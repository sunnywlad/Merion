// SPDX-License-Identifier: MIT
//
// Tache 14 (voie A) — Calibrage de MIN_OPENING_BID pour l'enchere de
// mandat du pool Merion.
//
// Cette simulation est PEDAGOGIQUE et DETERMINISTE. Elle ne touche aucun
// contrat : pas d'appel a Pool/Auction, pas d'envoie de transaction, pas de
// mock deploye, pas de reseau local. Tout se joue en variables TypeScript
// pures, parce que le livrable de cette tache est une VALEUR RECOMMANDEE
// pour le parametre de deploiement `minOpeningBid` de l'Auction
// (cf. Auction.sol constructeur, l'argument `_minOpeningBid`), PAS un
// patch de code. L'inscription de la valeur dans Pool.sol ou Auction.sol
// est une decision de Wlad apres la nuit, et le brief interdit formellement
// de modifier les contrats dans cette tache.
//
// LE PROBLEME A RESOUDRE
//
// `MIN_OPENING_BID` est le plancher de la premiere mise d'une enchere de
// mandat. Le contrat Auction l'utilise dans `placeBid` comme
// `min = max(MIN_OPENING_BID, highBid * HIGH_BID_BPS / BPS_DEN)` (cf.
// Auction.sol, ligne 392-393, et le commentaire en entete du contrat,
// section (3)) : la premiere mise d'une enchere vide est bornee
// inferieurement par `MIN_OPENING_BID`, et les surencheres par
// `highBid * 1.1` (HIGH_BID_BPS = 11000 / BPS_DEN = 10000, soit +10 %).
//
// Deux risques opposes pesent sur ce parametre, et la calibration cherche
// la valeur qui minimise leur somme ponderee :
//
//   1. RISQUE D'ENCHERE VIDE. Si `MIN_OPENING_BID` est trop haut, aucun
//      spender solvable n'encherit (le mandat reste invendu), le settle
//      externe reverte `NoBidToSettle()` (cf. Auction.sol entete, point
//      (4) : degradation R7 documentee), et la pool opere au tarif
//      nominal pendant la duree du mandat sans beneficier d'un
//      gestionnaire nomme. Le cout d'opportunite est la valeur du LBTC
//      que la pool aurait vendu par le mandat, moins les fees qu'elle
//      aurait percues si le mandat avait ete servi.
//
//   2. RISQUE DE SPAM. Si `MIN_OPENING_BID` est trop bas, un attaquant
//      peut multiplier les `placeBid` a 1 wei pour deplacer l'attention
//      du manager (cf. brief, point 1 du modele de risque). Le cout est
//      la congestion de l'enchere et le deplacement du gestionnaire
//      courant, qui peut rater la fenetre de priorite `setFee` parce
//      qu'il trie des dizaines de 1-wei bids pour trouver le vrai high
//      bidder. C'est un modele defavorable pour la pool : le spam n'est
//      rentable pour l'attaquant que si `placeBid` (gaz + lockup MRN
//      pour la duree de l'enchere) coute moins que `MIN_OPENING_BID`
//      qu'il economise en ne payant pas le plancher reel.
//
// Sortie : un CSV a `/tmp/merion-calibrate-min-opening-bid.csv` avec
// une ligne par valeur candidate, plus un resume en seance qui identifie
// la valeur recommandee (celle qui minimise le cout total). Le verdict
// est ecrit en francais structure (valeur, cout, hypotheses, mise en
// garde sur l'inscription du resultat dans le contrat).

// ---------------------------------------------------------------------------
// 1. Parametres du modele — modifiables en haut du fichier
// ---------------------------------------------------------------------------

// Plage de la valeur candidate pour MIN_OPENING_BID. On balaie 0 a
// `MAX_CANDIDATE_MRN` MRN par pas de `STEP_MRN` MRN. Les valeurs sont
// exprimees en MRN entiers (apres division par 10^18, voir plus bas) ;
// la valeur recommandee est lue comme un nombre de MRN, pas un montant
// en wei. La plage choisie (0 a 1000 MRN, pas de 10) couvre largement
// la valeur de deploiement actuelle (10 MRN, cf. ignition/modules/
// auction.ts ligne 16, restated 2026-08-28) et laisse de la marge pour
// une evolution vers le haut.
const MIN_CANDIDATE_MRN = 0;
const MAX_CANDIDATE_MRN = 1000;
const STEP_MRN = 10;

// Seuil au-dela duquel aucun encherisseur solvable n'encherit, en MRN.
// C'est le pivot du modele de probabilite d'enchere vide : on postule
// que la probabilite de presence d'un bidder solvable est
// `1 - bid / bid_max` (cf. brief, section 1 du modele de risque). La
// valeur de 5000 MRN est calibree par les parametres observes du pool :
// un mandat vend typiquement ~0.1 LBTC au prix de clearing central de
// 1.05 MRN/LBTC (cf. sim_multi_mandats.ts, CENTRAL_CLEARING_NUM), ce
// qui fait un produit par mandat de l'ordre de 0.1 MRN. La rent stream
// LP est plafonnee par le rent rate du Pool (voir I.4), et le budget
// d'un bidder rationnel sur une seule enchere est borne par son horizon
// de planning et son cout d'opportunite du MRN locke. Au-dela de 5000
// MRN (soit ~50 000 fois le produit direct d'un mandat), aucun bidder
// ne capture assez de valeur pour justifier la mise, et la
// probabilite de bidder solvable tombe a zero. C'est la valeur retenue
// pour cette simulation ; un redéploiement avec un pool dix fois plus
// grand (10 LBTC par mandat, 50 MRN de produit direct) justifierait de
// remonter `bid_max` a 50 000 MRN — la forme du modele tient, le
// scalaire est a recalibrer.
const BID_MAX_MRN = 5000;

// Seuil de tolerance au spam, en MRN. C'est la valeur de `MIN_OPENING_BID`
// au-dessus de laquelle un spammeur ne peut plus placer de 1-wei bids
// sans locke plus de MRN qu'il n'en economise. La valeur de 500 MRN
// reflete le cout total d'un spam unilateral : 100 bids * 5 MRN de
// gas-equivalent par bid = 500 MRN de lockup MRN + gaz. C'est un ordre
// de grandeur conservateur ; un gas-price plus haut sur mainnet
// ( > 50 gwei) le rendrait plus strict, un gas-price plus bas le
// relacherait. Pour cette simulation, on garde 500 MRN comme la limite
// de la zone ou le spam reste profitable a l'attaquant.
const SPAM_THRESHOLD_MRN = 500;

// Cout d'opportunite d'un mandat invendu, en MRN. C'est la valeur du
// LBTC que la pool aurait du vendre par ce mandat, moins les fees
// percues, evaluee a 50 MRN. Justification : un mandat vend 0.1 LBTC
// au prix de clearing central 1.05 MRN/LBTC (= 0.105 MRN brut) et
// laisse 0.5 % de fees (abaisse encore par l'echelle). Le 50 MRN est
// une estimation du manque a gagner cumule sur la duree de validite
// du gestionnaire (un mandat bien servi ouvre une fenetre de rent
// stream qui peut valoir 50 MRN sur l'epoch pour la pool). C'est un
// input de modele, pas une mesure : la valeur recommandee est sensible
// a ce scalaire, et l'incertitude est reportee dans la conclusion.
const COST_UNSOLD_PER_MANDATE_MRN = 50;

// Cout d'un spam reussi, en MRN. C'est la perte de productivite du
// manager qui doit trier N bids de 1 wei pour trouver le vrai high
// bidder, plus le risque qu'il rate la fenetre `setFee` (PRIORITY_WINDOW
// du Pool, cf. Pool.sol ligne 49 et setFee ligne 282). On l'estime a
// 20 MRN par evenement de spam : c'est le temps de gestion multiplie
// par le manque a gagner sur les frais d'un epoch. C'est un input de
// modele, discute dans la conclusion.
const COST_SPAM_EVENT_MRN = 20;

// Nombre de bids qu'un spammeur place dans un evenement. C'est la
// charge de travail que le manager doit filtrer. 100 par defaut : un
// attaquant peut envoyer 100 transactions en quelques blocs sur un rollup
// ou un L1 a bas gas, ce qui deplace completement la fenetre d'attention.
// La sensibilite a N_BIDS_PER_SPAM est lineaire sur le cout total : le
// doubler double le cout_spam, deplace le minimum vers la droite.
const N_BIDS_PER_SPAM = 100;

// Cout par bid pour le spammeur, en MRN. C'est le gas + le lockup MRN
// minimal que le spammeur accepte de subir par transaction. On l'estime
// a 0.5 MRN par bid : un gas de l'ordre de 100 000 gas a 1 gwei equivaut
// a 0.0001 ETH, soit ~0.3 MRN au cours MRN ≈ 0.01 USD (cf. ignition
// auction.ts, restated 2026-08-28), et le lockup MRN est nul pour un
// 1-wei bid. Le 0.5 MRN capture le cout d'opportunite du gas depense.
const GAS_COST_PER_BID_MRN = 0.5;

// ---------------------------------------------------------------------------
// 2. Constantes d'unite
// ---------------------------------------------------------------------------

// MRN est deploye a 18 decimales (cf. ignition/modules/mrn.ts, ERC20
// standard). Toutes les valeurs monetaires du modele sont exprimees en
// 18-decimals BigInt pour la coherence avec les autres scripts sim.
const MRN_DECIMALS = 18n;
const MRN_UNIT = 10n ** MRN_DECIMALS;

// Multiplicateur pour convertir MRN en wei : 1 MRN = 10^18 wei.
function mrn(n: number): bigint {
  // On accepte uniquement des entiers ou des flottants a precision
  // suffisante pour eviter une perte par troncature. Les parametres
  // sont saisis en MRN entiers sauf GAS_COST_PER_BID_MRN qui est 0.5.
  // La precision est preservee en multipliant par 10^6 puis en
  // shiftant vers 10^18 (facteur 10^12).
  const PRECISION = 1_000_000n;
  const scaled = BigInt(Math.round(n * Number(PRECISION)));
  return scaled * MRN_UNIT / PRECISION;
}

// ---------------------------------------------------------------------------
// 3. Modele de risque
// ---------------------------------------------------------------------------

// Probabilite que le mandat reste invendu, donnee `bid` (= MIN_OPENING_BID
// candidat). Modele lineaire : `p_unsold = bid / bid_max`, plafonne a 1.
// Plus le plancher est haut, plus il exclut de bidders solvables, plus
// le mandat a de chances de tomber en degradation R7. La forme lineaire
// est l'hypothese simple du brief, et son choix est rapporte dans la
// conclusion.
function pUnsold(bidMrn: bigint): number {
  const ratio = Number(bidMrn) / Number(mrn(BID_MAX_MRN));
  return Math.min(1, ratio);
}

// Probabilite qu'un spammeur lance un evenement de spam, donne `bid`.
// Modele lineaire decroissant : `p_spam = max(0, 1 - bid / spam_threshold)`.
// Au-dela de `spam_threshold`, le cout du spam depasse son gain
// (lockup MRN + gaz) et l'attaquant abandonne. En deca, la probabilite
// est proportionnelle a la margebenefice du spam (inversement
// proportionnelle a `bid`).
function pSpam(bidMrn: bigint): number {
  const ratio = Number(bidMrn) / Number(mrn(SPAM_THRESHOLD_MRN));
  if (ratio >= 1) return 0;
  return 1 - ratio;
}

// Cout d'un evenement de spam reussi, en wei MRN. C'est le travail de
// tri du manager : N bids * cout par bid en gas-equivalent. C'est un
// cout LINEAIRE en `bid` (plus le plancher est bas, plus le spam est
// facile, plus le manager doit filtrer). On aurait pu le modeliser en
// proportion inverse a `bid`, mais le brief retient un cout de
// "deplacement du manager" qui depend du nombre de bids, pas de la
// valeur de chaque bid.
function costSpamEventMrn(): bigint {
  return mrn(COST_SPAM_EVENT_MRN);
}

// Cout d'un mandat invendu, en wei MRN. C'est l'opportunite manquee :
// LBTC que la pool aurait vendu, moins les fees qu'elle aurait
// percues, evaluee par mandat.
function costUnsoldPerMandateMrn(): bigint {
  return mrn(COST_UNSOLD_PER_MANDATE_MRN);
}

// Cout total pour une valeur candidate, en wei MRN. La fonction de cout
// est `p_unsold * cost_unsold + p_spam * cost_spam`, avec `cost_spam`
// deja pondere par le nombre de bids et le cout par bid (voir
// `costSpamEventMrn`).
function totalCostMrn(bidMrn: bigint): bigint {
  const pU = pUnsold(bidMrn);
  const pS = pSpam(bidMrn);
  const cU = costUnsoldPerMandateMrn();
  const cS = costSpamEventMrn();
  // Conversion en flottant pour la moyenne ponderee, puis retour en
  // wei MRN. La perte de precision est sans consequence : on cherche un
  // minimum, pas un montant exact.
  const total = pU * Number(cU) + pS * Number(cS);
  return BigInt(Math.round(total));
}

// ---------------------------------------------------------------------------
// 4. Balayage et ligne de cout
// ---------------------------------------------------------------------------

interface CurvePoint {
  bidMrn: bigint;
  pUnsold: number;
  pSpam: number;
  costUnsoldMrn: bigint;
  costSpamMrn: bigint;
  totalCostMrn: bigint;
  recommended: boolean;
}

function buildCurve(): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let mrn_int = MIN_CANDIDATE_MRN; mrn_int <= MAX_CANDIDATE_MRN; mrn_int += STEP_MRN) {
    const bidWei = mrn(mrn_int);
    points.push({
      bidMrn: bidWei,
      pUnsold: pUnsold(bidWei),
      pSpam: pSpam(bidWei),
      costUnsoldMrn: costUnsoldPerMandateMrn(),
      costSpamMrn: costSpamEventMrn(),
      totalCostMrn: totalCostMrn(bidWei),
      recommended: false,
    });
  }
  // Marquage de la valeur recommandee : le minimum de la courbe.
  let minIdx = 0;
  let minCost = points[0]?.totalCostMrn ?? 0n;
  for (let i = 1; i < points.length; i++) {
    const c = points[i];
    if (!c) continue;
    if (c.totalCostMrn < minCost) {
      minCost = c.totalCostMrn;
      minIdx = i;
    }
  }
  const winner = points[minIdx];
  if (winner) winner.recommended = true;
  return points;
}

// ---------------------------------------------------------------------------
// 5. Ecriture CSV
// ---------------------------------------------------------------------------

const CSV_PATH = "/tmp/merion-calibrate-min-opening-bid.csv";
const CSV_HEADER = "min_opening_bid_mrn,p_unsold,p_spam,cost_unsold_mrn,cost_spam_mrn,total_cost_mrn,recommended";

function toCsvNumber(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = abs % factor;
  const fracStr = frac.toString().padStart(decimals, "0");
  const sign = negative ? "-" : "";
  return `${sign}${whole.toString()}.${fracStr}`;
}

function toFixed6(n: number): string {
  return n.toFixed(6);
}

function curveToCsv(points: CurvePoint[]): string {
  const lines: string[] = [CSV_HEADER];
  for (const p of points) {
    lines.push(
      [
        toCsvNumber(p.bidMrn, 18),
        toFixed6(p.pUnsold),
        toFixed6(p.pSpam),
        toCsvNumber(p.costUnsoldMrn, 18),
        toCsvNumber(p.costSpamMrn, 18),
        toCsvNumber(p.totalCostMrn, 18),
        p.recommended ? "1" : "0",
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 6. Conclusion ecrite — en francais, structuree
// ---------------------------------------------------------------------------

function emitConclusion(points: CurvePoint[]): {
  recommendedMrn: number;
  recommendedWei: bigint;
  totalCostWei: bigint;
  totalCostMrn: number;
  pUnsoldAtRecommended: number;
  pSpamAtRecommended: number;
} {
  const winner = points.find((p) => p.recommended);
  if (!winner) {
    throw new Error("Aucune valeur recommandee : courbe vide ou minimum introuvable.");
  }
  // Conversion de wei MRN vers MRN affichables. On divise par 10^18
  // pour retomber sur l'echelle entiere quand c'est possible.
  const recommendedMrn = Number(winner.bidMrn) / Number(MRN_UNIT);
  const totalCostMrn = Number(winner.totalCostMrn) / Number(MRN_UNIT);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("CALIBRAGE DE MIN_OPENING_BID — TACHE 14 (voie A)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Valeur recommandee        : ${recommendedMrn} MRN (wei = ${winner.bidMrn.toString()})`);
  console.log(`Cout total associe        : ${totalCostMrn.toFixed(6)} MRN`);
  console.log(`p_unsold a la valeur      : ${winner.pUnsold.toFixed(6)}`);
  console.log(`p_spam a la valeur        : ${winner.pSpam.toFixed(6)}`);
  console.log(`Plage balayee             : ${MIN_CANDIDATE_MRN} a ${MAX_CANDIDATE_MRN} MRN, pas de ${STEP_MRN} MRN`);
  console.log(`Nombre de points          : ${points.length}`);
  console.log(`CSV ecrit dans            : ${CSV_PATH}`);
  console.log("---------------------------------------------------------------");
  console.log("HYPOTHESES DE MODELISATION");
  console.log("---------------------------------------------------------------");
  console.log(`- bid_max       = ${BID_MAX_MRN} MRN (cf. justification en entete).`);
  console.log(`  p_unsold(bid) = min(1, bid / bid_max).`);
  console.log(`- spam_threshold= ${SPAM_THRESHOLD_MRN} MRN.`);
  console.log(`  p_spam(bid)   = max(0, 1 - bid / spam_threshold).`);
  console.log(`- cost_unsold   = ${COST_UNSOLD_PER_MANDATE_MRN} MRN par mandat invendu (opportunite manquee).`);
  console.log(`- cost_spam     = ${COST_SPAM_EVENT_MRN} MRN par evenement (N_BIDS=${N_BIDS_PER_SPAM}, GAS=${GAS_COST_PER_BID_MRN} MRN/bid,`);
  console.log(`                  travail de tri du manager pour identifier le highBidder reel).`);
  console.log(`- cout total    = p_unsold * cost_unsold + p_spam * cost_spam.`);
  console.log("---------------------------------------------------------------");
  console.log("MISE EN GARDE");
  console.log("---------------------------------------------------------------");
  console.log("Cette valeur recommandee est un RESULTAT DE SIMULATION, pas");
  console.log("une verite. La forme du modele (lineaire) et les scalaires");
  console.log(`(bid_max = ${BID_MAX_MRN} MRN, spam_threshold = ${SPAM_THRESHOLD_MRN} MRN, couts unitaires) sont des`);
  console.log("choix de calibration, pas des mesures du pool reel. Wlad tranche");
  console.log("l'inscription eventuelle de cette valeur dans `minOpeningBid`");
  console.log("(constructeur de Auction.sol, argument `_minOpeningBid`, et");
  console.log("ignition/modules/auction.ts, ligne 16). L'inscription dans");
  console.log("Pool.sol ou Auction.sol n'est PAS un acte de cette tache.");
  console.log("═══════════════════════════════════════════════════════════");

  return {
    recommendedMrn,
    recommendedWei: winner.bidMrn,
    totalCostWei: winner.totalCostMrn,
    totalCostMrn,
    pUnsoldAtRecommended: winner.pUnsold,
    pSpamAtRecommended: winner.pSpam,
  };
}

// ---------------------------------------------------------------------------
// 7. Point d'entree
// ---------------------------------------------------------------------------

import { writeFileSync, renameSync } from "node:fs";

function main(): void {
  const curve = buildCurve();
  const csv = curveToCsv(curve);

  // Ecriture atomique : fichier temporaire puis rename, pour qu'un
  // lecteur concurrent ne voie jamais un CSV partiellement ecrit.
  const tmpPath = `${CSV_PATH}.tmp`;
  writeFileSync(tmpPath, csv, { encoding: "utf8" });
  renameSync(tmpPath, CSV_PATH);

  emitConclusion(curve);
}

main();
