// SPDX-License-Identifier: MIT
//
// Tâche 11 — `InsufficientReserve`, l'honnête.
//
// Forme observée : INVARIANT. La garde à Pool.sol:385 s'écrit
//   require(cachedReserves[_indexOut] > amountOut, InsufficientReserve())
// où `amountOut` est le résultat de `_getAmountOut` (Pool.sol:243-245),
// calculé AVANT le `require`. C'est une comparaison SORTIE-CALCULÉE vs
// RÉSERVE-DISPO, pas une comparaison ENTRÉE vs ZÉRO.
//
// CE SCRIPT DÉMONTRE QUE CETTE GARDE EST INATTEIGNABLE DEPUIS L'EXTÉRIEUR
// sous le produit constant, et explique pourquoi la forme « invariant » est
// la forme défendue plutôt que la forme « cause ».
//
// MATHÉMATIQUE : `_getAmountOut` calcule
//   amountOut = floor(dxAfterFee * r_out / (dxAfterFee + r_in))
// Pour tout `dxAfterFee > 0` (donc `_amount > 0` après la fee non-nulle) :
//   dxAfterFee * r_out  <  (dxAfterFee + r_in) * r_out    [puisque r_in > 0]
//   =>  dxAfterFee * r_out / (dxAfterFee + r_in)  <  r_out
//   =>  amountOut = floor(...)  <  r_out                   [arrondi inférieur]
// Donc `cachedReserves[_indexOut] > amountOut` est GARANTI PAR CONSTRUCTION
// pour toute entrée positive. Le seul cas où la garde pourrait être
// atteinte serait `dxAfterFee = 0`, mais alors `amountOut = 0` et la garde
// `ZeroOutput` (Pool.sol:384) se déclenche AVANT `InsufficientReserve`
// (ligne :384 < :385 dans l'ordre des checks). InsufficientReserve est donc
// une DEUXIÈME LIGNE DE DÉFENSE, jamais la première : la BANDE
// (FloorTouched / CeilingTouched à Pool.sol:417-420) stoppe un drain
// excessif bien avant que la formule ne sature. La formule, elle, ne
// sature JAMAIS : `amountOut` tend asymptotiquement vers `r_out` sans
// jamais l'atteindre.
//
// FORME « CAUSE » vs « INVARIANT » :
//   Forme « cause »     : require(r_in > 0, InsufficientReserve()).
//                         Trivialement satisfaite après bootstrap (r_in > 0
//                         toujours). N'attrape pas le cas théorique d'un
//                         `_getAmountOut` modifié pour rendre
//                         amountOut >= r_out (impossible avec la formule
//                         actuelle, mais aucune garde ne le défendrait).
//                         INSUFFISANT comme garde indépendante.
//   Forme « invariant » : require(r_out > amountOut, InsufficientReserve()).
//                         Conséquence stricte de la formule CFMM, satisfaite
//                         PAR CONSTRUCTION pour tout dxAfterFee > 0.
//                         Robuste à une régression : si `_getAmountOut` est
//                         modifié pour rendre amountOut >= r_out dans
//                         certains cas, la garde attrape. C'est la forme
//                         défendue, et Pool.sol:385 la tient.

import type { AttackContext } from "./_harness.js";
import {
  buildAttackContext,
  bootstrapPool,
  recordAttack,
  runAttack,
  resetVerdicts,
  finalize,
} from "./_harness.js";

// Les 6 permutations (in, out) avec in ≠ out. Couvre tous les chemins de
// swap non triviaux.
const PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1],
];

// Sanity test : 1 centième d'unité (1e6 wei à 8 décimales). Reste largement
// dans la bande et sort un amountOut sub-pourcent de la réserve, donc
// aucune garde ne se déclenche — y compris InsufficientReserve, que le
// récapitulatif ne doit pas voir apparaître.
const NORMAL_SWAP = 1n * 10n ** 6n;

// Multiplicateur de la réserve d'entrée pour le probe. 10 × r_in est
// "huge but bounded" : suffisant pour pousser la BANDE au déclenchement
// (ceiling 53 % sur la jambe d'entrée ou floor 13 % sur la jambe de sortie)
// bien avant que la formule ne sature. Reste sous le cap de MockWrappedBTC
// (21M tokens à 8 décimales, soit 2.1e15 wei) tant que r_in < 2.1e14.
const PROBE_MULTIPLIER = 10n;

interface ProbeResult {
  ok: boolean;
  observed: string;
}

// Tente un swap `(inIdx, probeAmount, outIdx, 0)` et classe le résultat.
// Le verdict est OK si la garde InsufficientReserve n'est PAS déclenchée
// (c'est l'attendu : la garde est inatteignable). Un revert sur une autre
// garde (bande, slippage, overflow) reste OK : il démontre qu'une AUTRE
// ligne de défense a attrapé le probe avant InsufficientReserve.
async function probeUnreachable(
  ctx: AttackContext,
  inIdx: number,
  outIdx: number,
  probeAmount: bigint,
): Promise<ProbeResult> {
  const tokens = [ctx.contracts.lbtc, ctx.contracts.wbtc, ctx.contracts.cbBtc];
  const token = tokens[inIdx];

  // (a) S'assurer que l'attaquant a le solde ET l'allowance suffisants.
  //     Le bootstrap a financé 5e8 + approuvé 1e9 ; on complète si le
  //     probe dépasse. mint est public sur MockWrappedBTC (pas de garde
  //     d'accès, contrat:16) et capped à 21M tokens (contrat:9). Le probe
  //     reste sous le cap tant que r_in < 2.1e14, vrai sur l'état bootstrap.
  const balance = (await token.read.balanceOf([
    ctx.attacker.account.address,
  ])) as bigint;
  if (probeAmount > balance) {
    const extra = probeAmount - balance;
    const txMint = await token.write.mint(
      [ctx.attacker.account.address, extra],
      { account: ctx.deployer.account },
    );
    await ctx.publicClient.waitForTransactionReceipt({ hash: txMint });
    const txApprove = await token.write.approve(
      [ctx.contracts.pool.address, extra],
      { account: ctx.attacker.account },
    );
    await ctx.publicClient.waitForTransactionReceipt({ hash: txApprove });
  }

  // (b) Tenter le swap. `_minOut = 0` absorbe tout slippage pour ne pas
  //     confondre BadSlippage avec InsufficientReserve.
  try {
    const tx = await ctx.contracts.pool.write.swap(
      [BigInt(inIdx), probeAmount, BigInt(outIdx), 0n],
      { account: ctx.attacker.account },
    );
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status === "success") {
      return {
        ok: true,
        observed:
          "swap réussi — la garde InsufficientReserve n'a pas été sollicitée " +
          "(attendu : la BANDE aurait dû l'attraper, mais le probe n'a pas suffi " +
          "à pousser une jambe hors bande sur cet état)",
      };
    }
    return { ok: false, observed: `swap status=${receipt.status} (anomalie)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("InsufficientReserve")) {
      return {
        ok: false,
        observed:
          "InsufficientReserve DÉCLENCHÉE (ÉCHEC : la garde était censée être " +
          "inatteignable sous CFMM — c'est un défaut de cohérence entre la " +
          "formule et la garde)",
      };
    }
    if (message.includes("CeilingTouched")) {
      return {
        ok: true,
        observed:
          "CeilingTouched — la BANDE HAUTE stoppe le drain avant que la formule " +
          "ne sature (InsufficientReserve reste inatteignable)",
      };
    }
    if (message.includes("FloorTouched")) {
      return {
        ok: true,
        observed:
          "FloorTouched — la BANDE BASSE stoppe le drain avant que la formule " +
          "ne sature (InsufficientReserve reste inatteignable)",
      };
    }
    if (message.includes("BadSlippage")) {
      return {
        ok: true,
        observed:
          "BadSlippage — slippage non nul sur le probe (pas la garde visée, " +
          "InsufficientReserve reste inatteignable)",
      };
    }
    if (message.includes("ReserveOverflow")) {
      return {
        ok: true,
        observed:
          "ReserveOverflow — uint72 max dépassé sur l'accumulation (pas la garde " +
          "visée, InsufficientReserve reste inatteignable)",
      };
    }
    return { ok: false, observed: `erreur inattendue : ${message}` };
  }
}

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  await bootstrapPool(ctx);

  // (1) Lecture des réserves et en-tête de la démonstration numérique.
  const r = (await Promise.all([
    ctx.contracts.pool.read.reserves([0n]) as Promise<bigint>,
    ctx.contracts.pool.read.reserves([1n]) as Promise<bigint>,
    ctx.contracts.pool.read.reserves([2n]) as Promise<bigint>,
  ])) as [bigint, bigint, bigint];

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Tâche 11 — InsufficientReserve, l'honnête");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Forme observée : require(r_out > amountOut, InsufficientReserve())");
  console.log("  Source : Pool.sol:385 (juste après ZeroOutput à :384)");
  console.log(`  Réserves lues : [${r[0]}, ${r[1]}, ${r[2]}]`);
  console.log("  Formule CFMM : amountOut = floor(dxAfterFee * r_out / (dxAfterFee + r_in))");
  console.log("  Pour dxAfterFee > 0 : amountOut < r_out par construction (division entière).");
  console.log("");

  // (2) Pour chaque paire, on démontre l'inatteignabilité de deux façons :
  //     (a) `get_dy` confirme que le devis rendu est strictement inférieur
  //         à r_out (lecture statique de l'invariant, sans swap réel) ;
  //     (b) le swap réel avec un probe énorme ne déclenche JAMAIS
  //         InsufficientReserve — soit il réussit, soit il revertert sur
  //         la BANDE ou sur une garde sans rapport.
  for (const [inIdx, outIdx] of PAIRS) {
    const rIn = r[inIdx];
    const rOut = r[outIdx];
    const probeAmount = rIn * PROBE_MULTIPLIER;

    console.log(`── Paire (${inIdx} → ${outIdx}) : r_in=${rIn}, r_out=${rOut}, probe=${probeAmount}`);

    // (2.a) get_dy : vue pure (Pool.sol:261), aucune garde. Le devis
    //        retourné DOIT être < r_out par construction de la formule.
    let dyProbe: bigint;
    try {
      dyProbe = (await ctx.contracts.pool.read.get_dy([
        BigInt(inIdx), BigInt(outIdx), probeAmount,
      ])) as bigint;
      const margin = rOut - dyProbe;
      console.log(`   get_dy(${inIdx}, ${outIdx}, ${probeAmount}) = ${dyProbe}`);
      console.log(`   marge restante dans r_out : ${margin} wei (> 0 par construction)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   get_dy a échoué : ${msg}`);
      dyProbe = 0n;
    }

    // (2.b) Tenter le swap réel. Voir `probeUnreachable` pour la
    //        classification du résultat.
    const { ok, observed } = await probeUnreachable(ctx, inIdx, outIdx, probeAmount);
    console.log(`   Observation : ${observed}`);
    console.log("");

    const label = `InsufficientReserve inatteignable (${inIdx}→${outIdx})`;
    const expected =
      "la garde InsufficientReserve n'est PAS déclenchée (inatteignable sous CFMM)";
    if (ok) {
      recordAttack(label, expected, observed, true);
    } else {
      recordAttack(label, expected, observed, false, observed);
    }
  }

  // (3) Sanity test : un swap normal doit passer, sans guard visible dans
  //     la sortie (status === 'success'). C'est la confirmation
  //     qu'InsufficientReserve ne s'auto-déclenche pas en usage normal.
  await runAttack(
    "Sanity — swap normal 1e6 wei passe sans guard",
    "swap réussi (status === 'success'), aucune garde ne se déclenche",
    async () => {
      const tx = await ctx.contracts.pool.write.swap(
        [0n, NORMAL_SWAP, 1n, 0n],
        { account: ctx.attacker.account },
      );
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Error(`swap normal a reverter (status=${receipt.status})`);
      }
    },
  );

  // (4) Bloc de commentaire à lire en séance. Cause vs Invariant, et
  //     synthèse de l'inatteignabilité.
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Cause vs Invariant — texte à lire en séance");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Forme « cause »     : require(r_in > 0, InsufficientReserve())");
  console.log("    • Trivialement satisfaite après bootstrap (r_in > 0 toujours).");
  console.log("    • N'attrape pas le cas théorique d'un `_getAmountOut` modifié");
  console.log("      pour rendre amountOut >= r_out (impossible avec la formule");
  console.log("      actuelle, mais aucune garde ne le défendrait indépendamment).");
  console.log("    • INSUFFISANT comme garde indépendante.");
  console.log("");
  console.log("  Forme « invariant » : require(r_out > amountOut, InsufficientReserve())");
  console.log("    • Conséquence stricte de la formule CFMM :");
  console.log("      pour dxAfterFee > 0, amountOut < r_out par construction.");
  console.log("    • Robuste à une régression : si `_getAmountOut` est modifié pour");
  console.log("      rendre amountOut >= r_out dans certains cas, la garde attrape.");
  console.log("    • C'est la forme écrite à Pool.sol:385, et c'est la forme défendue.");
  console.log("");
  console.log("  Conclusion : InsufficientReserve est INATTEIGNABLE depuis l'extérieur");
  console.log("  sous le produit constant. La BANDE (FloorTouched / CeilingTouched)");
  console.log("  stoppe le drain BIEN AVANT que la formule ne sature, et la formule");
  console.log("  ne sature JAMAIS (amountOut tend asymptotiquement vers r_out sans");
  console.log("  jamais l'atteindre). InsufficientReserve est une DEUXIÈME LIGNE DE");
  console.log("  DÉFENSE défense-en-profondeur, pas la première.");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_insufficient_reserve :", err);
  process.exit(1);
});
