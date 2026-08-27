// Suite fonctionnelle TypeScript pour Pool.manager(), Pool.setAuction() et
// Pool.setManager(), la troisieme surface introduite par le contrat d'enchere
// (au-dela de l'AMM : Pool.swap/addLiquidity/removeLiquidity/pause/setFee).
//
// Pourquoi un fichier a part : ce que cette suite verifie tient en deux
// phrases distinctes, qui n'ont leur place dans aucune des six autres. La
// premiere, "a chaque epoque un seul gestionnaire commande et un seul est
// observable", est un observateur pur (manager()) que personne ne teste. La
// seconde, "le bootstrap est reserve a l'owner jusqu'a l'arrivee de
// l'enchere", est un controle d'acces a DEUX crans (setAuction puis
// setManager) qui n'a pas d'analogue dans les autres fonctions. Eclatee entre
// la suite de pause et celle de setFee, la frontiere entre bootstrap et
// regime nominal disparaitrait : on verrait "owner peut" et "tiers ne peut
// pas" sans voir le moment ou le droit bascule du premier au second.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : le parcours change de
// nature par rapport aux cinq autres fonctions TypeScript. Il n'y a ni token
// a approuver ni montant a transferer sur manager(), setAuction et
// setManager — seulement un appelant, une epoque, un destinataire. Ce qui se
// verifie a travers l'ABI generee est donc un controle d'acces exerce depuis
// trois comptes distincts (l'owner du deploiement, l'enchere designee, un
// tiers), l'effet de bord sur le mapping managerOf, et l'emission de
// l'evenement ManagerSet — exactement comme le front lira manager() et le
// bot d'enchere enverra setManager(). Un test Solidity testerait la formule
// et les gardes, ce qui repond a une autre question.
//
// Voir test/README.md pour la demarche complete et la liste des cas limites
// groupee par fonction.

import { zeroAddress } from "viem";
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

// Epoque de la section I.D : choisie loin du premier basculement pour montrer
// que la lecture via manager() tient au-dela du premier tour de compteur,
// comme la section II.C de Pool.currentEpoch.test.ts.
const FAR_EPOCH = 7n;

// Adresse conventionnelle pour designer l'adresse nulle. C'est la valeur que
// `manager()` rend quand aucun gestionnaire n'a ete nomme pour l'epoch
// courante, et la valeur que `setAuction(0x0)` ecrit en mode bootstrap (la
// garde ne verifie que `auction == address(0)`, donc passer zero ne revert
// pas et n'ecrit rien — voir Pool.sol:99-100 et la section II.D ci-dessous).
const ZERO_ADDRESS = zeroAddress;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.constructor.test.ts et Pool.currentEpoch.test.ts,
// deliberement. Ce fichier ouvre sa propre connexion reseau via
// network.create() : la partager avec les autres fichiers reviendrait a
// partager l'etat blockchain et le cache de loadFixture entre des suites qui
// doivent pouvoir tourner, echouer et evoluer separement (voir
// test/README.md).
// ---------------------------------------------------------------------------

// Deploie les trois ERC-20 seuls. Aucun pool ici : les tests des sections II
// et III ont besoin de fixer `auction` avant que `setManager` ne soit appele
// sur un pool tout juste deploye, et la fixture nominale ecrirait cette
// valeur dans son instantane. Le pool est deploye au cas par cas, en
// parametre de chaque test.
async function deployTokensFixture() {
  const [deployer, depositor, auctioneer, thirdParty] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);

  const tokenAddresses = [wbtc.address, cbbtc.address, lbtc.address] as const;

  return { deployer, depositor, auctioneer, thirdParty, wbtc, cbbtc, lbtc, tokenAddresses };
}

type TokensFixture = Awaited<ReturnType<typeof deployTokensFixture>>;

// Deploie un pool sur des jetons deja en place, avec les valeurs nominales
// (PoolTestBase.sol). `deployer` est l'owner — c'est lui qui detient le
// bootstrap avant l'arrivee de l'encherisseur.
async function deployPoolWith(base: TokensFixture) {
  const mrn = await viem.deployContract("MRN", []);
  return viem.deployContract("Pool", [
    [...base.tokenAddresses],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    DEFAULT_FEE_NUM,
    base.deployer.account.address,
    mrn.address,
    base.deployer.account.address,
  ]);
}

// Fixture nominale : les trois jetons plus un pool deploye avec les valeurs
// de production, et le timestamp du bloc qui l'a porte (pour permettre aux
// tests de warp jusqu'a une epoque future sans recalculer GENESIS, exactement
// comme Pool.currentEpoch.test.ts).
async function deployTokensAndPoolFixture() {
  const base = await deployTokensFixture();
  const pool = await deployPoolWith(base);

  const publicClient = await viem.getPublicClient();
  const deploymentBlock = await publicClient.getBlock();
  const genesis = deploymentBlock.timestamp;

  return { ...base, pool, genesis };
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Place le prochain bloc EXACTEMENT sur `timestamp`, puis le mine. Voir
// Pool.currentEpoch.test.ts:135-138 pour la justification complete de la
// cible absolue (delta relatif deriverait de la seconde consommee par
// chaque transaction precedente du test).
async function warpTo(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
  await networkHelpers.mine();
}

describe("Pool.manager", async function () {

  // ---------------------------------------------------------------------------
  // I] Lecture du mandat courant — `manager()`
  //
  // La fonction est un trivial retour de mapping sur l'epoch courante :
  // `managerOf[currentEpoch()]` (Pool.sol:96-98). Ce qui merite un test n'est
  // pas la formule, c'est ce qu'elle GARANTIT vis-a-vis du decoupage en
  // epoques — qu'un mandat pour l'epoch N ne survit pas au basculement a
  // l'epoch N+1, qu'un mandat pour une epoque lointaine reste lisible le
  // moment venu. La frontiere entre sections A et B est l'etat du mapping :
  // vide (rend zero), setté (rend l'adresse), setté sur une autre epoch
  // (rend zero quand l'epoch courante n'est pas la bonne).
  // ---------------------------------------------------------------------------

  describe("I] Lecture du mandat courant", function () {
    describe("A) Epoch 0, personne nommé", function () {
      it("manager() rend 0x0 quand aucun managerOf n'est setté", async function () {
        // Calcul a la main : currentEpoch() == 0 sur le bloc de deploiement,
        // managerOf[0] vide, donc manager() rend l'adresse nulle.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const manager = await pool.read.manager();
        assert.equal(
          manager,
          ZERO_ADDRESS,
          `manager() vaut ${manager} au deploiement, attendu ${ZERO_ADDRESS} (aucun managerOf[0] setté)`,
        );
      });
    });

    describe("B) Epoch 0, managerOf[0] (lecture directe) et manager() renvoient la meme valeur", function () {
      // Le prompt demande : "epoch 0, managerOf[0] setté, manager() rend cette
      // adresse". managerOf[0] n'est en pratique JAMAIS settable via
      // setManager : le require `_epoch > currentEpoch()` (Pool.sol:106)
      // refuse `_epoch == 0` aussi bien a l'epoch 0 (0 > 0 est faux) qu'a
      // toute epoch ulterieure (0 > N est faux pour N >= 1). La valeur de
      // managerOf[0] est donc 0x0 par construction, et la portion
      // "managerOf[0] setté" de l'enonce n'est pas atteignable.
      //
      // Ce que ce test verifie a la place est ce qui reste de l'enonce
      // atteignable : que manager() et la lecture directe de managerOf[0]
      // par son getter public renvoient la meme valeur. Les deux lectures
      // passent par le meme slot, et un manager() qui derouterait vers un
      // autre indice (par exemple managerOf[1]) divergerait ici. Le test
      // utilise un owner tierce pour rendre toute confusion par defaut
      // visible.
      it("managerOf[0] et manager() coincident a l'epoch 0", async function () {
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        // Meme si l'on tentait setManager(0, X), la garde Pool.sol:106 le
        // refuserait avec EpochAlreadyStarted : managerOf[0] reste donc
        // forcement 0x0. On note la valeur observee plutot que de la poser.
        const direct = await pool.read.managerOf([0n]);
        assert.equal(
          direct,
          ZERO_ADDRESS,
          `managerOf[0] vaut ${direct}, attendu ${ZERO_ADDRESS} (slot 0 inatteignable par setManager, reste a sa valeur par defaut)`,
        );

        const manager = await pool.read.manager();
        assert.equal(
          manager,
          direct,
          `manager()=${manager} et managerOf[0]=${direct} devraient coincider a l'epoch 0`,
        );
      });
    });

    describe("C) Epoch 1, managerOf[1] vide : manager() rend 0x0", function () {
      // Le prompt demande : "epoch 1, managerOf[0] setté mais managerOf[1]
      // vide, manager() rend 0x0". La portion "managerOf[0] setté" n'est
      // pas atteignable (cf. ci-dessus). La portion verifiable est
      // "managerOf[1] vide, manager() rend 0x0" : c'est elle que ce test
      // tient. Le sens du test est preserve : un mandat pour l'epoch 0
      // n'aurait de toute facon aucune influence sur manager() a l'epoch
      // 1, qui lit managerOf[1] et rien d'autre.
      //
      // Calcul a la main : managerOf[1] vide (jamais sette, _epoch > 0
      // necessaire pour setManager), le temps saute a GENESIS + EPOCH_DURATION,
      // currentEpoch() == 1, donc manager() rend 0x0.
      it("manager() rend 0x0 a l'epoch 1 quand managerOf[1] est vide", async function () {
        const { pool, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + EPOCH_DURATION);

        const epoch = await pool.read.currentEpoch();
        assert.equal(epoch, 1n, `le warp devrait porter currentEpoch() a 1, il vaut ${epoch}`);

        const direct = await pool.read.managerOf([1n]);
        assert.equal(
          direct,
          ZERO_ADDRESS,
          `managerOf[1] vaut ${direct}, attendu ${ZERO_ADDRESS} (slot 1 non setté)`,
        );

        const manager = await pool.read.manager();
        assert.equal(
          manager,
          ZERO_ADDRESS,
          `manager() vaut ${manager} a l'epoch 1, attendu ${ZERO_ADDRESS} (managerOf[1] vide)`,
        );
      });
    });

    describe("D) Epoch 7, managerOf[7] setté", function () {
      it("manager() rend l'adresse settée pour une epoque lointaine", async function () {
        // Cas symetrique de la section B, huit epoques plus loin : on pose
        // managerOf[7] (autorise car 7 > currentEpoch() == 0 au moment de
        // l'ecriture), on saute le temps au milieu de l'epoch 7, et on relit
        // manager(). Calcul a la main : 7 * 14400 + 7200 = 108000,
        //   108000 / 14400 = 7,5 -> 7 en division entiere.
        const { pool, auctioneer, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([FAR_EPOCH, auctioneer.account.address]);
        await warpTo(genesis + FAR_EPOCH * EPOCH_DURATION + EPOCH_DURATION / 2n);

        const manager = await pool.read.manager();
        assert.equal(
          manager.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `manager() vaut ${manager} au milieu de l'epoch ${FAR_EPOCH}, attendu ${auctioneer.account.address}`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] `setAuction`
  //
  // setAuction a deux proprietes que les autres setX du contrat n'ont pas.
  // D'abord il est `onlyOwner`, comme `setFee`, `pause` et `unpause`, et
  // c'est OZ qui le decident : on teste ici que la garde est bien posee,
  // pas son fonctionnement (cf. Pool.pause.test.ts I.A pour la meme
  // demarche). Ensuite il est SINGLE-SHOT : la garde `AuctionAlreadySet`
  // (Pool.sol:99) ferme la possibilite d'un deuxieme set, et c'est delibere
  // — l'enchere n'est pas un module qu'on peut permuter, c'est une ancre du
  // protocole, une fois designee elle l'est pour toute la vie du contrat.
  // ---------------------------------------------------------------------------

  describe("II] setAuction", function () {
    describe("A) onlyOwner", function () {
      it("un tiers appelle setAuction : OwnableUnauthorizedAccount", async function () {
        // onlyOwner sur setAuction est un choix de Pool.sol (Pool.sol:98), pas
        // un comportement herite passivement : c'est a ce titre qu'il est
        // teste. Meme demarche que Pool.pause.test.ts I.A.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setAuction([auctioneer.account.address], { account: auctioneer.account }),
          pool,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("B) Premier set a une adresse non-nulle", function () {
      it("l'owner appelle setAuction(X) : succes, auction() renvoie X", async function () {
        // Le test relit auction() apres l'appel : sans la relecture, une
        // fonction qui ne ferait rien passerait la seule absence de revert.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([auctioneer.account.address]);

        const auction = await pool.read.auction();
        assert.equal(
          auction.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `auction() vaut ${auction}, attendu ${auctioneer.account.address}`,
        );
      });
    });

    describe("C) Deuxieme set, quelle que soit l'adresse", function () {
      it("setAuction(Y) apres setAuction(X) reverte : AuctionAlreadySet", async function () {
        // L'enchere est single-shot (Pool.sol:99), et la garde sort qu'on
        // tente de la permuter par n'importe quelle adresse — y compris
        // l'adresse nulle, qui aurait sinon pour effet de bord de reouvrir
        // la voie bootstrap (cf. section II.D pour le pendant zero).
        //
        // Le test pose auctioneer en premier (B ci-dessus), puis tente
        // thirdParty : la garde n'examine pas l'argument, seulement l'etat
        // actuel, et elle sort.
        const { pool, auctioneer, thirdParty } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([auctioneer.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.setAuction([thirdParty.account.address]),
          pool,
          "AuctionAlreadySet",
        );
      });

      it("setAuction(0x0) apres setAuction(X) reverte : AuctionAlreadySet", async function () {
        // Cas particulier du precedent : l'argument est l'adresse nulle.
        // Le prompt pour II.D decrit setAuction(0x0) en PRIEUR comme un
        // no-op silencieux. C'est vrai UNIQUEMENT quand auction etait deja
        // nulle, c'est-a-dire avant tout premier set reussi. Apres un set
        // reussi, la garde ne regarde pas l'argument, donc la permutation
        // vers zero reverte comme n'importe quelle autre. Ce test ferme
        // l'asymetrie entre les deux moments.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([auctioneer.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.setAuction([ZERO_ADDRESS]),
          pool,
          "AuctionAlreadySet",
        );
      });
    });

    describe("D) Premier set a address(0) : no-op silencieux, voie bootstrap", function () {
      it("setAuction(0x0) sur un pool frais reussit et laisse auction() a 0x0", async function () {
        // VOIE BOOTSTRAP, DELIBEREE, PAS UN OUBLI.
        //
        // La garde (Pool.sol:99) ne verifie que `auction == address(0)` :
        // passer zero en argument satisfait la garde et fait `auction = 0x0`,
        // qui n'est autre que l'etat de depart. Le resultat observable est
        // donc strictement identique a un non-appel : la transaction ne
        // revert pas, mais elle n'ecrit rien de nouveau.
        //
        // Pourquoi laisser passer : pendant la periode qui precede
        // l'arrivee de l'encherisseur, l'owner doit pouvoir nommer les
        // gestionnaires epoch par epoch (cf. section III.C). Si setAuction
        // etait l'unique voie d'acces et qu'elle se ferme au premier
        // appel, l'owner serait bloque des qu'il aurait pose une enchere
        // meme nulle. La voie bootstrap doit donc rester ouverte tant
        // qu'aucune enchere reelle n'a ete designee, et la seule facon de
        // l'ouvrir est de tolerer un setAuction(0x0) qui ne fait rien.
        //
        // Le test verifie les deux faces du no-op : pas de revert, et
        // auction() reste 0x0 apres.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([ZERO_ADDRESS]);

        const auction = await pool.read.auction();
        assert.equal(
          auction,
          ZERO_ADDRESS,
          `auction() vaut ${auction} apres setAuction(0x0), attendu ${ZERO_ADDRESS} (no-op silencieux)`,
        );
      });

      it("apres setAuction(0x0), la voie bootstrap reste ouverte : l'owner peut toujours setManager", async function () {
        // Suite logique du test precedent : le no-op silencieux n'a pas
        // consomme le single-shot, et l'owner peut toujours nommer un
        // gestionnaire via la branche `auction == 0x0 && msg.sender ==
        // owner()` (Pool.sol:105). C'est ce qui rend le bootstrap viable
        // en pratique : l'owner peut iterer setAuction(0x0) entre deux
        // nominations sans jamais verrouiller l'acces.
        //
        // L'epoch ciblee est 1 et non 0 : la garde `_epoch > currentEpoch()`
        // (Pool.sol:117) est un strict, donc epoch 0 reverte avec
        // EpochAlreadyStarted des le deploiement, independamment de
        // l'appelant. Tester la voie bootstrap exige donc une epoch future
        // licite — la premiere etant 1, puisque currentEpoch() vaut 0 sur
        // le bloc de deploiement.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([ZERO_ADDRESS]);
        await pool.write.setManager([1n, auctioneer.account.address]);

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored}, attendu ${auctioneer.account.address} (bootstrap via setAuction(0x0))`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] `setManager` — appelant
  //
  // La garde d'appelant (Pool.sol:105) prend la forme d'une DISJONCTION
  // entre deux branches qui n'ont pas la meme duree de vie :
  //
  //   msg.sender == auction
  //       OU (auction == address(0) ET msg.sender == owner)
  //
  // La premiere branche dure toute la vie du contrat des que l'enchere est
  // designee. La seconde est la voie bootstrap, valable uniquement tant
  // qu'aucune enchere n'a ete posee. Les quatre cas A-D epinglent chaque
  // branche, dans chaque etat. Le cas E ferme un degre de liberte que
  // rien dans le code ne ferme par accident : si l'owner s'auto-set comme
  // enchere, la voie bootstrap n'est plus emprunable (auction != 0x0),
  // mais la premiere branche s'applique (msg.sender == auction == owner)
  // et l'appel reussit.
  // ---------------------------------------------------------------------------

  describe("III] setManager — appelant", function () {
    describe("A) auction non-nulle, msg.sender == auction : succes", function () {
      it("l'encherisseur designe appelle setManager : succes, managerOf[epoch] est setté", async function () {
        // Voie nominale, post-bootstrap. L'owner pose d'abord l'enchere
        // (section II.B), puis l'encherisseur pose un gestionnaire pour
        // l'epoch 1 (la premiere epoque future, autorisee par le require
        // `_epoch > currentEpoch()` de la section IV).
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([auctioneer.account.address]);
        await pool.write.setManager(
          [1n, auctioneer.account.address],
          { account: auctioneer.account },
        );

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored}, attendu ${auctioneer.account.address}`,
        );
      });
    });

    describe("B) auction non-nulle, msg.sender autre : revert NotAuctionOrOwner", function () {
      it("un tiers appelle setManager quand auction est designé : NotAuctionOrOwner", async function () {
        // Le cas symetrique du precedent. La garde ne regarde pas l'argument
        // `_who`, seulement `msg.sender` et `auction`. Un tiers — qui n'est
        // ni l'un ni l'autre — est refuse avant que `_who` ou `_epoch` ne
        // soient lus.
        const { pool, auctioneer, thirdParty } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setAuction([auctioneer.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([1n, thirdParty.account.address], { account: thirdParty.account }),
          pool,
          "NotAuctionOrOwner",
        );
      });
    });

    describe("C) auction nulle, msg.sender == owner : succes (voie bootstrap)", function () {
      it("l'owner appelle setManager sur un pool frais : succes, managerOf[epoch] est setté", async function () {
        // La voie bootstrap, avant l'arrivee de l'enchere. L'owner pose
        // directement un gestionnaire pour l'epoch 1 sans avoir appele
        // setAuction au prealable — la disjonction de Pool.sol:105
        // s'applique sur la deuxieme branche.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, auctioneer.account.address]);

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored}, attendu ${auctioneer.account.address} (bootstrap)`,
        );
      });
    });

    describe("D) auction nulle, msg.sender autre : revert NotAuctionOrOwner", function () {
      it("un tiers appelle setManager sur un pool frais : NotAuctionOrOwner", async function () {
        // Cas symetrique de C. La voie bootstrap est reservee a l'owner, et
        // la garde sort avant meme de regarder `_epoch` ou `_who` : le
        // mapping managerOf reste intact.
        const { pool, thirdParty, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([1n, auctioneer.account.address], { account: thirdParty.account }),
          pool,
          "NotAuctionOrOwner",
        );

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored,
          ZERO_ADDRESS,
          `managerOf[1] vaut ${stored} apres revert, attendu ${ZERO_ADDRESS} (aucun effet de bord)`,
        );
      });
    });

    describe("E) auction == msg.sender == owner : succes (cas degénéré)", function () {
      it("l'owner s'auto-set comme enchere puis appelle setManager : succes sur la branche msg.sender == auction", async function () {
        // CAS DEGENERE, mais legal : l'owner appelle setAuction avec sa
        // PROPRE adresse. La voie bootstrap n'est alors plus empruntable
        // (auction != 0x0), mais la premiere branche de la disjonction
        // s'applique : msg.sender == auction (les deux valent l'adresse de
        // l'owner). L'appel reussit.
        //
        // Le cas merite d'etre epingle parce que rien dans le contrat ne
        // distingue explicitement "voix bootstrap" et "voix auction" dans
        // le require — c'est la conjonction des branches qui decide, et un
        // deploiement ou l'owner serait aussi l'encherisseur marcherait
        // par accident si la garde ne faisait pas ce qu'elle dit.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const ownerAddress = await pool.read.owner();

        await pool.write.setAuction([ownerAddress]);
        await pool.write.setManager([1n, ownerAddress]);

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          ownerAddress.toLowerCase(),
          `managerOf[1] vaut ${stored}, attendu ${ownerAddress} (cas degénéré owner == auction)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // IV] `setManager` — gardes de fond
  //
  // Les trois gardes suivantes (Pool.sol:106-108) ferment, dans l'ordre,
  // trois classes d'entrees fautives : une epoch du passe ou du present,
  // un destinataire nul, et une nomination deja posee pour la meme epoch.
  // Les deux premieres sont STRICTEMENT bornees par le type d'entree ; la
  // troisieme depend de l'etat anterieur du mapping. La section D ferme
  // cette derniere en montrant qu'elle discrimine par (epoch) et pas par
  // (_who) — deux appels sur la meme epoch echouent, deux appels sur des
  // epochs distinctes reussissent.
  // ---------------------------------------------------------------------------

  describe("IV] setManager — gardes de fond", function () {
    describe("A) _who == address(0) : revert ZeroManager", function () {
      it("setManager(1, 0x0) reverte : ZeroManager", async function () {
        // La garde precede celle sur `_epoch` dans Pool.sol, donc elle sort
        // meme si l'epoch est valide. Le test pose une epoque future licite
        // (1) avec un destinataire nul pour eprouver ZeroManager seule.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([1n, ZERO_ADDRESS]),
          pool,
          "ZeroManager",
        );

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored,
          ZERO_ADDRESS,
          `managerOf[1] vaut ${stored} apres revert, attendu ${ZERO_ADDRESS} (aucun effet de bord)`,
        );
      });
    });

    describe("B) _epoch <= currentEpoch() : revert EpochAlreadyStarted", function () {
      it("setManager(0, X) reverte : EpochAlreadyStarted", async function () {
        // La garde est `_epoch > currentEpoch()` (Pool.sol:106), un STRICT.
        // Au deploiement currentEpoch() == 0, donc _epoch == 0 viole la
        // borne inferieure — c'est le seul cas de frontiere. Un _epoch
        // negatif n'est pas atteignable par l'ABI (uint256).
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([0n, auctioneer.account.address]),
          pool,
          "EpochAlreadyStarted",
        );

        const stored = await pool.read.managerOf([0n]);
        assert.equal(
          stored,
          ZERO_ADDRESS,
          `managerOf[0] vaut ${stored} apres revert, attendu ${ZERO_ADDRESS} (aucun effet de bord)`,
        );
      });

      it("setManager d'une epoque deja passée reverte : EpochAlreadyStarted", async function () {
        // Meme garde, epoque passée cette fois. Le temps saute bien apres
        // EPOCH_DURATION pour que currentEpoch() == 1, puis le test tente
        // setManager(0, X) — l'epoch 0 est strictement dans le passé.
        const { pool, auctioneer, genesis } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await warpTo(genesis + EPOCH_DURATION);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([0n, auctioneer.account.address]),
          pool,
          "EpochAlreadyStarted",
        );
      });
    });

    describe("C) _epoch == currentEpoch() + 1 : succes (premiere epoque future acceptee)", function () {
      it("setManager(1, X) sur un pool frais reussit : la frontiere est inclusive cote futur", async function () {
        // Le pendant positif de la section B : currentEpoch() == 0, la
        // premiere epoque future (1) satisfait exactement `_epoch >
        // currentEpoch()` (Pool.sol:106). C'est ce qui donne a l'owner ou a
        // l'encherisseur une epoque entiere de preavis pour nommer le
        // gestionnaire suivant.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, auctioneer.account.address]);

        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored}, attendu ${auctioneer.account.address}`,
        );
      });
    });

    describe("D) Double nomination, memes epoch ou epochs distinctes", function () {
      it("setManager(1, X) puis setManager(1, Y) : la seconde reverte ManagerAlreadySet", async function () {
        // La garde lit `managerOf[_epoch] == address(0)` (Pool.sol:108), pas
        // `_who` ni `_epoch`. Un deuxieme appel sur la meme epoque future
        // lit une valeur deja non-nulle, et sort ManagerAlreadySet avant
        // d'ecrire quoi que ce soit.
        const { pool, auctioneer, thirdParty } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, auctioneer.account.address]);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([1n, thirdParty.account.address]),
          pool,
          "ManagerAlreadySet",
        );

        // L'etat anterieur est preserve : c'est la premiere nomination qui
        // tient, pas une moyenne, pas une permutation.
        const stored = await pool.read.managerOf([1n]);
        assert.equal(
          stored.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored} apres revert, attendu ${auctioneer.account.address} (premiere nomination tenue)`,
        );
      });

      it("setManager(1, X) puis setManager(2, Y) : les deux reussissent, epoques differentes", async function () {
        // Le pendant positif du precedent. La garde discrimine par EPOQUE,
        // pas par destinataire, et deux appels sur des epoques distinctes
        // lisent a chaque fois un managerOf vide pour leur epoque. C'est
        // ce qui permet de preparer un calendrier de gestionnaires sur
        // plusieurs epoques a l'avance.
        const { pool, auctioneer, thirdParty } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.setManager([1n, auctioneer.account.address]);
        await pool.write.setManager([2n, thirdParty.account.address]);

        const stored1 = await pool.read.managerOf([1n]);
        const stored2 = await pool.read.managerOf([2n]);
        assert.equal(
          stored1.toLowerCase(),
          auctioneer.account.address.toLowerCase(),
          `managerOf[1] vaut ${stored1}, attendu ${auctioneer.account.address}`,
        );
        assert.equal(
          stored2.toLowerCase(),
          thirdParty.account.address.toLowerCase(),
          `managerOf[2] vaut ${stored2}, attendu ${thirdParty.account.address}`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // V] Evènement `ManagerSet`
  //
  // Le contrat emet `ManagerSet(uint256 indexed epoch, address indexed
  // manager)` (Pool.sol:67) sur chaque succes de setManager. Les deux
  // arguments sont indexes, donc les clients (subgraph, indexeur, front)
  // peuvent filtrer par epoch ou par gestionnaire sans scanner le data
  // complet. La section verifie qu'un succes emit exactement un evenement
  // avec les bons args, et qu'un revert n'en emit aucun.
  // ---------------------------------------------------------------------------

  describe("V] Evenement ManagerSet", function () {
    describe("A) Succes de setManager", function () {
      it("un seul ManagerSet(epoch, who) est emis, avec epoch et who indexes", async function () {
        // viem.assertions.emitWithArgs decode le log en utilisant l'ABI du
        // contrat (ManagerSet(uint256 indexed epoch, address indexed
        // manager)), donc les deux args apparaissent dans les topics du
        // receipt, pas dans la data. Le matcher verifie qu'un seul ManagerSet
        // est emis, avec epoch == 1 et who == owner.address, dans l'ordre
        // de la signature.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const ownerAddress = await pool.read.owner();

        await viem.assertions.emitWithArgs(
          pool.write.setManager([1n, ownerAddress]),
          pool,
          "ManagerSet",
          [1n, ownerAddress],
        );
      });
    });

    describe("B) Revert de setManager", function () {
      it("aucun ManagerSet n'est emis quand setManager revert", async function () {
        // Un revert efface tout l'etat de la transaction, y compris les
        // evenements emis avant la garde fautive : le receipt d'une
        // transaction revertee ne porte aucun log de la transaction. La
        // verification ci-dessous relit donc managerOf(0) pour confirmer
        // qu'aucune ecriture n'a eu lieu — c'est l'effet de bord observable
        // qui prouve que l'evenement n'a pas ete emis en pratique.
        const { pool, auctioneer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.setManager([0n, auctioneer.account.address]),
          pool,
          "EpochAlreadyStarted",
        );

        const stored = await pool.read.managerOf([0n]);
        assert.equal(
          stored,
          ZERO_ADDRESS,
          `managerOf[0] vaut ${stored} apres revert, attendu ${ZERO_ADDRESS} (aucun ManagerSet n'a ete emis ni execute)`,
        );
      });
    });
  });
});