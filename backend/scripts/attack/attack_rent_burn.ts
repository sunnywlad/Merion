// SPDX-License-Identifier: MIT
//
// Audit F5 — La rente en cours brûlée dans l'adresse morte.
//
// La faille. Si tous les LP sortent pendant un flux de rente,
// `totalSupply()` retombe à `MINIMUM_LIQUIDITY`, les 1 000 parts frappées
// à `0x…dEaD` au bootstrap, qui ne réclamera jamais rien. Le temps
// passait. `_updateRent` avançait quand même `accPerShare` de
// `dt * rentRate / totalSupply` : toute la queue du flux était attribuée
// à l'adresse morte, donc perdue pour de bon. Le garde-fou `rentLeftOver`
// ne couvrait que le cas où `notifyRent` arrive sur un pool DÉJÀ vide,
// pas celui où le pool se vide PENDANT le flux. Aucune malveillance n'est
// requise : il suffit que les LP sortent tous, ce que le protocole leur
// garantit de pouvoir faire à tout instant, même en pause.
//
// Gardes visées. `Pool._updateRent` : quand `totalSupply() <=
// MINIMUM_LIQUIDITY`, l'accumulateur ne bouge pas, la tranche est
// reportée dans `rentLeftOver` et `rentLastUpdate` est recalé pour
// qu'elle ne soit jamais comptée deux fois. Et `Pool._accProjected`, la
// vue partagée avec `claimable()`, à qui la MÊME condition est appliquée :
// sans cette symétrie, la vue promettrait une rente que le chemin
// écrivain ne crédite pas.
//
// Verdict attendu. Après la sortie totale et l'écoulement du temps :
// `accPerShare` inchangé, `rentLeftOver` égal à `dt * rentRate / 1e18` au
// wei près, et le report effectivement refondu dans le flux suivant.
//
// État partagé. Le script déploie son propre Pool et se branche
// lui-même comme enchère (`setAuction(deployer)`), pour pouvoir appeler
// `notifyRent` sans passer par un vrai règlement. Sur le pool du nœud
// d'audit, `auction` est déjà posée et `setAuction` est à un coup : la
// voie n'existe pas. Le pool frais rend aussi le script rejouable sans
// redémarrer le nœud, ce qui est interdit.

import {
  buildAttackContext,
  runAttack,
  resetVerdicts,
  finalize,
  chainNow,
  warpTo,
  type AttackContext,
} from "./_harness.js";

const EPOCH_DURATION = 14400n; // 4 h
const PRIORITY_WINDOW = 12n;
const MIN_FEE_NUM = 1n;
const NOMINAL_FEE_NUM = 5n;
const TREASURY = "0x00000000000000000000000000000000000beef0" as const;
const SCALE = 10n ** 18n;

// Amorce par jambe : 100 unités à 8 décimales, réserves 1:1:1.
const SEED = 100n * 10n ** 8n;
// Montant du flux. `EPOCH_DURATION * 1e18` fait tomber `rentRate` sur une
// valeur ronde et rend l'assertion au wei près lisible à la main.
const RENT = EPOCH_DURATION * SCALE;

async function deployFreshPool(ctx: AttackContext) {
  const { addresses, deployer } = ctx;
  const pool = await ctx.viem.deployContract("Pool", [
    [addresses.wbtc, addresses.cbBtc, addresses.lbtc],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    TREASURY,
    addresses.mrn,
    deployer.account.address,
  ]);
  return pool;
}

async function main(): Promise<void> {
  resetVerdicts();
  const ctx = await buildAttackContext();
  const pool = await deployFreshPool(ctx);
  ctx.contracts.pool = pool;

  const { mrn, wbtc, cbBtc, lbtc } = ctx.contracts;
  const lp = ctx.deployer;
  const wait = (hash: `0x${string}`) => ctx.publicClient.waitForTransactionReceipt({ hash });

  // Le déployeur joue à la fois l'enchère (pour `notifyRent`) et l'unique
  // LP. C'est le même raccourci que test/Pool.rent.t.sol : on isole la
  // mécanique de l'accumulateur, pas le contrôle d'accès, qui a ses
  // propres tests.
  await wait(await pool.write.setAuction([lp.account.address], { account: lp.account }));

  for (const token of [wbtc, cbBtc, lbtc]) {
    await wait(await token.write.mint([lp.account.address, SEED], { account: lp.account }));
    await wait(await token.write.approve([pool.address, SEED], { account: lp.account }));
  }
  await wait(await pool.write.addLiquidity([0n, SEED, 0n], { account: lp.account }));

  // Ouverture du flux de rente.
  await wait(await mrn.write.approve([pool.address, RENT], { account: lp.account }));
  await wait(await pool.write.notifyRent([RENT], { account: lp.account }));

  const rentRate = (await pool.read.rentRate()) as bigint;
  const streamStart = (await pool.read.rentLastUpdate()) as bigint;

  // Sortie TOTALE de l'unique LP au quart du flux. `_updateRent` tourne
  // AVANT le burn (le choke point `_update` d'OZ v5), donc l'accru du
  // sortant est bien figé sur son solde pré-burn : cette moitié-là n'a
  // jamais été en cause.
  const exitTs = streamStart + EPOCH_DURATION / 4n;
  await warpTo(ctx, exitTs - 1n);
  const shares = (await pool.read.balanceOf([lp.account.address])) as bigint;
  await wait(await pool.write.removeLiquidity([shares, [0n, 0n, 0n]], { account: lp.account }));

  const exitActual = await chainNow(ctx);
  const accAtExit = (await pool.read.accPerShare()) as bigint;
  const leftOverAtExit = (await pool.read.rentLeftOver()) as bigint;

  // Le pool tourne un quart d'epoch de plus avec, pour seul porteur, les
  // 1 000 parts mortes. C'est la tranche qui disparaissait.
  const wakeTs = streamStart + EPOCH_DURATION / 2n;
  await warpTo(ctx, wakeTs - 1n);

  // Une touche minimale déclenche `_updateRent` sans bouger le supply :
  // un transfert de zéro vers soi-même.
  await wait(await pool.write.transfer([lp.account.address, 0n], { account: lp.account }));
  const touchTs = await chainNow(ctx);

  await runAttack(
    "Rente brûlée — la fixture laisse bien le pool aux seules parts mortes (préalable)",
    "totalSupply() == MINIMUM_LIQUIDITY après la sortie totale",
    async () => {
      const supply = (await pool.read.totalSupply()) as bigint;
      const minimum = (await pool.read.MINIMUM_LIQUIDITY()) as bigint;
      if (supply !== minimum) {
        throw new Error(
          `totalSupply vaut ${supply}, attendu MINIMUM_LIQUIDITY = ${minimum}. ` +
          `La sortie n'a pas vidé le pool : les tests suivants ne portent pas ` +
          `sur l'état qu'ils croient interroger.`,
        );
      }
    },
  );

  await runAttack(
    "Rente brûlée — accPerShare n'avance pas tant que seule l'adresse morte détient des parts",
    "accPerShare inchangé entre la sortie totale et la touche suivante",
    async () => {
      const accNow = (await pool.read.accPerShare()) as bigint;
      if (accNow !== accAtExit) {
        throw new Error(
          `accPerShare vaut ${accNow}, attendu ${accAtExit} inchangé. ` +
          `L'accumulateur a avancé sur un pool sans LP vivant : chaque unité ` +
          `gagnée est une unité due à une adresse qui ne réclamera jamais.`,
        );
      }
    },
  );

  await runAttack(
    "Rente brûlée — la tranche écoulée à vide est reportée dans rentLeftOver",
    "rentLeftOver == dt * rentRate / 1e18, au wei près",
    async () => {
      const leftOver = (await pool.read.rentLeftOver()) as bigint;
      const expected = leftOverAtExit + ((touchTs - exitActual) * rentRate) / SCALE;
      if (leftOver !== expected) {
        throw new Error(
          `rentLeftOver vaut ${leftOver}, attendu ${expected} ` +
          `(dt = ${touchTs - exitActual} s, rentRate = ${rentRate}). Un correctif ` +
          `qui figerait accPerShare sans reporter la tranche perdrait ` +
          `exactement le même MRN, plus discrètement.`,
        );
      }
    },
  );

  await runAttack(
    "Rente brûlée — le report rejoint le flux suivant",
    "le nouveau rentRate inclut rentLeftOver et la queue non parcourue",
    async () => {
      // Un LP revient, puis l'enchère notifie un nouveau flux.
      for (const token of [wbtc, cbBtc, lbtc]) {
        await wait(await token.write.mint([lp.account.address, SEED], { account: lp.account }));
        await wait(await token.write.approve([pool.address, SEED], { account: lp.account }));
      }
      await wait(await pool.write.addLiquidity([0n, SEED, 0n], { account: lp.account }));

      const leftOverBefore = (await pool.read.rentLeftOver()) as bigint;
      const rentEnd = (await pool.read.rentEnd()) as bigint;
      const rateBefore = (await pool.read.rentRate()) as bigint;

      await wait(await mrn.write.approve([pool.address, RENT], { account: lp.account }));
      await wait(await pool.write.notifyRent([RENT], { account: lp.account }));
      const notifyTs = await chainNow(ctx);

      const tail = rentEnd > notifyTs ? (rateBefore * (rentEnd - notifyTs)) / SCALE : 0n;
      const expectedRate = ((RENT + leftOverBefore + tail) * SCALE) / EPOCH_DURATION;
      const rateAfter = (await pool.read.rentRate()) as bigint;
      if (rateAfter !== expectedRate) {
        throw new Error(
          `rentRate vaut ${rateAfter} après le nouveau flux, attendu ` +
          `${expectedRate} = (RENT + rentLeftOver ${leftOverBefore} + queue ` +
          `${tail}) * 1e18 / EPOCH_DURATION. Le report resterait un cimetière ` +
          `au lieu d'une salle d'attente.`,
        );
      }
    },
  );

  finalize();
}

main().catch((err) => {
  console.error("Erreur fatale attack_rent_burn :", err);
  process.exit(1);
});
