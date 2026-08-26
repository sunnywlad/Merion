// Suite fonctionnelle TypeScript pour Pool.currentEpoch().
//
// Pourquoi un fichier a part : currentEpoch() n'appartient a aucune des
// fonctions deja couvertes. Ce n'est ni un point d'entree qui deplace de la
// valeur, ni une valeur figee au deploiement — c'est une HORLOGE, et une
// horloge se teste par le temps qui passe, pas par des montants. Toute la
// suite existante est ecrite a temps fige (une seule exception, le setFee de
// Pool.pause.test.ts) ; y greffer des sauts de plusieurs heures rendrait ses
// fixtures dependantes d'un etat temporel qu'elles n'ont aucune raison de
// porter.
//
// Ce que la fonction dit exactement (Pool.sol:92-94) :
//
//   (block.timestamp - GENESIS) / EPOCH_DURATION
//
// Trois consequences que ce fichier epingle. D'abord, le compteur n'est
// JAMAIS stocke : il se derive a chaque lecture depuis deux immuables et
// l'horloge du bloc. C'est un choix de conception, pas un manque — aucune
// transaction n'a besoin d'etre envoyee pour faire avancer l'enchere, donc
// aucune epoque ne peut etre "sautee" faute d'appelant. Ensuite, la division
// entiere fait de la frontiere le seul endroit ou la fonction peut se
// tromper, d'ou la section II, qui est le coeur du fichier. Enfin, rien dans
// cette formule ne regarde l'etat du pool : ni les reserves, ni le frais, ni
// Pausable. La section III.B en tire le risque assume du protocole.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : la question est celle
// d'un LECTEUR EXTERNE. Le front, et plus tard le bot d'enchere, appelleront
// currentEpoch() par eth_call a travers l'ABI generee, sans envoyer de
// transaction, pour savoir quel mandat court. Ce que cette suite verifie est
// donc que cette lecture-la rend le bon numero a chaque instant du temps
// simule, exactement comme networkHelpers l'avance. Un test Solidity le
// ferait par vm.warp depuis l'interieur de l'EVM, ce qui repond a une autre
// question : celle de la formule, pas celle de la lecture.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis les cinq autres fichiers plutot que partagees.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const DEFAULT_FEE_NUM = 5n; // _nominalFeeNum
const MIN_FEE_NUM = 1n; // _minFeeNum, cf. PoolTestBase.sol
const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n; // cf. build-auction.md 5.0 bis

// Amorcage de la fixture utilisee par la section III.B (pool en pause) et
// III.C (aucun effet de bord) : 100 unites a 8 decimales sur chaque jambe,
// exactement l'amorcage de Pool.pause.test.ts.
const SEED_AMOUNT = 100n * 10n ** 8n; // 1e10

// L'epoque quelconque de la section II.C. Choisie loin du premier
// basculement pour montrer que la division entiere ne tient pas seulement au
// premier tour de compteur.
const FAR_EPOCH = 7n;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.pause.test.ts, deliberement. Ce fichier ouvre sa
// propre connexion reseau via network.create() : la partager avec les autres
// fichiers reviendrait a partager l'etat blockchain et le cache de
// loadFixture entre des suites qui doivent pouvoir tourner, echouer et
// evoluer separement (voir test/README.md).
// ---------------------------------------------------------------------------

async function deployTokensAndPoolFixture() {
  const [deployer, depositor, other, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    DEFAULT_FEE_NUM,
    treasury.account.address,
    deployer.account.address,
  ]);

  // GENESIS est lu SUR LA CHAINE, jamais recalcule depuis l'horloge du test :
  // c'est l'ancre de toutes les valeurs attendues de ce fichier, et la
  // recalculer reviendrait a reimplementer la ligne qu'on teste.
  const genesis = await pool.read.GENESIS();

  return { deployer, depositor, other, tokens, wbtc, cbbtc, lbtc, pool, genesis };
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Pool amorce a montants egaux (1e10 sur chaque reserve), puis mis en pause
// par son owner. Sert aux deux sections qui interrogent l'independance de
// l'horloge vis-a-vis de l'etat du pool.
async function deploySeededPausedPoolFixture() {
  const base = await deployTokensAndPoolFixture();

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
// frontiere de la section II se joue a la seconde, et un delta relatif
// deriverait de la seconde consommee par chaque transaction precedente. Ici
// la cible est absolue, donc l'assertion porte sur la valeur exacte que le
// commentaire annonce.
//
// Le eth_call qui suit lit bien ce bloc-la : sous Hardhat, une lecture sans
// bloc precise s'execute sur `latest`, donc sur le bloc que cette fonction
// vient de miner.
async function warpTo(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
  await networkHelpers.mine();
}

// Lit reserves / feeNum / lastFeeUpdate / totalSupply, c'est-a-dire tout
// l'etat du pool qu'une ecriture clandestine dans currentEpoch() pourrait
// deplacer. Sert a la section III.C.
async function readMutableState(pool: PoolFixture["pool"]) {
  return {
    reserves: [
      await pool.read.reserves([0n]),
      await pool.read.reserves([1n]),
      await pool.read.reserves([2n]),
    ],
    feeNum: await pool.read.feeNum(),
    lastFeeUpdate: await pool.read.lastFeeUpdate(),
    totalSupply: await pool.read.totalSupply(),
  };
}

describe("Pool.currentEpoch", async function () {

  // ---------------------------------------------------------------------------
  // I] L'epoque de depart
  // ---------------------------------------------------------------------------

  describe("I] L'epoque de depart", function () {
    describe("A) Au deploiement", function () {
      it("currentEpoch() vaut 0 sur le bloc de deploiement", async function () {
        // Calcul a la main : block.timestamp == GENESIS, donc
        //   (GENESIS - GENESIS) / 14400 = 0 / 14400 = 0.
        // L'epoque 0 est celle du deploiement, la numerotation ne commence
        // pas a 1. Tout le reste du fichier en depend : chaque valeur
        // attendue plus bas est un decompte de basculements DEPUIS cette
        // origine.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          0n,
          `currentEpoch() vaut ${epoch} au deploiement, attendu 0`,
        );
      });

      it("currentEpoch() vaut encore 0 une seconde apres le deploiement", async function () {
        // Le compteur ne bouge pas a la premiere seconde ecoulee : sans ce
        // cas, un contrat qui rendrait `block.timestamp - GENESIS` sans
        // diviser passerait le test precedent (0 - 0 = 0) et echouerait
        // seulement beaucoup plus loin.
        // Calcul a la main : (GENESIS + 1 - GENESIS) / 14400 = 1 / 14400 = 0.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + 1n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          0n,
          `currentEpoch() vaut ${epoch} a GENESIS + 1, attendu 0`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] La frontiere du premier basculement
  //
  // Le coeur du fichier. La fonction est une division entiere : partout
  // ailleurs dans une epoque, elle ne peut se tromper que si elle est
  // grossierement fausse, et le premier test venu le verrait. C'est a la
  // SECONDE du basculement qu'une erreur d'un cran (un < au lieu d'un <=, un
  // GENESIS decale d'une unite) devient visible, et nulle part ailleurs.
  //
  // Les deux `it` de la section A se lisent donc ensemble : chacun seul
  // prouve une valeur, la paire situe la frontiere.
  // ---------------------------------------------------------------------------

  describe("II] La frontiere du premier basculement", function () {
    describe("A) La derniere seconde de l'epoque 0 et la premiere de l'epoque 1", function () {
      it("a GENESIS + EPOCH_DURATION - 1, currentEpoch() vaut encore 0", async function () {
        // Calcul a la main : (GENESIS + 14399 - GENESIS) / 14400
        //                  = 14399 / 14400 = 0 (division entiere).
        // C'est la toute derniere seconde du premier mandat.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + EPOCH_DURATION - 1n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          0n,
          `currentEpoch() vaut ${epoch} a GENESIS + EPOCH_DURATION - 1, attendu 0 (derniere seconde de l'epoque 0)`,
        );
      });

      it("a GENESIS + EPOCH_DURATION, currentEpoch() vaut 1", async function () {
        // Calcul a la main : (GENESIS + 14400 - GENESIS) / 14400
        //                  = 14400 / 14400 = 1.
        // Une seconde plus tard que le cas precedent, et le mandat a change
        // de main. La borne est donc INCLUSIVE cote epoque suivante : une
        // epoque dure EPOCH_DURATION secondes pleines, de son premier
        // instant inclus au premier instant de la suivante exclu.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + EPOCH_DURATION);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          1n,
          `currentEpoch() vaut ${epoch} a GENESIS + EPOCH_DURATION, attendu 1 (premiere seconde de l'epoque 1)`,
        );
      });
    });

    describe("B) Les frontieres suivantes sont espacees d'exactement EPOCH_DURATION", function () {
      it("a GENESIS + 2 * EPOCH_DURATION - 1, currentEpoch() vaut encore 1", async function () {
        // Calcul a la main : (28800 - 1) / 14400 = 28799 / 14400 = 1.
        // Le second basculement se comporte comme le premier : ce n'est pas
        // GENESIS qui est un cas particulier, c'est la formule qui est
        // uniforme.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + 2n * EPOCH_DURATION - 1n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          1n,
          `currentEpoch() vaut ${epoch} a GENESIS + 2 * EPOCH_DURATION - 1, attendu 1`,
        );
      });

      it("a GENESIS + 2 * EPOCH_DURATION, currentEpoch() vaut 2", async function () {
        // Calcul a la main : 28800 / 14400 = 2.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + 2n * EPOCH_DURATION);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          2n,
          `currentEpoch() vaut ${epoch} a GENESIS + 2 * EPOCH_DURATION, attendu 2`,
        );
      });
    });

    describe("C) Une epoque quelconque, loin du premier basculement", function () {
      it("au milieu de l'epoque 7, currentEpoch() vaut 7", async function () {
        // Un point PRIS AU MILIEU, pas sur une frontiere : ce que ce cas
        // ajoute aux quatre precedents est que la division tient encore
        // apres plusieurs tours de compteur, et pas seulement autour de
        // l'origine.
        // Calcul a la main : GENESIS + 7 * 14400 + 7200 = GENESIS + 108000,
        //   108000 / 14400 = 7,5 -> 7 en division entiere.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + FAR_EPOCH * EPOCH_DURATION + EPOCH_DURATION / 2n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          FAR_EPOCH,
          `currentEpoch() vaut ${epoch} au milieu de l'epoque ${FAR_EPOCH}, attendu ${FAR_EPOCH}`,
        );
      });

      it("a la derniere seconde de l'epoque 7, currentEpoch() vaut encore 7", async function () {
        // Calcul a la main : GENESIS + 8 * 14400 - 1 = GENESIS + 115199,
        //   115199 / 14400 = 7 (division entiere).
        // Meme frontiere que la section A, mais huit epoques plus loin :
        // l'ecart entre deux basculements ne derive pas.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + (FAR_EPOCH + 1n) * EPOCH_DURATION - 1n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          FAR_EPOCH,
          `currentEpoch() vaut ${epoch} a la derniere seconde de l'epoque ${FAR_EPOCH}, attendu ${FAR_EPOCH}`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Proprietes de l'horloge
  //
  // Cette section ne teste plus une valeur mais ce que la formule garantit
  // quelle que soit la date : la monotonie, l'independance vis-a-vis de
  // l'etat du pool, et l'absence d'effet de bord.
  // ---------------------------------------------------------------------------

  describe("III] Proprietes de l'horloge", function () {
    describe("A) La lecture est monotone", function () {
      it("quatre lectures separees par des sauts de temps ne decroissent jamais", async function () {
        // block.timestamp ne recule jamais et GENESIS est immuable : le
        // numerateur est donc croissant, et la division entiere par une
        // constante strictement positive preserve cet ordre. C'est ce qui
        // permettra au bot d'enchere de comparer deux lectures sans jamais
        // avoir a se demander si la seconde est "avant" la premiere.
        // Sauts choisis inegaux (une demi-epoque, une seconde, trois
        // epoques) pour que la propriete ne tienne pas au pas choisi.
        // Calcul a la main, valeurs successives attendues :
        //   GENESIS                      -> 0
        //   + 7200                       -> 0   (7200 / 14400)
        //   + 7201                       -> 0   (7201 / 14400)
        //   + 7201 + 43200 = 50401       -> 3   (50401 / 14400 = 3,5)
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const offsets = [0n, EPOCH_DURATION / 2n, EPOCH_DURATION / 2n + 1n, EPOCH_DURATION / 2n + 1n + 3n * EPOCH_DURATION];

        const readings: bigint[] = [];
        for (const offset of offsets) {
          if (offset > 0n) {
            await warpTo(genesis + offset);
          }
          readings.push(await pool.read.currentEpoch());
        }

        const decreasing = readings.findIndex(
          (value, index) => index > 0 && value < readings[index - 1]!,
        );
        assert.equal(
          decreasing,
          -1,
          `lectures successives=[${readings}] : la lecture d'indice ${decreasing} decroit par rapport a la precedente`,
        );
      });

      it("deux lectures dans le MEME bloc rendent la meme valeur", async function () {
        // Corollaire de la monotonie, et propriete a part entiere : sans
        // transaction entre les deux, block.timestamp est identique, donc la
        // valeur l'est aussi. C'est ce qui autorise un front a lire
        // currentEpoch() plusieurs fois pour composer un affichage sans
        // risquer de melanger deux mandats.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + 3n * EPOCH_DURATION);

        const first = await pool.read.currentEpoch();
        const second = await pool.read.currentEpoch();
        assert.equal(
          second,
          first,
          `deux lectures du meme bloc rendent ${first} puis ${second}, attendu deux fois la meme valeur`,
        );
      });
    });

    describe("B) L'horloge ne s'arrete pas quand le pool est en pause", function () {
      it("le compteur avance pendant la pause, exactement comme sans elle", async function () {
        // RISQUE ASSUME ET DOCUMENTE DU PROTOCOLE, pas un defaut.
        //
        // currentEpoch() ne lit que block.timestamp, GENESIS et
        // EPOCH_DURATION (Pool.sol:92-94). Aucun de ces trois ne connait
        // Pausable : le decoupage en mandats continue donc de defiler pendant
        // une pause. Consequence a connaitre : un gestionnaire qui a remporte
        // l'enchere voit son mandat s'ecouler sans pouvoir agir si l'owner
        // met la pool en pause, et il ne recupere pas le temps perdu.
        //
        // Le choix inverse (geler le compteur pendant la pause) couterait
        // beaucoup plus cher qu'il ne rapporte : il faudrait stocker le
        // cumul de temps pause, donc une ecriture a chaque bascule, et
        // currentEpoch() cesserait d'etre derivable hors chaine par un simple
        // calcul sur GENESIS. Ce test fige donc le comportement voulu, il ne
        // signale pas un bug a corriger.
        //
        // Calcul a la main : la pause est posee bien avant la premiere
        // frontiere, puis le temps saute a GENESIS + 3 * 14400 = +43200,
        //   43200 / 14400 = 3.
        const { pool, genesis } = await networkHelpers.loadFixture(deploySeededPausedPoolFixture);

        const pausedBefore = await pool.read.paused();
        assert.equal(pausedBefore, true, `la fixture devrait partir en pause, paused() vaut ${pausedBefore}`);

        await warpTo(genesis + 3n * EPOCH_DURATION);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          3n,
          `currentEpoch() vaut ${epoch} apres trois epoques passees EN PAUSE, attendu 3 : l'horloge ne se gele pas`,
        );
      });

      it("la pause ne decale pas non plus la frontiere : a GENESIS + EPOCH_DURATION - 1 le compteur vaut encore 0", async function () {
        // Second angle du meme risque. Le test precedent montre que le
        // compteur avance ; celui-ci montre qu'il avance AUX MEMES
        // INSTANTS. Un contrat qui aurait tente de compenser la pause,
        // meme partiellement, decalerait cette frontiere-la, et la seule
        // assertion "le compteur a bouge" ne le verrait pas.
        // Calcul a la main : 14399 / 14400 = 0, identique au cas hors pause
        // de la section II.A.
        const { pool, genesis } = await networkHelpers.loadFixture(deploySeededPausedPoolFixture);

        await warpTo(genesis + EPOCH_DURATION - 1n);

        const epoch = await pool.read.currentEpoch();
        assert.equal(
          epoch,
          0n,
          `currentEpoch() vaut ${epoch} a GENESIS + EPOCH_DURATION - 1 en pause, attendu 0 (meme frontiere que hors pause)`,
        );
      });
    });

    describe("C) La lecture n'a aucun effet de bord", function () {
      it("appeler currentEpoch() ne deplace aucune valeur lisible du contrat", async function () {
        // currentEpoch() est declaree `view` (Pool.sol:92), donc le
        // compilateur interdit deja l'ecriture. Ce que ce test ajoute est
        // l'observation depuis l'exterieur, la seule que le front puisse
        // faire : sur un pool amorce, donc avec un etat non trivial a
        // deplacer, les quatre valeurs mutables du contrat sont identiques
        // avant et apres plusieurs lectures.
        //
        // La lecture ne passe d'ailleurs par aucune transaction : viem
        // l'envoie en eth_call, ce qui est precisement le point. Une
        // fonction qui aurait perdu son `view` exigerait une transaction et
        // consommerait du gas a chaque consultation du mandat courant, et le
        // bot d'enchere paierait pour lire l'heure.
        const { pool, genesis } = await networkHelpers.loadFixture(deploySeededPausedPoolFixture);

        const before = await readMutableState(pool);

        await pool.read.currentEpoch();
        await warpTo(genesis + 5n * EPOCH_DURATION);
        await pool.read.currentEpoch();

        const after = await readMutableState(pool);
        assert.deepEqual(
          after,
          before,
          `etat apres lectures=${JSON.stringify(after, (_key, value) => typeof value === "bigint" ? value.toString() : value)}, attendu identique a avant=${JSON.stringify(before, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`,
        );
      });

      it("le compteur n'est pas stocke : il se derive de GENESIS et EPOCH_DURATION, tous deux inchanges", async function () {
        // Le pendant du test precedent, vu depuis les entrees de la formule
        // plutot que depuis l'etat mutable. Si l'epoque etait stockee
        // quelque part, avancer de cinq epoques devrait deplacer quelque
        // chose ; ici les deux seuls termes qui ne sont pas block.timestamp
        // sont immuables et le restent, et c'est ce qui rend le compteur
        // recalculable hors chaine sans jamais interroger le contrat.
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + 5n * EPOCH_DURATION);
        await pool.read.currentEpoch();

        const genesisAfter = await pool.read.GENESIS();
        const epochDurationAfter = await pool.read.EPOCH_DURATION();
        assert.deepEqual(
          [genesisAfter, epochDurationAfter],
          [genesis, EPOCH_DURATION],
          `[GENESIS, EPOCH_DURATION] valent [${genesisAfter}, ${epochDurationAfter}] cinq epoques plus tard, attendu [${genesis}, ${EPOCH_DURATION}]`,
        );
      });
    });
  });
});
