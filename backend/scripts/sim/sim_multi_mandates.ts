// SPDX-License-Identifier: MIT
//
// Tache 13 (voie A) — Simulation multi-mandats de l'enchere de mandat.
//
// Cette simulation est PEDAGOGIQUE, PAS une attaque. Elle ne touche aucun
// contrat : pas d'appel a Pool/Auction, pas d'envoie de transaction, pas de
// mock deploye. Tout se joue en variables TypeScript pures, parce que le
// but est de montrer que la mecanique de l'enchere tient MEME QUAND
// certains mandats restent invendus (degradation R7 documentee dans
// Auction.sol entete, point 4).
//
// Le scenario que le mock ne sait pas reproduire est explicite : la derive
// organique du peg LBTC/BTC quand le marche vend du LBTC, et le fait que
// cette derive est PORTEE PAR LE PROTOCOLE (la sortie de LBTC du pool) et
// non par un mouvement de marche injecte au contrat. Ici, la derive est
// simulee par le script (une reduction de la position LBTC du pool par
// mandat vendu, parce que les LBTC vendus sortent du pool vers le
// spender), et elle continue meme quand aucun mandat ne trouve
// d'encherisseur, parce que la position LBTC du pool baisse independamment
// de la presence d'un acheteur — c'est l'effet de l'orchestration reelle,
// pas un accident de simulation.
//
// Sortie : un CSV a /tmp/merion-sim-multi-mandates.csv, une ligne par
// mandat simule, avec en-tete. Un resume est imprime en seance, et un
// verdict final ("OK — la pool reste solvable meme avec X mandats
// invendus" ou analogue) ferme la sortie.
//
// MODELE SIMPLIFIE (cf. brief) :
//   - settlement = LBTC_vendu * prix_clearing (en MRN) ;
//   - prix_clearing oscille autour d'une valeur centrale, refletant la
//     concurrence sur l'enchere : il monte quand un mandat est vendu
//     apres un invendu (relance), il baisse apres une suite de vendus
//     (concurrence qui erode la rente) ;
//   - fees = 5 % du bid (analogue a NOMINAL_FEE_NUM / FEE_DEN, simplifie
//     a un seul taux unique) ;
//   - drift cumule = (position_LBTC_courante / position_LBTC_initiale) - 1,
//     exprime en pourcentage, signe negatif quand le pool perd des LBTC ;
//   - solvabilite : la pool reste solvable tant que sa position LBTC est
//     strictement positive (elle peut encore servir des swaps) et que
//     l'invariant de bande simplifie tient (on ne franchit pas un seuil
//     symbolique de 50 % de perte cumulee, qui signalerait une derive
//     organique desastreuse incompatible avec un retour a la parite).
//
// Alea : deterministe par un PRNG lineaire congruentiel a seed fixe, pour
// que la meme commande produise la meme sortie. C'est ce qui distingue
// une simulation d'un test de Monte-Carlo : on veut la trace, pas la
// distribution.

// ---------------------------------------------------------------------------
// 1. Parametres d'entree — modifiables en haut du fichier
// ---------------------------------------------------------------------------

// Nombre de mandats a simuler. Dix par defaut, pour une figure lisible
// en carnet (pas trop court, pas trop long).
const NUM_MANDATES = 10;

// Duree d'un mandat, en heures. Affichage seulement, n'influence pas le
// calcul de drift (la derive est instantanee, pas temporelle).
const EPOCH_DURATION_HOURS = 24;

// Fenetre tardive, en pourcentage de l'epoch. Affichage seulement, meme
// remarque : la simulation n'integre pas de regle temporelle.
const LATE_WINDOW_PCT = 15;

// Montant de base de chaque mandat, en LBTC (8 decimales). Chaque mandat
// vend `MANDATE_SIZE` LBTC du pool vers le spender, et le pool recoit
// `bid_price` MRN en echange.
const MANDATE_SIZE_LBTC = 10n * 10n ** 8n;

// Taux de participation : probabilite qu'un mandat donne lieu a une
// enchere. 60 % par defaut, ce qui donne ~4 invendus sur 10 mandats : un
// signal clair que la degradation R7 tient, sans noyer la lecture du CSV.
const PARTICIPATION_RATE = 0.6;

// Dérive simulee par mandat VENDU, exprimee comme fraction de la position
// LBTC initiale qui sort du pool par mandat. -0.1 % par defaut, soit
// -1 LBTC par mandat vendu sur 1000 LBTC de reserve initiale. La derive
// est APPLIQUEE UNIQUEMENT QUAND LE MANDAT EST VENDU : un mandat invendu
// ne fait pas sortir de LBTC du pool, et c'est exactement ce qu'on veut
// montrer (la position LBTC peut rester stable pendant les epochs
// invendues, le pool peut "respirer" entre deux ventes).
const LBTC_DRIFT_PER_SOLD = 0.001;

// Position LBTC initiale du pool, en LBTC (8 decimales). 1000 LBTC au
// depart, conforme a l'enonce.
const INITIAL_LBTC_POSITION = 1000n * 10n ** 8n;

// Solde MRN initial du pool, en MRN (18 decimales). 1 000 000 MRN.
const INITIAL_MRN_BALANCE = 1_000_000n * 10n ** 18n;

// Taux de frais preleves sur chaque bid, fraction. 5 % = 0.05, calque sur
// NOMINAL_FEE_NUM / FEE_DEN simplifie a un seul taux.
const FEE_BPS = 500n; // 500 / 10_000 = 5 %

// Denominateur des basis points. Distinct de FEE_BPS pour la regle du
// projet : un seul denominateur par calcul, jamais partage.
const BPS_DEN = 10_000n;

// Prix central de clearing, en MRN par LBTC (avec les decimales des deux
// cotes). 1.05 MRN par LBTC, soit 1.05 * 10^18 / 10^8 = 1.05 * 10^10 en
// valeur brute (18 - 8 = 10). Le prix de chaque mandat oscille autour
// de cette valeur en fonction de l'etat du marche (relance apres
// invendu, erosion apres serie de vendus).
const CENTRAL_CLEARING_NUM = 105n * 10n ** 8n; // 1.05 * 10^10 (en unites MRN/LBTC brutes)

// Amplitude de l'oscillation du prix de clearing, exprimee en fraction
// de CENTRAL_CLEARING_NUM. 10 % par defaut, pour des prix entre ~0.95
// et ~1.16 MRN par LBTC. Represente la concurrence observee sur
// l'enchere.
const PRICE_OSCILLATION_BPS = 1_000n; // 10 % du prix central

// Seed du PRNG, pour reproductibilite. Toute valeur tient.
const PRNG_SEED = 0xC0FFEEn;

// ---------------------------------------------------------------------------
// 2. PRNG lineaire congruentiel — deterministe, suffisant pour la simulation
// ---------------------------------------------------------------------------
//
// On n'utilise pas Math.random() : la sortie doit etre reproductible
// d'une seance a l'autre (meme commande, meme CSV). Le LCG tient sur
// 64 bits et donne une distribution uniforme suffisante pour des tirages
// de probabilite fixe.

interface LCG {
  state: bigint;
}

function lcgInit(seed: bigint): LCG {
  return { state: seed };
}

// Rend un entier dans [0, max). Utilise des multiplications 64 bits
// protegees du overflow par un modulus premier (methode Numerical
// Recipes, suffisante pour un PRNG de simulation).
function lcgNext(lcg: LCG, maxExclusive: bigint): bigint {
  // MMIX par Knuth : etat suivant = a * etat + c (mod 2^64), avec
  // a = 6364136223846793005 et c = 1442695040888963407. Sur 64 bits
  // non signes, le overflow JS wrap naturellement modulo 2^64 (les
  // BigInt sont signes mais le resultat tient quand on ramene par
  // BigInt.asUintN si necessaire ; ici on laisse le wrap par
  // multiplication, JS BigInt ne truncate pas par defaut).
  lcg.state = (6364136223846793005n * lcg.state + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
  return lcg.state % maxExclusive;
}

// Rend un flottant dans [0, 1). Utilise lcgNext sur un grand diviseur.
function lcgNextFloat(lcg: LCG): number {
  const denom = 1_000_000n;
  const v = lcgNext(lcg, denom);
  return Number(v) / Number(denom);
}

// ---------------------------------------------------------------------------
// 3. Coeur de la simulation
// ---------------------------------------------------------------------------

interface EpochRecord {
  epoch: number;
  mandateSold: 0 | 1;
  bidPriceMrn: bigint;
  lbtcDriftPct: number;
  poolMrnBalance: bigint;
  poolLbtcPosition: bigint;
  totalFeesMrn: bigint;
}

interface SimState {
  poolMrnBalance: bigint;
  poolLbtcPosition: bigint;
  totalFeesMrn: bigint;
  // Le prix de clearing de l'iteration courante : il evolue en fonction
  // de l'iteration precedente (relance apres invendu, erosion apres
  // serie de vendus). Centralise dans l'etat pour la lisibilite.
  currentClearingNum: bigint;
  // Le nombre de mandats invendus consecutifs (sert a l'oscillation du
  // prix : un invendu suivi d'une vente devrait voir un prix plus haut,
  // reflet de la rarete).
  consecutiveUnsold: number;
}

function initState(): SimState {
  return {
    poolMrnBalance: INITIAL_MRN_BALANCE,
    poolLbtcPosition: INITIAL_LBTC_POSITION,
    totalFeesMrn: 0n,
    currentClearingNum: CENTRAL_CLEARING_NUM,
    consecutiveUnsold: 0,
  };
}

// Decide si le mandat N recoit une enchere, en fonction du PRNG et du
// taux de participation. Tirage uniforme sur [0, 1).
function shouldReceiveBid(lcg: LCG): boolean {
  return lcgNextFloat(lcg) < PARTICIPATION_RATE;
}

// Calcule le prix de clearing pour le mandat courant, en appliquant
// l'oscillation autour de CENTRAL_CLEARING_NUM. La regle :
//   - si le mandat precedent etait invendu ET le courant est vendu, le
//     prix de clearing est tire vers le haut (relance apres rarete) ;
//   - si le mandat courant est invendu, le prix n'est pas applique (le
//     mandat est invendu, pas de transaction) ;
//   - sinon, le prix oscille normalement autour de la valeur centrale.
// Le tirage est PRNG-driven pour reproductibilite, et la sortie reste
// dans la bande [CENTRAL * (1 - OSC), CENTRAL * (1 + OSC)].
function nextClearingPrice(lcg: LCG, state: SimState, willBeSold: boolean): bigint {
  if (!willBeSold) {
    return 0n;
  }
  // Tirage d'un multiplicateur dans [1 - OSC, 1 + OSC]. On tire un
  // entier dans [0, 2 * OSC_BPS) et on calcule (CENTRAL * (BPS_DEN -
  // OSC_BPS + tirage)) / BPS_DEN. Reste strictement positif.
  const oscBps = PRICE_OSCILLATION_BPS;
  const range = 2n * oscBps;
  const draw = lcgNext(lcg, range);
  let multiplierBps = BPS_DEN - oscBps + draw;
  // Relance apres rarete : si le mandat PRECEDENT etait invendu, on
  // pousse le multiplicateur vers le haut de la bande (+30 % de la
  // moitie superieure, en pratique).
  if (state.consecutiveUnsold > 0) {
    multiplierBps += oscBps * 3n / 10n;
    if (multiplierBps > 2n * BPS_DEN) {
      multiplierBps = 2n * BPS_DEN;
    }
  }
  return CENTRAL_CLEARING_NUM * multiplierBps / BPS_DEN;
}

function runSimulation(): EpochRecord[] {
  const lcg = lcgInit(PRNG_SEED);
  const state = initState();
  const records: EpochRecord[] = [];

  for (let epoch = 0; epoch < NUM_MANDATES; epoch++) {
    const receivesBid = shouldReceiveBid(lcg);
    const willBeSold = receivesBid;

    const bidPrice = nextClearingPrice(lcg, state, willBeSold);

    if (willBeSold) {
      // Le pool recoit `bid_price` MRN du bidder (le prix de clearing
      // est en MRN par LBTC, multiplie par MANDATE_SIZE_LBTC pour avoir
      // le montant en MRN brut).
      // MANDATE_SIZE_LBTC est en 8 decimales, bidPrice est en 10
      // decimales (18 - 8 = 10, reflet du rapport MRN/LBTC en unites
      // brutes), produit final en 18 decimales (MRN).
      // Pas de division supplementaire : les 8 decimales de LBTC et les
      // 10 decimales du prix s'additionnent pour donner les 18
      // decimales du MRN. Une division par 10^8 ici aurait efface les
      // decimales du LBTC et rendu le montant 10^8 fois trop petit.
      const totalIn = bidPrice * MANDATE_SIZE_LBTC;
      // Fees = 5 % du bid, trackers en MRN.
      const fees = totalIn * FEE_BPS / BPS_DEN;
      // Sortie : MANDATE_SIZE_LBTC LBTC quittent le pool (le mandat est
      // servi par la pool). Pas de LBTC externe, c'est la pool qui
      // paye en LBTC pour la nomination.
      state.poolLbtcPosition -= MANDATE_SIZE_LBTC;
      // Entree : la totalite du bid en MRN arrive a la pool.
      state.poolMrnBalance += totalIn;
      state.totalFeesMrn += fees;
      state.consecutiveUnsold = 0;

      const record: EpochRecord = {
        epoch,
        mandateSold: 1,
        bidPriceMrn: totalIn,
        lbtcDriftPct: pctFromPosition(state.poolLbtcPosition),
        poolMrnBalance: state.poolMrnBalance,
        poolLbtcPosition: state.poolLbtcPosition,
        totalFeesMrn: state.totalFeesMrn,
      };
      records.push(record);
    } else {
      // Pas d'enchere : le mandat expire, et la pool n'est pas touchee
      // (ni LBTC, ni MRN, ni fees). La derive organique continue
      // independamment, parce qu'elle est portee par la pression de
      // marche, pas par le contrat — et dans cette simulation, la
      // pression est absente les epochs invendues, ce qui est
      // exactement ce que le brief veut montrer.
      state.consecutiveUnsold += 1;

      const record: EpochRecord = {
        epoch,
        mandateSold: 0,
        bidPriceMrn: 0n,
        lbtcDriftPct: pctFromPosition(state.poolLbtcPosition),
        poolMrnBalance: state.poolMrnBalance,
        poolLbtcPosition: state.poolLbtcPosition,
        totalFeesMrn: state.totalFeesMrn,
      };
      records.push(record);
    }

    // Mise a jour de l'oscillation du prix de clearing pour la
    // prochaine iteration (impact uniquement si le mandat suivant
    // est vendu). Le prix de clearing courant n'est ecrit dans
    // l'etat qu'apres utilisation, pour que l'oscillation se base
    // sur le DERNIER prix reellement applique, pas sur un prix
    // invendu (qui n'a pas ete applique).
    if (willBeSold) {
      state.currentClearingNum = bidPrice;
    }

    // Application de la derive LBTC : la position du pool baise
    // de LBTC_DRIFT_PER_SOLD par mandat VENDU, en proportion de la
    // position INITIALE (pas courante, pour eviter un emballement
    // exponentiel). La derive est APPLIQUEE MEME SI LE MANDAT EST
    // INVENDU ? Non : la derive simulee est la pression de vente
    // LBTC du marche. Si aucun mandat n'est vendu, il n'y a pas
    // eu de pression de vente ce tour-ci. C'est l'effet "respire"
    // qu'on veut capturer dans le CSV (la derive reste plate
    // pendant les epochs invendues, et descend par paliers
    // pendant les vendus). La derive est donc strictement
    // conditionnelle a un mandat vendu.
    if (willBeSold) {
      const driftAmount = INITIAL_LBTC_POSITION * BigInt(Math.floor(LBTC_DRIFT_PER_SOLD * 1_000_000)) / 1_000_000n;
      state.poolLbtcPosition -= driftAmount;
    }
  }

  return records;
}

// Calcule la derive cumulee du LBTC en pourcentage, depuis la position
// initiale. Signe negatif quand la position courante est inferieure a
// l'initiale, signe positif dans le cas (impossible ici) d'une
// appreciation.
function pctFromPosition(currentPosition: bigint): number {
  // Pour eviter un overflow sur la division, on ramene les deux
  // valeurs a un meme facteur avant de diviser. La position est en
  // 8 decimales, donc le rapport est en float sans facteur.
  const num = Number(currentPosition);
  const denom = Number(INITIAL_LBTC_POSITION);
  return ((num - denom) / denom) * 100;
}

// ---------------------------------------------------------------------------
// 4. Ecriture CSV
// ---------------------------------------------------------------------------

const CSV_PATH = "/tmp/merion-sim-multi-mandates.csv";
const CSV_HEADER = "epoch,mandate_sold,bid_price_mrn,lbtc_drift_pct,pool_mrn_balance,pool_lbtc_position,total_fees_mrn";

function toCsvNumber(value: bigint, decimals: number): string {
  // Formate un bigint avec `decimals` decimales fixes, en notation
  // decimale classique. Pas de notation scientifique (le carnet de
  // projet veut des nombres lisibles, pas des mantisses).
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = abs % factor;
  const fracStr = frac.toString().padStart(decimals, "0");
  const sign = negative ? "-" : "";
  return `${sign}${whole.toString()}.${fracStr}`;
}

function recordsToCsv(records: EpochRecord[]): string {
  const lines: string[] = [CSV_HEADER];
  for (const r of records) {
    // lbtc_drift_pct est un float signe, on le garde en notation
    // classique a 6 decimales pour la precision (le brief demande des
    // valeurs lisibles, et 6 decimales suffisent pour deriver en
    // pourcent).
    const driftStr = r.lbtcDriftPct.toFixed(6);
    // bid_price_mrn en 18 decimales, pool_mrn_balance en 18 decimales,
    // pool_lbtc_position en 8 decimales, total_fees_mrn en 18.
    const bidStr = toCsvNumber(r.bidPriceMrn, 18);
    const mrnBalStr = toCsvNumber(r.poolMrnBalance, 18);
    const lbtcPosStr = toCsvNumber(r.poolLbtcPosition, 8);
    const feesStr = toCsvNumber(r.totalFeesMrn, 18);
    lines.push(
      [
        r.epoch.toString(),
        r.mandateSold.toString(),
        bidStr,
        driftStr,
        mrnBalStr,
        lbtcPosStr,
        feesStr,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 5. Resume en seance + verdict
// ---------------------------------------------------------------------------

function emitSessionSummary(records: EpochRecord[]): {
  numSimulated: number;
  numSold: number;
  numUnsold: number;
  finalDriftPct: number;
  totalFeesMrn: bigint;
  finalMrnBalance: bigint;
  finalLbtcPosition: bigint;
} {
  const numSimulated = records.length;
  const numSold = records.filter((r) => r.mandateSold === 1).length;
  const numUnsold = numSimulated - numSold;
  const last = records[records.length - 1];
  if (!last) {
    throw new Error("Simulation vide : aucun mandat genere");
  }
  const finalDriftPct = last.lbtcDriftPct;
  const totalFeesMrn = last.totalFeesMrn;
  const finalMrnBalance = last.poolMrnBalance;
  const finalLbtcPosition = last.poolLbtcPosition;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("SIMULATION MULTI-MANDATS — TACHE 13 (voie A)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Mandats simules      : ${numSimulated}`);
  console.log(`Mandats vendus       : ${numSold}`);
  console.log(`Mandats invendus     : ${numUnsold}`);
  console.log(`Taux de participation: ${(PARTICIPATION_RATE * 100).toFixed(1)} %`);
  console.log(`Dérive finale LBTC   : ${finalDriftPct.toFixed(6)} %`);
  console.log(`Position LBTC finale : ${toCsvNumber(finalLbtcPosition, 8)} (8 decimales)`);
  console.log(`Solde MRN final      : ${toCsvNumber(finalMrnBalance, 18)} (18 decimales)`);
  console.log(`Fees totales perques : ${toCsvNumber(totalFeesMrn, 18)} MRN (18 decimales)`);
  console.log(`CSV ecrit dans       : ${CSV_PATH}`);
  console.log("═══════════════════════════════════════════════════════════");

  return {
    numSimulated,
    numSold,
    numUnsold,
    finalDriftPct,
    totalFeesMrn,
    finalMrnBalance,
    finalLbtcPosition,
  };
}

function emitVerdict(summary: ReturnType<typeof emitSessionSummary>): void {
  // Le verdict est adapte a la simulation : la pool reste solvable tant
  // que sa position LBTC est strictement positive (elle peut servir
  // d'autres swaps) et que la derive cumulee n'a pas franchi un seuil
  // desastreux (ici, 50 %, qui est le double de la limite de la bande
  // Pool la plus stricte). Au-dela, le pool aurait perdu sa parite
  // LBTC/BTC de maniere probablement irreversible dans le cadre du
  // modele simplifie.
  const positionPositive = summary.finalLbtcPosition > 0n;
  // 50 % en pourcent, on l'evalue en valeur absolue de la derive.
  const driftCatastrophic = Math.abs(summary.finalDriftPct) > 50;
  const solvable = positionPositive && !driftCatastrophic;

  if (solvable) {
    console.log(
      `OK — la pool reste solvable avec ${summary.numUnsold} mandats invendus ` +
      `(derive finale ${summary.finalDriftPct.toFixed(6)} %, ` +
      `position LBTC finale ${toCsvNumber(summary.finalLbtcPosition, 8)}).`,
    );
  } else if (!positionPositive) {
    console.log(
      `ECHEC — la pool n'a plus de LBTC en reserve apres ${summary.numSimulated} mandats ` +
      `(position finale : ${toCsvNumber(summary.finalLbtcPosition, 8)}).`,
    );
  } else {
    console.log(
      `ECHEC — la derive LBTC a franchi le seuil de catastrophe (${summary.finalDriftPct.toFixed(6)} % > 50 %).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Point d'entree
// ---------------------------------------------------------------------------

import { writeFileSync, renameSync } from "node:fs";

function main(): void {
  const records = runSimulation();
  const csv = recordsToCsv(records);

  // Ecriture atomique : on passe par un fichier temporaire, puis
  // rename, pour qu'un lecteur concurrent (le carnet de projet, un
  // tableur) ne voie jamais un CSV partiellement ecrit.
  const tmpPath = `${CSV_PATH}.tmp`;
  writeFileSync(tmpPath, csv, { encoding: "utf8" });
  renameSync(tmpPath, CSV_PATH);

  const summary = emitSessionSummary(records);
  emitVerdict(summary);
}

main();

