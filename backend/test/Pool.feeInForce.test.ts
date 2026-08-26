// Suite fonctionnelle TypeScript pour Pool.feeInForce().
//
// AVERTISSEMENT, a lire avant le reste du fichier : CETTE COUCHE NE PEUT PAS
// DISTINGUER feeInForce() D'UNE CONSTANTE.
//
// La raison tient en deux faits, et elle vaut pour CE FICHIER, qui n'appelle
// jamais setFee. D'une part, lastSetFeeEpoch n'est ecrit que par setFee, que
// rien ici ne declenche : il reste donc a 0 d'un bout a l'autre. D'autre part,
// pendant l'epoch 0 — la seule ou la comparaison du ternaire puisse alors etre
// vraie — feeNum vaut exactement NOMINAL_FEE_NUM, pose par le constructeur.
// La branche "mandat courant" du ternaire n'est donc jamais prise ici avec une
// valeur qui la distingue de l'autre branche. Un contrat dont feeInForce()
// serait ecrit `return NOMINAL_FEE_NUM` passerait ce fichier a l'identique, du
// premier au dernier `it`.
//
// Depuis que setFee est passe au gestionnaire du mandat courant, une route ABI
// legitime existe pour ecrire lastSetFeeEpoch (setManager, puis setFee dans la
// fenetre de priorite du mandat) ; elle appartient a la suite de setFee, pas a
// celle-ci, dont le perimetre reste la LECTURE par un tiers.
//
// La preuve vit donc ailleurs, dans test/Pool.feeInForce.t.sol : elle y est
// obtenue en forgeant le slot partage par vm.store, seul moyen d'exhiber un
// etat ou les deux branches rendent des valeurs differentes. Un lecteur qui
// ne verrait que le present fichier conclurait a une couverture en
// trompe-l'oeil, et il aurait raison — c'est pour cela que l'avertissement
// ouvre le fichier plutot que de se cacher plus bas.
//
// Ce que cette couche-ci couvre, et qui a sa valeur propre : la LECTURE par
// un tiers. Le front, et plus tard le bot d'enchere, appelleront feeInForce()
// par eth_call a travers l'ABI generee, sans envoyer de transaction, pour
// afficher ou anticiper le frais en vigueur. Meme justification que pour
// test/Pool.currentEpoch.test.ts, dont ce fichier reprend la forme. Ce qui se
// verifie ici est donc : que la fonction est bien exposee et lisible sans
// transaction, qu'elle rend la valeur de deploiement du POOL INTERROGE et non
// un nombre grave dans l'ABI (d'ou deux pools a nominaux differents, section
// I.A), que le passage d'epoch ne demande aucun appel, et que la lecture ne
// deplace rien, meme en pause.
//
// Hors perimetre, explicitement : setFee sous toutes ses formes (le legacy
// onlyOwner a ete supprime, le setFee gestionnaire est couvert ailleurs), et
// le chemin de frais de swap(), qui lit aujourd'hui feeNum BRUT et non
// feeInForce() (Pool.sol:218). Cette divergence est connue et sa resolution
// appartient a une etape ulterieure : aucun test de ce fichier ne l'epingle,
// dans un sens ou dans l'autre.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis les sept autres fichiers plutot que partagees.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const DEFAULT_FEE_NUM = 5n; // _nominalFeeNum du deploiement de reference
const MIN_FEE_NUM = 1n; // _minFeeNum, cf. PoolTestBase.sol
const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n; // cf. build-auction.md 5.0 bis

// Le second nominal de la section I.A. Choisi tres loin de DEFAULT_FEE_NUM, et
// sous la borne du constructeur : la garde FeeTooHigh exige
// _nominalFeeNum * UNBALANCE_FACTOR <= MAX_FEE_NUM, soit 20 * 2 = 40 <= 50.
const ALTERNATE_FEE_NUM = 20n;

// Amorcage de la fixture des sections III.A et III.B : 100 unites a 8
// decimales sur chaque jambe, exactement l'amorcage de Pool.pause.test.ts et
// de Pool.currentEpoch.test.ts.
const SEED_AMOUNT = 100n * 10n ** 8n; // 1e10

// L'epoch lointaine de la section II.B. Choisie loin du premier basculement
// pour montrer que le repli sur le nominal ne tient pas au premier tour de
// compteur.
const FAR_EPOCH = 42n;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.currentEpoch.test.ts et Pool.constructor.test.ts,
// deliberement. Ce fichier ouvre sa propre connexion reseau via
// network.create() : la partager avec les autres fichiers reviendrait a
// partager l'etat blockchain et le cache de loadFixture entre des suites qui
// doivent pouvoir tourner, echouer et evoluer separement (voir
// test/README.md). Rien n'est importe depuis un autre fichier de test, y
// compris le deployPoolWith de Pool.constructor.test.ts, dont l'approche est
// reprise mais reecrite en local.
// ---------------------------------------------------------------------------

async function deployTokensFixture() {
  const [deployer, depositor, other, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);

  const tokens = [wbtc, cbbtc, lbtc] as const;
  const tokenAddresses = [wbtc.address, cbbtc.address, lbtc.address] as const;

  return { deployer, depositor, other, treasury, tokens, wbtc, cbbtc, lbtc, tokenAddresses };
}

type TokensFixture = Awaited<ReturnType<typeof deployTokensFixture>>;

// Deploie un pool sur des jetons deja en place, en laissant l'appelant choisir
// le nominal. C'est ce parametre-la qui est le sujet de la section I.A : une
// lecture qui rendrait le meme nombre pour deux nominaux distincts serait une
// constante, pas une lecture d'etat.
function deployPoolWith(base: TokensFixture, nominalFeeNum: bigint) {
  return viem.deployContract("Pool", [
    [...base.tokenAddresses],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    nominalFeeNum,
    base.treasury.account.address,
    base.deployer.account.address,
  ]);
}

// Le deploiement de reference, celui que porte le reste de la suite.
async function deployPoolFixture() {
  const base = await deployTokensFixture();
  const pool = await deployPoolWith(base, DEFAULT_FEE_NUM);

  // GENESIS est lu SUR LA CHAINE, jamais recalcule depuis l'horloge du test :
  // c'est l'ancre de toutes les dates de ce fichier.
  const genesis = await pool.read.GENESIS();

  return { ...base, pool, genesis };
}

type PoolFixture = Awaited<ReturnType<typeof deployPoolFixture>>;

// Pool amorce a montants egaux (1e10 sur chaque reserve), puis mis en pause
// par son owner. Sert aux deux sections qui interrogent l'independance de la
// vue vis-a-vis de l'etat du pool.
async function deploySeededPausedPoolFixture() {
  const base = await deployPoolFixture();

  for (const token of base.tokens) {
    await token.write.mint([base.depositor.account.address, SEED_AMOUNT]);
    await token.write.approve([base.pool.address, SEED_AMOUNT], {
      account: base.depositor.account,
    });
  }
  await base.pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], {
    account: base.depositor.account,
  });

  await base.pool.write.pause({ account: base.deployer.account });

  return base;
}

// Place le prochain bloc EXACTEMENT sur `timestamp`, puis le mine.
//
// Pourquoi setNextBlockTimestamp + mine plutot que time.increase(delta) : la
// cible est absolue, donc l'assertion porte sur la date que le commentaire
// annonce, sans deriver de la seconde consommee par chaque transaction
// precedente. Miner un bloc VIDE n'est pas envoyer une transaction : c'est
// precisement ce que la section II veut montrer, le repli sur le nominal ne
// coute aucun appel a personne.
async function warpTo(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
  await networkHelpers.mine();
}

// Lit tout l'etat du pool qu'une ecriture clandestine dans feeInForce()
// pourrait deplacer. Sert a la section III.A.
async function readMutableState(pool: PoolFixture["pool"]) {
  return {
    reserves: [
      await pool.read.reserves([0n]),
      await pool.read.reserves([1n]),
      await pool.read.reserves([2n]),
    ],
    feeNum: await pool.read.feeNum(),
    lastSetFeeEpoch: await pool.read.lastSetFeeEpoch(),
    totalSupply: await pool.read.totalSupply(),
  };
}

const bigintReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

describe("Pool.feeInForce", async function () {

  // ---------------------------------------------------------------------------
  // I] La valeur rendue au deploiement
  // ---------------------------------------------------------------------------

  describe("I] La valeur rendue au deploiement", function () {
    describe("A) Le nominal passe au constructeur, sur deux pools distincts", function () {
      // Les deux `it` de cette sous-section se lisent ENSEMBLE. Chacun seul
      // montre un nombre ; la paire montre que ce nombre suit l'argument du
      // constructeur du pool interroge, et n'est donc pas grave dans l'ABI ni
      // partage entre deploiements. C'est la seule chose que cette couche
      // puisse dire contre l'hypothese de la constante, et elle est faible :
      // NOMINAL_FEE_NUM etant lui-meme un immuable pose par le constructeur,
      // un `return NOMINAL_FEE_NUM` passerait aussi ces deux tests.
      it("un pool deploye a _nominalFeeNum = 5 rend 5", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);
        const pool = await deployPoolWith(base, DEFAULT_FEE_NUM);

        const fee = await pool.read.feeInForce();
        assert.equal(
          fee,
          DEFAULT_FEE_NUM,
          `feeInForce() vaut ${fee} au deploiement, attendu ${DEFAULT_FEE_NUM} (_nominalFeeNum du constructeur)`,
        );
      });

      it("un pool deploye a _nominalFeeNum = 20 rend 20", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);
        const pool = await deployPoolWith(base, ALTERNATE_FEE_NUM);

        const fee = await pool.read.feeInForce();
        assert.equal(
          fee,
          ALTERNATE_FEE_NUM,
          `feeInForce() vaut ${fee} sur un pool deploye a ${ALTERNATE_FEE_NUM}, attendu ${ALTERNATE_FEE_NUM} : la vue suit l'argument du constructeur, elle n'est pas gravee dans l'ABI`,
        );
      });
    });

    describe("B) Accord avec le getter brut feeNum()", function () {
      it("a l'epoch 0, feeInForce() et feeNum() rendent la meme valeur", async function () {
        // A l'epoch 0, lastSetFeeEpoch (0) egale currentEpoch() (0), donc le
        // ternaire prend sa premiere branche et rend feeNum. Comme le
        // constructeur a pose feeNum = NOMINAL_FEE_NUM, les deux branches
        // coincident : cet accord ne dit donc PAS quelle branche a ete prise.
        // Ce qu'il fige, c'est qu'un front qui lirait l'un ou l'autre getter
        // pendant la premiere epoch afficherait le meme chiffre.
        const { pool } = await networkHelpers.loadFixture(deployPoolFixture);

        const [fee, raw] = [await pool.read.feeInForce(), await pool.read.feeNum()];
        assert.equal(
          fee,
          BigInt(raw),
          `feeInForce() vaut ${fee} et feeNum() vaut ${raw} a l'epoch 0, attendu deux fois la meme valeur`,
        );
      });
    });

    describe("C) lastSetFeeEpoch est lisible par l'ABI", function () {
      it("lastSetFeeEpoch() vaut 0 au deploiement", async function () {
        // Le constructeur ne l'ecrit pas (Pool.sol:100-105) : il reste a la
        // valeur par defaut du slot. Ce test fige deux choses a la fois : que
        // le champ est bien expose en public — le front en aura besoin pour
        // savoir si le mandat courant a deja pose son frais — et que sa valeur
        // de depart est 0, ce dont depend toute la section I.B ci-dessus.
        const { pool } = await networkHelpers.loadFixture(deployPoolFixture);

        const lastSetFeeEpoch = await pool.read.lastSetFeeEpoch();
        assert.equal(
          lastSetFeeEpoch,
          0,
          `lastSetFeeEpoch() vaut ${lastSetFeeEpoch} au deploiement, attendu 0`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] Le repli sur le nominal quand l'epoch a tourne
  //
  // Ce que ces deux `it` montrent DEPUIS L'EXTERIEUR : le temps passe, plus
  // aucun frais de mandat n'est en vigueur, et personne n'a rien envoye. Ils
  // ne montrent pas que la vue a bascule — sur l'etat actuel du contrat, elle
  // rendait deja le nominal a l'epoch 0. La bascule elle-meme est prouvee dans
  // test/Pool.feeInForce.t.sol, section III.
  // ---------------------------------------------------------------------------

  describe("II] Le repli sur le nominal quand l'epoch a tourne", function () {
    describe("A) L'epoch 1", function () {
      it("a GENESIS + EPOCH_DURATION, feeInForce() rend NOMINAL_FEE_NUM sans qu'aucune transaction ait ete envoyee", async function () {
        // Calcul a la main : (GENESIS + 14400 - GENESIS) / 14400 = 1, donc
        // lastSetFeeEpoch (0) differe de currentEpoch() (1) et le ternaire
        // prend sa seconde branche. Le seul bloc mine entre le deploiement et
        // la lecture est VIDE : aucun appelant n'a eu a payer un SSTORE de
        // remise a zero, ce qui est toute la raison d'etre du reset paresseux.
        const { pool, genesis } = await networkHelpers.loadFixture(deployPoolFixture);

        await warpTo(genesis + EPOCH_DURATION);

        const fee = await pool.read.feeInForce();
        assert.equal(
          fee,
          DEFAULT_FEE_NUM,
          `feeInForce() vaut ${fee} a l'epoch 1, attendu ${DEFAULT_FEE_NUM} (NOMINAL_FEE_NUM)`,
        );
      });
    });

    describe("B) Une epoch lointaine", function () {
      it("au milieu de l'epoch 42, feeInForce() rend encore NOMINAL_FEE_NUM", async function () {
        // Calcul a la main : GENESIS + 42 * 14400 + 7200 = GENESIS + 612000,
        //   612000 / 14400 = 42,5 -> 42 en division entiere.
        // Quarante-deux epochs sans le moindre appel, et la vue rend toujours
        // une valeur exploitable : la propriete ne tient pas au premier tour
        // de compteur, et elle ne se degrade pas avec le temps ecoule.
        const { pool, genesis } = await networkHelpers.loadFixture(deployPoolFixture);

        await warpTo(genesis + FAR_EPOCH * EPOCH_DURATION + EPOCH_DURATION / 2n);

        const fee = await pool.read.feeInForce();
        assert.equal(
          fee,
          DEFAULT_FEE_NUM,
          `feeInForce() vaut ${fee} au milieu de l'epoch ${FAR_EPOCH}, attendu ${DEFAULT_FEE_NUM} (NOMINAL_FEE_NUM)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Proprietes de la lecture
  // ---------------------------------------------------------------------------

  describe("III] Proprietes de la lecture", function () {
    describe("A) La lecture n'a aucun effet de bord", function () {
      it("appeler feeInForce() ne deplace aucune valeur lisible du contrat", async function () {
        // feeInForce() est declaree `view` (Pool.sol:134), donc le compilateur
        // interdit deja l'ecriture. Ce que ce test ajoute est l'observation
        // depuis l'exterieur, la seule que le front puisse faire : sur un pool
        // amorce, donc avec un etat non trivial a deplacer, reserves, feeNum,
        // lastSetFeeEpoch et totalSupply sont identiques avant et apres
        // plusieurs lectures separees par un saut d'epochs.
        //
        // Le point pratique derriere : la lecture part en eth_call, elle ne
        // coute rien. Une vue qui aurait perdu son `view` exigerait une
        // transaction, et le bot d'enchere paierait du gas pour lire le frais
        // avant chaque decision.
        const { pool, genesis } = await networkHelpers.loadFixture(deploySeededPausedPoolFixture);

        const before = await readMutableState(pool);

        await pool.read.feeInForce();
        await warpTo(genesis + 5n * EPOCH_DURATION);
        await pool.read.feeInForce();

        const after = await readMutableState(pool);
        assert.deepEqual(
          after,
          before,
          `etat apres lectures=${JSON.stringify(after, bigintReplacer)}, attendu identique a avant=${JSON.stringify(before, bigintReplacer)}`,
        );
      });
    });

    describe("B) La pause ne change pas la valeur rendue", function () {
      it("sur un pool en pause, feeInForce() rend la meme valeur qu'hors pause", async function () {
        // CHOIX DE CONCEPTION, pas un oubli. feeInForce() ne porte pas
        // whenNotPaused, contrairement a addLiquidity et swap (Pool.sol:163,
        // Pool.sol:215). Une vue gardee par la pause serait d'ailleurs une
        // faute : la pause arrete ce qui DEPLACE de la valeur, elle n'a aucune
        // raison d'aveugler un front ou un bot qui veut afficher, ou archiver,
        // le frais en vigueur pendant l'incident. Le meme raisonnement vaut
        // pour currentEpoch(), dont l'horloge continue de defiler en pause
        // (voir Pool.currentEpoch.test.ts, III.B).
        const { pool } = await networkHelpers.loadFixture(deploySeededPausedPoolFixture);

        const paused = await pool.read.paused();
        assert.equal(paused, true, `la fixture devrait partir en pause, paused() vaut ${paused}`);

        const fee = await pool.read.feeInForce();
        assert.equal(
          fee,
          DEFAULT_FEE_NUM,
          `feeInForce() vaut ${fee} sur un pool en pause, attendu ${DEFAULT_FEE_NUM} : la vue reste lisible en pause`,
        );
      });
    });
  });
});
