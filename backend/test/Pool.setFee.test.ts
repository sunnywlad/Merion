// Suite fonctionnelle TypeScript pour Pool.setFee(), le seul levier du
// gestionnaire du mandat courant.
//
// Pourquoi un fichier a part : setFee n'appartient a aucune des suites
// existantes. Ce n'est pas une fonction de l'AMM — elle ne deplace aucun
// token, n'emet ni Swapped ni AddedLiquidity, et n'a rien a faire dans
// Pool.swap.test.ts. Ce n'est pas non plus une fonction de nomination : la
// suite manager couvre QUI devient gestionnaire, celle-ci couvre CE QU'IL
// PEUT FAIRE une fois qu'il l'est. Et ce n'est pas la lecture du frais, qui
// vit dans Pool.feeInForce.{test.ts,t.sol}. Ce qui se dit ici, et nulle part
// ailleurs, tient en une phrase : "le gestionnaire du mandat courant fixe le
// tarif de son epoch, une fois, au debut de son mandat, dans une bande deux
// fois plus etroite que le plafond du protocole".
//
// Pourquoi TypeScript/viem plutot que Solidity ici : les quatre gardes de
// setFee (Pool.sol:153-170) portent sur QUI appelle, QUAND il appelle et AVEC
// QUOI, et les trois se lisent depuis l'exterieur. Le bot d'enchere enverra
// cette transaction depuis un compte reel, quelques secondes apres le
// basculement d'epoch, et le front relira feeInForce() par eth_call juste
// apres. C'est ce parcours-la, avec ses comptes distincts (l'owner du
// deploiement, le gestionnaire du mandat, le gestionnaire d'un AUTRE mandat,
// un tiers quelconque) et son horloge posee a la seconde, que cette suite
// interroge. La question "pour n'importe quelle entree" appartient au fuzz de
// test/Pool.setFee.t.sol.
//
// Perimetre. La suite se sert de feeInForce() comme OBSERVABLE — c'est la
// seule lecture qui dise ce que le protocole facture — mais ne la re-teste
// pas : elle a son propre fichier. Elle ne teste pas non plus setManager,
// setAuction ni manager() pour eux-memes (Pool.manager.test.ts), ni le
// constructeur, ni la pause, ni l'AMM. Elle ne dit rien du chemin de frais de
// swap : swap lit aujourd'hui le feeNum BRUT et non feeInForce()
// (Pool.sol:249), divergence connue dont la resolution appartient a une etape
// ulterieure du build, et qu'aucun test de ce fichier n'epingle dans un sens
// ou dans l'autre.
//
// Voir test/README.md pour la demarche complete et la liste des cas limites
// groupee par fonction.

import { getAddress, zeroAddress } from "viem";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const NOMINAL_FEE_NUM = 5n; // _nominalFeeNum, cf. PoolTestBase.sol
const MIN_FEE_NUM = 1n; // _minFeeNum, cf. PoolTestBase.sol
const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n; // cf. build-auction.md 5.0 bis
const MAX_FEE_NUM = 50n; // constante du contrat, Pool.sol:35
const UNBALANCE_FACTOR = 2n; // constante du contrat, Pool.sol:38

// Le plafond du GESTIONNAIRE, derive comme setFee le derive (Pool.sol:166).
// Il vaut 25, la moitie de MAX_FEE_NUM : personne ne paie jamais plus de
// 0,50 %, et le gestionnaire ecrit une base entre 0,01 % et 0,25 %. La bande
// du gestionnaire est donc [1, 25], et MAX_FEE_NUM lui-meme en est EXCLU.
const MAX_MANAGER_FEE_NUM = MAX_FEE_NUM / UNBALANCE_FACTOR;

// Le tarif pose par les tests nominaux. Choisi dans la bande, different de
// NOMINAL_FEE_NUM et different des deux bornes : sans cet ecart au nominal,
// feeInForce() rendrait la meme valeur par les deux branches de son ternaire
// et n'etablirait rien.
const MANDATE_FEE_NUM = 20n;

// Le second tarif, pour les scenarios a deux mandats successifs. Lui aussi
// dans la bande, et distinct du precedent comme du nominal.
const SECOND_MANDATE_FEE_NUM = 7n;

// L'adresse nulle, valeur rendue par manager() quand aucun gestionnaire n'est
// nomme pour l'epoch courante.
const ZERO_ADDRESS = zeroAddress;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.manager.test.ts et Pool.pause.test.ts, deliberement.
// Ce fichier ouvre sa propre connexion reseau via network.create() : la
// partager reviendrait a partager l'etat blockchain et le cache de
// loadFixture entre des suites qui doivent pouvoir tourner, echouer et
// evoluer separement (voir test/README.md).
// ---------------------------------------------------------------------------

// Quatre roles, et ils comptent tous les quatre :
//   deployer     — owner du pool, celui qui nomme tant que `auction` est nulle,
//                  et qui n'a AUCUN pouvoir sur le tarif ;
//   manager      — le gestionnaire de l'epoch 1 dans la plupart des scenarios ;
//   otherManager — le gestionnaire d'un AUTRE mandat, pour montrer que la
//                  garde lit managerOf[currentEpoch()] et pas le mapping ;
//   thirdParty   — un tiers quelconque, jamais nomme nulle part.
async function deployTokensAndPoolFixture() {
  const [deployer, manager, otherManager, thirdParty, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const mrn = await viem.deployContract("MRN", []);

  // Le dernier argument du constructeur est le _owner (Ownable(_owner)) :
  // `deployer` est donc l'owner dans toute cette suite. Le 7e argument, juste
  // avant _owner, est l'adresse MRN que le Pool utilise pour verser le loyer
  // LP (I.4).
  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    treasury.account.address,
    mrn.address,
    deployer.account.address,
  ]);

  const publicClient = await viem.getPublicClient();
  const deploymentBlock = await publicClient.getBlock();
  const genesis = deploymentBlock.timestamp;

  return { deployer, manager, otherManager, thirdParty, wbtc, cbbtc, lbtc, mrn, pool, genesis };
}

// Le premier instant de l'epoch `epoch`, en secondes absolues. GENESIS est le
// timestamp du bloc de deploiement, et currentEpoch() vaut
// (block.timestamp - GENESIS) / EPOCH_DURATION.
function epochStart(genesis: bigint, epoch: bigint) {
  return genesis + epoch * EPOCH_DURATION;
}

// Place la PROCHAINE transaction a l'instant `timestamp`, sans miner de bloc.
//
// setNextBlockTimestamp et non time.increase : la fenetre de priorite vaut
// DOUZE secondes, et un delta relatif deriverait de la seconde consommee par
// chaque transaction precedente du test (le setManager, notamment). C'est le
// piege numero un de cette suite : un `increase(EPOCH_DURATION)` place la
// transaction a l'offset 1 ou 2 de l'epoch suivante, ce qui passe encore
// aujourd'hui, et cesserait de passer au moindre appel supplementaire en
// amont.
async function callAt(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
}

// Avance l'horloge jusqu'a `timestamp` en minant un bloc VIDE. Sert aux
// lectures pures : personne n'a paye de transaction pour changer d'epoch.
async function warpTo(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
  await networkHelpers.mine();
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Le scenario nominal, monte une fois et reutilise par toute la section I :
// l'owner nomme `manager` pour l'epoch 1, puis l'horloge est posee sur la
// premiere seconde de ce mandat (offset 0, strictement sous PRIORITY_WINDOW)
// et le gestionnaire ecrit son tarif.
async function runNominalMandate(fixture: PoolFixture, feeNum: bigint = MANDATE_FEE_NUM) {
  const { pool, manager, genesis } = fixture;

  await pool.write.setManager([1n, manager.account.address]);
  await callAt(epochStart(genesis, 1n));
  await pool.write.setFee([feeNum], { account: manager.account });
}

describe("Pool.setFee", async function () {

  // ---------------------------------------------------------------------------
  // I] Le chemin nominal
  //
  // Un seul parcours, decoupe en quatre observables independants : le champ
  // brut, l'estampille d'epoch, la vue que le front lira, et l'evenement que
  // l'indexeur lira. Les trois premiers sont trois lectures distinctes du meme
  // effet, et aucun ne remplace les deux autres — un setFee qui ecrirait
  // feeNum sans estampiller lastSetFeeEpoch passerait le premier et echouerait
  // le deuxieme, et le tarif pose serait invisible pour feeInForce().
  // ---------------------------------------------------------------------------

  describe("I] Le chemin nominal", function () {

    describe("A) Le tarif pose par le gestionnaire du mandat courant", function () {

      it("feeNum prend la valeur ecrite par le gestionnaire", async function () {
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await runNominalMandate(fixture);

        const feeNum = BigInt(await fixture.pool.read.feeNum());
        assert.equal(
          feeNum,
          MANDATE_FEE_NUM,
          `feeNum vaut ${feeNum} apres setFee(${MANDATE_FEE_NUM}) a l'epoch 1, attendu ${MANDATE_FEE_NUM}`,
        );
      });

      it("lastSetFeeEpoch prend l'epoch du mandat", async function () {
        // L'estampille est ce qui rend le tarif VISIBLE : feeInForce()
        // (Pool.sol:137) ne rend feeNum que si lastSetFeeEpoch vaut l'epoch
        // courante. Sans elle, l'ecriture du champ brut ne servirait a rien.
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await runNominalMandate(fixture);

        const lastSetFeeEpoch = BigInt(await fixture.pool.read.lastSetFeeEpoch());
        assert.equal(
          lastSetFeeEpoch,
          1n,
          `lastSetFeeEpoch vaut ${lastSetFeeEpoch} apres un setFee a l'epoch 1, attendu 1`,
        );
      });

      it("feeInForce() rend la nouvelle base pendant le mandat", async function () {
        // La lecture que le front et le bot feront. MANDATE_FEE_NUM est
        // different de NOMINAL_FEE_NUM, donc cette assertion distingue
        // reellement les deux branches du ternaire de feeInForce().
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await runNominalMandate(fixture);

        const feeInForce = await fixture.pool.read.feeInForce();
        assert.equal(
          feeInForce,
          MANDATE_FEE_NUM,
          `feeInForce() vaut ${feeInForce} pendant le mandat de l'epoch 1, attendu ${MANDATE_FEE_NUM} (et non le nominal ${NOMINAL_FEE_NUM})`,
        );
      });
    });

    describe("B) L'evenement FeeSet", function () {

      it("FeeSet porte (epoch, gestionnaire, ancien feeNum, nouveau feeNum)", async function () {
        // Les deux premiers arguments sont INDEXES (Pool.sol:76), donc
        // presents dans les topics du receipt ; les deux montants sont dans la
        // data. emitWithArgs decode les uns et les autres depuis l'ABI et
        // verifie qu'exactement un FeeSet est emis, dans l'ordre de la
        // signature.
        //
        // Le troisieme argument est l'ANCIEN feeNum, lu juste avant
        // l'ecriture. Sur ce premier mandat il vaut NOMINAL_FEE_NUM, pose par
        // le constructeur (Pool.sol:103) : c'est bien la valeur observee, pas
        // une supposition — le test suivant montre qu'elle n'est pas toujours
        // le nominal.
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const { pool, manager, genesis } = fixture;

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.emitWithArgs(
          pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "FeeSet",
          [1n, getAddress(manager.account.address), NOMINAL_FEE_NUM, MANDATE_FEE_NUM],
        );
      });

      it("l'ancien feeNum de FeeSet est le champ BRUT, perime, pas le frais en vigueur", async function () {
        // A CONNAITRE, et c'est pour ca que ce test existe. Au second mandat,
        // le pool facture NOMINAL_FEE_NUM (5) : le tarif de l'epoch 1 est
        // perime, feeInForce() l'a deja abandonne. Mais le champ BRUT feeNum
        // porte toujours 20, aucune ecriture ne l'ayant remis a zero au
        // passage d'epoch — c'est le reset paresseux.
        //
        // FeeSet emet ce champ brut (Pool.sol:172). Son troisieme argument
        // vaut donc 20, et NON 5 : l'evenement annonce "l'ancien tarif etait
        // 20" alors que le protocole facturait 5 a la seconde precedente. Un
        // indexeur qui reconstruirait l'historique des frais a partir de cet
        // argument se tromperait. Le test fige le comportement reel plutot que
        // le comportement souhaitable ; l'ecart est remonte, pas corrige.
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const { pool, manager, genesis } = fixture;

        await pool.write.setManager([1n, manager.account.address]);
        await pool.write.setManager([2n, manager.account.address]);

        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 2n));

        await viem.assertions.emitWithArgs(
          pool.write.setFee([SECOND_MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "FeeSet",
          [2n, getAddress(manager.account.address), MANDATE_FEE_NUM, SECOND_MANDATE_FEE_NUM],
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] Les quatre gardes, une par une
  //
  // Les quatre gardes de Pool.sol:153-170, dans l'ordre ou elles sont ecrites.
  // Chaque sous-section eprouve UNE garde en laissant les trois autres
  // satisfaites : c'est ce qui rend chaque test capable d'echouer pour la
  // bonne raison si la garde visee disparaissait. L'ordre RELATIF des gardes,
  // lui, est le sujet de la section III.
  // ---------------------------------------------------------------------------

  describe("II] Les quatre gardes", function () {

    describe("A) NotManager — l'appelant n'est pas le gestionnaire du mandat courant", function () {

      it("l'owner du pool est refuse", async function () {
        // Le fait le plus contre-intuitif de la fonction, et celui qui a
        // change avec ce commit : setFee n'est PLUS un pouvoir de l'owner.
        // Celui qui deploie, qui met en pause et qui nomme les gestionnaires
        // n'a aucun droit sur le tarif, sauf a etre lui-meme le gestionnaire
        // du mandat courant.
        const { pool, deployer, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: deployer.account }),
          pool,
          "NotManager",
        );
      });

      it("un tiers quelconque est refuse", async function () {
        const { pool, manager, thirdParty, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: thirdParty.account }),
          pool,
          "NotManager",
        );
      });

      it("le gestionnaire d'un AUTRE mandat est refuse pendant celui-ci", async function () {
        // Le cas qui distingue "gestionnaire" de "gestionnaire DU MANDAT
        // COURANT". otherManager est reellement inscrit dans managerOf, pour
        // l'epoch 2 ; il appelle pendant l'epoch 1. La garde compare a
        // manager(), c'est-a-dire managerOf[currentEpoch()] (Pool.sol:119),
        // pas a "figure quelque part dans le mapping". Une garde ecrite de
        // travers passerait les deux tests precedents et echouerait ici.
        const { pool, manager, otherManager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await pool.write.setManager([2n, otherManager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: otherManager.account }),
          pool,
          "NotManager",
        );
      });
    });

    describe("B) OutsidePriorityWindow — la fenetre est fermee", function () {

      it("a l'offset PRIORITY_WINDOW - 1 l'appel passe", async function () {
        // La DERNIERE seconde ouverte. Avec l'offset PRIORITY_WINDOW du test
        // suivant, c'est la paire qui epingle la frontiere : un `<=` a la
        // place du `<` de Pool.sol:154 passerait celui-ci et echouerait
        // l'autre, et une fenetre d'une seconde de moins ferait l'inverse.
        //
        // L'assertion porte sur feeNum relu, pas sur la seule absence de
        // revert.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n) + PRIORITY_WINDOW - 1n);
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          MANDATE_FEE_NUM,
          `feeNum vaut ${feeNum} apres un setFee a l'offset ${PRIORITY_WINDOW - 1n} de l'epoch 1, attendu ${MANDATE_FEE_NUM} (derniere seconde ouverte)`,
        );
      });

      it("a l'offset PRIORITY_WINDOW l'appel reverte", async function () {
        // Une seconde plus tard, et rien d'autre n'a change. La borne est
        // exclusive : douze secondes ouvertes, de l'offset 0 a l'offset 11.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n) + PRIORITY_WINDOW);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "OutsidePriorityWindow",
        );
      });

      it("au milieu de l'epoch l'appel reverte", async function () {
        // Le cas grossier, tres loin de la frontiere : passe ce creneau, le
        // tarif de l'epoch est fige pour tout le monde, gestionnaire compris.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n) + EPOCH_DURATION / 2n);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "OutsidePriorityWindow",
        );
      });
    });

    describe("C) FeeAlreadySetThisEpoch — une seule ecriture par mandat", function () {

      it("un second setFee dans la meme fenetre reverte", async function () {
        // Le droit est CONSOMMABLE : une fois pose, le tarif de l'epoch ne se
        // corrige plus, meme s'il reste des secondes de fenetre. Les deux
        // appels sont places explicitement, offsets 0 et 1, tous deux
        // strictement sous PRIORITY_WINDOW — sans quoi le second reverterait
        // sur OutsidePriorityWindow et le test passerait pour la mauvaise
        // raison.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 1n) + 1n);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([SECOND_MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "FeeAlreadySetThisEpoch",
        );
      });

      it("le premier tarif tient apres le revert du second", async function () {
        // La contrepartie du precedent : la garde ne se contente pas de
        // sortir, elle protege la valeur deja posee. Sans cette relecture, un
        // setFee qui ecrirait AVANT de sortir passerait le test ci-dessus.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 1n) + 1n);
        await viem.assertions.revertWithCustomError(
          pool.write.setFee([SECOND_MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "FeeAlreadySetThisEpoch",
        );

        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          MANDATE_FEE_NUM,
          `feeNum vaut ${feeNum} apres le revert du second setFee, attendu ${MANDATE_FEE_NUM} (le premier tarif tient)`,
        );
      });

      it("le meme gestionnaire, reelu, peut rappeler setFee au mandat suivant", async function () {
        // La garde borne le droit a UN MANDAT, pas a une adresse ni a la vie
        // du contrat : lastSetFeeEpoch != currentEpoch() (Pool.sol:162)
        // redevient vraie des que l'epoch tourne. Le meme compte, reelu pour
        // l'epoch 2, ecrit un second tarif dans la fenetre de ce nouveau
        // mandat.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await pool.write.setManager([2n, manager.account.address]);

        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 2n));
        await pool.write.setFee([SECOND_MANDATE_FEE_NUM], { account: manager.account });

        const feeInForce = await pool.read.feeInForce();
        assert.equal(
          feeInForce,
          SECOND_MANDATE_FEE_NUM,
          `feeInForce() vaut ${feeInForce} apres le second mandat, attendu ${SECOND_MANDATE_FEE_NUM} (le droit se rouvre a chaque epoch)`,
        );
      });
    });

    describe("D) FeeOutOfBand — la bande du gestionnaire est [MIN_FEE_NUM, MAX_FEE_NUM / UNBALANCE_FACTOR]", function () {

      it("MIN_FEE_NUM - 1, soit 0, reverte avec les deux bornes annoncees", async function () {
        // La borne basse. Un pool a frais nuls est un choix du CONSTRUCTEUR
        // (Pool.constructor.test.ts IV.A), jamais une decision de
        // gestionnaire. Les DEUX arguments de l'erreur sont verifies : c'est
        // la seule erreur de setFee a en porter, precisement parce que
        // l'appelant ne peut pas deriver la bande sans lire deux constantes.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.setFee([MIN_FEE_NUM - 1n], { account: manager.account }),
          pool,
          "FeeOutOfBand",
          [MIN_FEE_NUM, MAX_MANAGER_FEE_NUM],
        );
      });

      it("MAX_FEE_NUM / UNBALANCE_FACTOR + 1, soit 26, reverte avec les deux bornes annoncees", async function () {
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.setFee([MAX_MANAGER_FEE_NUM + 1n], { account: manager.account }),
          pool,
          "FeeOutOfBand",
          [MIN_FEE_NUM, MAX_MANAGER_FEE_NUM],
        );
      });

      it("MAX_FEE_NUM lui-meme, soit 50, reverte : le plafond du gestionnaire est le plafond DIVISE", async function () {
        // LE test de cette sous-section, et le point de soutenance. Deux
        // plafonds coexistent dans le contrat et ne disent pas la meme chose :
        // MAX_FEE_NUM (50) borne ce qu'un PRENEUR peut payer, et le
        // constructeur s'en sert pour valider _nominalFeeNum et _minFeeNum
        // (Pool.sol:94-95) ; MAX_FEE_NUM / UNBALANCE_FACTOR (25) borne ce
        // qu'un GESTIONNAIRE peut ecrire. Un setFee qui aurait borne sur le
        // premier passerait tous les autres tests de ce fichier et laisserait
        // le gestionnaire doubler le frais maximal du protocole.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));

        await viem.assertions.revertWithCustomErrorWithArgs(
          pool.write.setFee([MAX_FEE_NUM], { account: manager.account }),
          pool,
          "FeeOutOfBand",
          [MIN_FEE_NUM, MAX_MANAGER_FEE_NUM],
        );
      });

      it("la borne basse MIN_FEE_NUM passe", async function () {
        // Bornes INCLUSIVES des deux cotes (Pool.sol:168, deux comparaisons
        // larges). Avec le test de MIN_FEE_NUM - 1 ci-dessus, la paire fige la
        // frontiere basse a l'unite pres.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MIN_FEE_NUM], { account: manager.account });

        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          MIN_FEE_NUM,
          `feeNum vaut ${feeNum} apres setFee(${MIN_FEE_NUM}), attendu ${MIN_FEE_NUM} (borne basse incluse)`,
        );
      });

      it("la borne haute MAX_FEE_NUM / UNBALANCE_FACTOR passe", async function () {
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MAX_MANAGER_FEE_NUM], { account: manager.account });

        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          MAX_MANAGER_FEE_NUM,
          `feeNum vaut ${feeNum} apres setFee(${MAX_MANAGER_FEE_NUM}), attendu ${MAX_MANAGER_FEE_NUM} (borne haute incluse)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] L'ordre des gardes est celui qui est ecrit
  //
  // Les quatre gardes s'evaluent en sequence, et l'ordre n'est pas une
  // commodite de redaction : c'est LUI qui rend correcte la garde d'unicite au
  // mandat 0 (voir la section IV et le commentaire de Pool.sol:155-161). Trois
  // cas, chacun construit pour violer DEUX gardes a la fois, et chacun
  // demandant quelle erreur parle. Le matcher nomme l'erreur attendue : un
  // contrat qui inverserait deux gardes echouerait ici, et nulle part ailleurs
  // dans le fichier.
  // ---------------------------------------------------------------------------

  describe("III] L'ordre des gardes", function () {

    describe("A) L'acces passe avant la fenetre", function () {

      it("l'owner appelle hors fenetre : NotManager, et non OutsidePriorityWindow", async function () {
        // Le cas de soutenance. Deux gardes sont violees : l'appelant n'est
        // pas le gestionnaire, ET la fenetre est fermee. C'est la premiere qui
        // parle.
        //
        // Ce que ca etablit va plus loin que l'ordre : au mandat 0,
        // lastSetFeeEpoch vaut 0 et currentEpoch() vaut 0, donc la garde
        // d'unicite serait FAUSSE d'emblee et laisserait passer une ecriture.
        // Elle ne le fait pas, parce que la garde d'acces referme avant — et
        // c'est ce test-ci qui montre que la garde d'acces est bien la
        // premiere. L'amorcage est ferme par du code, pas par une coincidence
        // de valeurs.
        const { pool, deployer, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n) + EPOCH_DURATION / 2n);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: deployer.account }),
          pool,
          "NotManager",
        );
      });
    });

    describe("B) La fenetre passe avant l'unicite", function () {

      it("le gestionnaire rappelle setFee hors fenetre : OutsidePriorityWindow, et non FeeAlreadySetThisEpoch", async function () {
        // Le gestionnaire a deja pose son tarif a l'offset 0, donc la garde
        // d'unicite est violee ; il rappelle au milieu de l'epoch, donc la
        // fenetre l'est aussi. C'est la fenetre qui sort, parce qu'elle est
        // evaluee avant (Pool.sol:154 puis 162).
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 1n) + EPOCH_DURATION / 2n);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([SECOND_MANDATE_FEE_NUM], { account: manager.account }),
          pool,
          "OutsidePriorityWindow",
        );
      });
    });

    describe("C) L'unicite passe avant la bande", function () {

      it("le gestionnaire rappelle setFee dans la fenetre avec une valeur hors bande : FeeAlreadySetThisEpoch, et non FeeOutOfBand", async function () {
        // Deux gardes violees, la troisieme et la quatrieme. Celle qui parle
        // est la troisieme : le droit est deja consomme, et le contrat n'a
        // meme pas a regarder l'argument.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await callAt(epochStart(genesis, 1n) + 1n);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MAX_FEE_NUM], { account: manager.account }),
          pool,
          "FeeAlreadySetThisEpoch",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // IV] Le mandat 0 n'a pas de tarif, et ne peut pas en avoir
  //
  // Consequence STRUCTURELLE de setManager, pas d'une garde de setFee : la
  // nomination exige `_epoch > currentEpoch()` (Pool.sol:129), un strict, et
  // currentEpoch() vaut deja 0 au bloc de deploiement. Aucune transaction, a
  // aucun instant, ne peut donc poser managerOf[0]. Le pool traverse sa
  // premiere epoch au tarif nominal du constructeur, et c'est irrattrapable
  // par conception.
  //
  // Les trois tests ci-dessous etablissent la chaine par les faits, maillon
  // par maillon, plutot que de la deduire du code : la nomination est refusee,
  // donc manager() rend l'adresse nulle, donc setFee est ferme a tout le
  // monde. Le troisieme maillon est teste depuis deux comptes, l'owner et un
  // tiers, parce que "quel que soit l'appelant" n'a de valeur que si au moins
  // le compte le plus privilegie du contrat est du lot.
  // ---------------------------------------------------------------------------

  describe("IV] Le mandat 0", function () {

    describe("A) La nomination y est impossible", function () {

      it("setManager(0, X) reverte : EpochAlreadyStarted", async function () {
        const { pool, manager } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([0n, manager.account.address]),
          pool,
          "EpochAlreadyStarted",
        );
      });

      it("manager() rend l'adresse nulle pendant l'epoch 0", async function () {
        // Le maillon intermediaire. Le pool est laisse dans son etat de
        // deploiement, ou currentEpoch() vaut 0, et managerOf[0] n'a jamais pu
        // etre ecrit.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const currentManager = await pool.read.manager();
        assert.equal(
          currentManager,
          ZERO_ADDRESS,
          `manager() vaut ${currentManager} pendant l'epoch 0, attendu ${ZERO_ADDRESS} (managerOf[0] inatteignable)`,
        );
      });
    });

    describe("B) Le tarif y est donc ferme a tout le monde", function () {

      it("l'owner appelle setFee pendant l'epoch 0 : NotManager", async function () {
        // L'offset dans l'epoch vaut 1 ou 2 secondes seulement — la fenetre
        // est donc GRANDE OUVERTE, et la garde d'unicite serait fausse (0 ==
        // 0). Seule la garde d'acces ferme le passage, et c'est exactement ce
        // que ce test montre.
        const { pool, deployer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: deployer.account }),
          pool,
          "NotManager",
        );
      });

      it("un tiers appelle setFee pendant l'epoch 0 : NotManager", async function () {
        const { pool, thirdParty } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setFee([MANDATE_FEE_NUM], { account: thirdParty.account }),
          pool,
          "NotManager",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // V] Un tarif ne se reporte jamais au mandat suivant
  //
  // La regle E1 du design : chaque epoch repart du nominal, et le gestionnaire
  // qui veut un autre tarif doit le redemander dans sa fenetre. La reelection
  // n'y change rien — c'est le point qui surprend, et la section B le fige.
  //
  // Le retour au nominal ne coute AUCUNE transaction : le temps avance par un
  // bloc vide, et c'est la comparaison de feeInForce() qui bascule, pas le
  // stockage. Les deux faces sont testees separement, parce que c'est leur
  // conjonction qui decrit le reset paresseux : la vue retombe, le champ brut
  // reste.
  // ---------------------------------------------------------------------------

  describe("V] Le mandat suivant retombe au nominal", function () {

    describe("A) Sans reelection", function () {

      it("feeInForce() rend le nominal a l'epoch suivante, sans aucune transaction", async function () {
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await runNominalMandate(fixture);

        // Un bloc VIDE : personne n'envoie rien, personne ne paie la remise a
        // zero.
        await warpTo(epochStart(fixture.genesis, 2n));

        const feeInForce = await fixture.pool.read.feeInForce();
        assert.equal(
          feeInForce,
          NOMINAL_FEE_NUM,
          `feeInForce() vaut ${feeInForce} a l'epoch 2 apres un mandat a ${MANDATE_FEE_NUM} sur l'epoch 1, attendu ${NOMINAL_FEE_NUM}`,
        );
      });

      it("feeNum brut porte encore le tarif perime a l'epoch suivante", async function () {
        // L'autre face du reset paresseux, et la raison pour laquelle le test
        // precedent ne suffit pas : rien n'a ete efface. Un contrat qui
        // remettrait vraiment feeNum au nominal passerait le premier test et
        // echouerait celui-ci, et il ferait payer un SSTORE a quelqu'un.
        const fixture = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await runNominalMandate(fixture);

        await warpTo(epochStart(fixture.genesis, 2n));

        const feeNum = BigInt(await fixture.pool.read.feeNum());
        assert.equal(
          feeNum,
          MANDATE_FEE_NUM,
          `feeNum brut vaut ${feeNum} a l'epoch 2, attendu ${MANDATE_FEE_NUM} : aucune ecriture ne l'a remis au nominal`,
        );
      });
    });

    describe("B) Avec reelection", function () {

      it("le gestionnaire reelu trouve le pool au nominal tant qu'il n'a pas rappele setFee", async function () {
        // La reelection ne reconduit PAS le tarif. Le meme compte est
        // gestionnaire des epochs 1 et 2 ; il a pose 20 sur la premiere ; a la
        // seconde, avant tout appel de sa part, le pool facture le nominal.
        // C'est ce que le bot d'enchere doit savoir : gagner deux mandats
        // d'affilee n'evite pas d'envoyer deux transactions.
        const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, manager.account.address]);
        await pool.write.setManager([2n, manager.account.address]);

        await callAt(epochStart(genesis, 1n));
        await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

        await warpTo(epochStart(genesis, 2n));

        const feeInForce = await pool.read.feeInForce();
        assert.equal(
          feeInForce,
          NOMINAL_FEE_NUM,
          `feeInForce() vaut ${feeInForce} au debut du second mandat du MEME gestionnaire, attendu ${NOMINAL_FEE_NUM} (un tarif ne se reconduit pas)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // VI] La pause ne bloque pas setFee
  //
  // setFee ne porte pas whenNotPaused, deliberement (Pool.sol:150-151) : la
  // pause arrete ce qui deplace de la valeur entre les jambes du pool, et
  // setFee n'en deplace pas. La promesse elle-meme, avec son argument complet,
  // est portee par Pool.pause.test.ts II.D et n'est pas dupliquee ici. Le seul
  // `it` de cette section verifie qu'une garde de pause n'a pas ete ajoutee a
  // setFee depuis, ce qui est la seule chose que la suite de setFee ait a en
  // dire.
  // ---------------------------------------------------------------------------

  describe("VI] La pause ne bloque pas setFee", function () {

    it("le gestionnaire tarife un pool en pause", async function () {
      const { pool, manager, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

      await pool.write.setManager([1n, manager.account.address]);
      await pool.write.pause();
      await callAt(epochStart(genesis, 1n));
      await pool.write.setFee([MANDATE_FEE_NUM], { account: manager.account });

      const feeInForce = await pool.read.feeInForce();
      assert.equal(
        feeInForce,
        MANDATE_FEE_NUM,
        `feeInForce() vaut ${feeInForce} apres un setFee sur pool en pause, attendu ${MANDATE_FEE_NUM} (aucun whenNotPaused sur setFee)`,
      );
    });
  });
});
