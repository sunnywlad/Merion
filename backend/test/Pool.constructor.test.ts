// Suite fonctionnelle TypeScript pour le constructeur de Pool.
//
// Pourquoi un fichier a part plutot qu'un describe greffe sur l'une des
// quatre suites existantes : le constructeur n'appartient a aucune des
// fonctions qu'elles testent. Il fige les immuables que TOUTES lisent
// ensuite (les trois adresses de jetons, la fenetre d'epoque, la bande de
// frais, la tresorerie, l'owner) et pose l'etat mutable de depart (feeNum).
// Loge dans Pool.addLiquidity.test.ts, comme il l'etait jusqu'ici sous un
// "0] Constructeur" a un seul cas, il se lisait comme une dependance
// d'addLiquidity, ce qu'il n'est pas.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : ce que cette suite
// interroge est le DEPLOIEMENT lui-meme, c'est-a-dire la transaction que
// l'equipe enverra en production et que le front lira ensuite par ses
// getters publics. Un test Solidity deploie le pool depuis un contrat de
// test, avec ses propres arguments figes dans PoolTestBase.sol ; un test
// TypeScript reproduit le parcours reel, huit arguments passes a travers
// l'ABI generee, puis relus un a un par les memes getters que le front
// appelle. Les deux chemins de revert du constructeur ne sont d'ailleurs
// atteignables que la : une fois PoolTestBase.sol deploye, ils sont derriere
// nous.
//
// Perimetre : on teste ce que Pool.sol DECIDE. Ownable(_owner) reverte sur
// l'adresse nulle avec OwnableInvalidOwner, mais c'est OZ qui le decide, pas
// une ligne de Pool.sol ; ce cas est donc absent, comme le sont les noms
// ERC-20 ("MerionLP" / "MRNLP"), poses en dur dans l'entete du constructeur
// et sans argument a verifier.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis les quatre autres fichiers plutot que partagees.

import { artifacts, network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeErrorResult, type Abi } from "viem";

const { viem, networkHelpers } = await network.create();

// L'ABI de Pool, lue depuis l'artefact de compilation. Elle sert a decoder la
// donnee de revert d'un DEPLOIEMENT, que viem ne decode pas lui-meme (voir le
// helper plus bas) : il faut donc une ABI sous la main sans avoir a deployer
// au prealable un pool valide dont on n'aurait besoin que pour ca.
const POOL_ABI = (await artifacts.readArtifact("Pool")).abi as Abi;

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const MAX_FEE_NUM = 50n; // Pool.sol:24
const UNBALANCE_FACTOR = 2n; // Pool.sol:27

// Valeurs de deploiement, celles que porte le reste de la suite.
const DEFAULT_FEE_NUM = 5n; // _nominalFeeNum
const MIN_FEE_NUM = 1n; // _minFeeNum, cf. PoolTestBase.sol
const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n; // cf. build-auction.md 5.0 bis

// Frontiere des deux gardes du constructeur (Pool.sol:70-71). Les deux
// bornent le frais EFFECTIF, pas le frais de base : la surcharge de
// desequilibre multiplie la base par UNBALANCE_FACTOR, donc la condition
// s'ecrit `base * UNBALANCE_FACTOR <= MAX_FEE_NUM`. Calcul a la main :
//   MAX_FEE_NUM / UNBALANCE_FACTOR = 50 / 2 = 25   -> derniere base acceptee
//   26 * 2 = 52 > 50                               -> premiere base refusee
// La frontiere est donc la meme pour les deux arguments, _minFeeNum comme
// _nominalFeeNum, les deux require etant litteralement la meme inegalite.
const MAX_BASE_FEE_NUM = MAX_FEE_NUM / UNBALANCE_FACTOR; // 25
const ABOVE_MAX_BASE_FEE_NUM = MAX_BASE_FEE_NUM + 1n; // 26

const ZERO_FEE_NUM = 0n;

// Frontiere des deux gardes de l'horloge d'enchere (Pool.sol:72-73).
//
//   require(_epochDuration > 0, ZeroEpochDuration());
//   require(_priorityWindow <= _epochDuration, PriorityWindowTooLong());
//
// La premiere est une inegalite STRICTE et n'a pas de borne haute : zero est
// la seule valeur refusee, 1 la plus petite acceptee. La seconde est un <= :
// la fenetre peut couvrir l'epoque entiere, elle ne peut pas la depasser.
// Calcul a la main, sur la duree de production :
//   14400 <= 14400  -> derniere fenetre acceptee
//   14401 > 14400   -> premiere fenetre refusee
const ZERO_EPOCH_DURATION = 0n;
const MIN_EPOCH_DURATION = 1n; // plus petite duree acceptee par le require > 0
const ABOVE_EPOCH_DURATION = EPOCH_DURATION + 1n; // 14401, premiere fenetre refusee
const ZERO_PRIORITY_WINDOW = 0n;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliques depuis Pool.addLiquidity.test.ts, deliberement. Ce fichier ouvre
// sa propre connexion reseau via network.create() : la partager avec les
// autres fichiers reviendrait a partager l'etat blockchain et le cache de
// loadFixture entre des suites qui doivent pouvoir tourner, echouer et
// evoluer separement (voir test/README.md).
// ---------------------------------------------------------------------------

// Deploie les trois ERC-20 seuls. Les tests de gardes deploient ensuite leur
// pool a la main, avec les arguments de frais qu'ils veulent eprouver : c'est
// le constructeur lui-meme qui est sous test, il ne peut donc pas etre cache
// dans la fixture.
async function deployTokensFixture() {
  const [deployer, depositor, other, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  // Le jeton natif MRN, septieme argument du constructeur : le Pool le garde
  // en immuable pour verser le loyer LP par claimRent (I.4).
  const mrn = await viem.deployContract("MRN", []);

  const tokenAddresses = [wbtc.address, cbbtc.address, lbtc.address] as const;

  return { deployer, depositor, other, treasury, wbtc, cbbtc, lbtc, mrn, tokenAddresses };
}

type TokensFixture = Awaited<ReturnType<typeof deployTokensFixture>>;

// Deploie un pool sur des jetons deja en place, en laissant chaque test
// choisir _minFeeNum et _nominalFeeNum, et — pour la section III — la duree
// d'epoque et la fenetre de priorite. Les deux derniers parametres portent
// les valeurs du deploiement reel par defaut : les tests de la bande de frais
// n'ont ainsi rien a changer, et seuls ceux qui eprouvent l'horloge les
// nomment explicitement.
function deployPoolWith(
  base: TokensFixture,
  minFeeNum: bigint,
  nominalFeeNum: bigint,
  epochDuration: bigint = EPOCH_DURATION,
  priorityWindow: bigint = PRIORITY_WINDOW,
) {
  return viem.deployContract("Pool", [
    [...base.tokenAddresses],
    epochDuration,
    priorityWindow,
    minFeeNum,
    nominalFeeNum,
    base.treasury.account.address,
    base.mrn.address,
    base.deployer.account.address,
  ]);
}

// Fixture nominale : les trois jetons plus un pool deploye avec les valeurs
// de production, et le timestamp du bloc qui l'a porte. Sous automine, une
// transaction fait un bloc : le bloc `latest` lu juste apres le deploiement
// est donc exactement celui du deploiement, ce qui donne la valeur attendue
// de GENESIS sans jamais la recalculer depuis l'horloge du test.
async function deployTokensAndPoolFixture() {
  const base = await deployTokensFixture();
  const pool = await deployPoolWith(base, MIN_FEE_NUM, DEFAULT_FEE_NUM);

  const publicClient = await viem.getPublicClient();
  const deploymentBlock = await publicClient.getBlock();

  return { ...base, pool, deploymentTimestamp: deploymentBlock.timestamp };
}

// Attrape le revert d'un DEPLOIEMENT et compare le nom de l'erreur decodee a
// celui attendu.
//
// Deux raisons de ne pas passer par viem.assertions.revertWithCustomError.
// La premiere est technique et decide a elle seule : ce matcher lit un
// ContractFunctionRevertedError, que viem ne construit que pour un APPEL de
// fonction. Un deploiement qui reverte remonte en TransactionExecutionError,
// et la donnee de revert n'y est jamais decodee ; le selecteur brut vit plus
// bas dans la chaine `cause`, sur l'erreur que le simulateur Hardhat y greffe.
// La seconde rejoint ce que test/README.md dit des panics : plutot que de
// chercher le nom de l'erreur dans le TEXTE du message, ce helper decode les
// quatre octets contre l'ABI reelle du contrat, puis compare deux noms dans
// une seule assertion. C'est ce qui permet a la section II.C d'affirmer
// "FeeTooHigh ET PAS EmptyFeeBand" en nommant, en cas d'echec, l'erreur
// reellement sortie.
async function assertDeployRevertsWithCustomError(
  promise: Promise<unknown>,
  expectedErrorName: string,
) {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (current !== undefined && current !== null) {
      const data = (current as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x")) {
        const decoded = decodeErrorResult({ abi: POOL_ABI, data: data as `0x${string}` });
        assert.equal(
          decoded.errorName,
          expectedErrorName,
          `le deploiement a reverte avec ${decoded.errorName}, attendu ${expectedErrorName}`,
        );
        return;
      }
      current = (current as { cause?: unknown }).cause;
    }
    assert.fail(
      `aucune donnee de revert trouvee dans la chaine d'erreurs ; erreur recue : ${String(error)}`,
    );
    return;
  }
  assert.fail(
    `le deploiement aurait du revert avec ${expectedErrorName}, mais il a reussi`,
  );
}

describe("Pool.constructor", async function () {

  // ---------------------------------------------------------------------------
  // I] Valeurs figees a la construction
  //
  // Une assertion par valeur, et un `it` par valeur : chacune est un getter
  // distinct, et un test qui les grouperait masquerait laquelle a devie.
  // ---------------------------------------------------------------------------

  describe("I] Valeurs figees a la construction", function () {
    describe("A) Immuables relus par leur getter", function () {
      it("EPOCH_DURATION lit bien _epochDuration", async function () {
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const epochDuration = await pool.read.EPOCH_DURATION();
        assert.equal(
          epochDuration,
          EPOCH_DURATION,
          `EPOCH_DURATION() vaut ${epochDuration}, attendu ${EPOCH_DURATION}`,
        );
      });

      it("PRIORITY_WINDOW lit bien _priorityWindow", async function () {
        // La fenetre de priorite et la duree d'epoque sont deux uint256
        // consecutifs dans la signature (Pool.sol:60-61) : les verifier
        // separement, avec deux valeurs volontairement tres differentes
        // (14400 contre 12), est ce qui prouve qu'aucune n'a ete affectee a
        // la place de l'autre.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const priorityWindow = await pool.read.PRIORITY_WINDOW();
        assert.equal(
          priorityWindow,
          PRIORITY_WINDOW,
          `PRIORITY_WINDOW() vaut ${priorityWindow}, attendu ${PRIORITY_WINDOW}`,
        );
      });

      it("MIN_FEE_NUM lit bien _minFeeNum", async function () {
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const minFeeNum = await pool.read.MIN_FEE_NUM();
        assert.equal(
          minFeeNum,
          MIN_FEE_NUM,
          `MIN_FEE_NUM() vaut ${minFeeNum}, attendu ${MIN_FEE_NUM}`,
        );
      });

      it("NOMINAL_FEE_NUM lit bien _nominalFeeNum", async function () {
        // Meme argument que pour la paire epoque / fenetre : _minFeeNum et
        // _nominalFeeNum se suivent dans la signature (Pool.sol:62-63) et
        // valent ici 1 et 5. Les intervertir ferait echouer ce test et le
        // precedent, pas seulement l'un des deux.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const nominalFeeNum = await pool.read.NOMINAL_FEE_NUM();
        assert.equal(
          nominalFeeNum,
          DEFAULT_FEE_NUM,
          `NOMINAL_FEE_NUM() vaut ${nominalFeeNum}, attendu ${DEFAULT_FEE_NUM}`,
        );
      });

      it("treasury lit bien _treasury", async function () {
        const { pool, treasury } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const storedTreasury = await pool.read.treasury();
        assert.equal(
          storedTreasury.toLowerCase(),
          treasury.account.address.toLowerCase(),
          `treasury() vaut ${storedTreasury}, attendu ${treasury.account.address}`,
        );
      });

      it("mrn lit bien _mrn, le septieme argument", async function () {
        // Le 8e argument a rejoint le constructeur a I.4 : `address _mrn`, en
        // SEPTIEME position, juste avant `_owner`. Le Pool le fige en immuable
        // et s'en sert comme jeton de versement du loyer LP dans claimRent
        // (Pool.sol). Ce test verifie le cablage : que c'est bien l'adresse
        // MRN passee qui atterrit dans `mrn()`, et pas la tresorerie ou
        // l'owner qui l'encadrent dans la signature.
        const { pool, mrn } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const storedMrn = await pool.read.mrn();
        assert.equal(
          storedMrn.toLowerCase(),
          mrn.address.toLowerCase(),
          `mrn() vaut ${storedMrn}, attendu ${mrn.address}`,
        );
      });

      it("owner() vaut _owner, l'adresse passee a Ownable", async function () {
        // L'owner n'est pas stocke par une ligne de Pool.sol mais par
        // Ownable(_owner) dans l'entete du constructeur (Pool.sol:66). Ce que
        // ce test verifie n'est donc pas le fonctionnement d'Ownable, hors
        // perimetre, mais le cablage : que c'est bien le HUITIEME et dernier
        // argument qui y arrive, et pas msg.sender par defaut ni un autre des
        // huit (notamment pas l'adresse MRN qui le precede desormais).
        const { pool, deployer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const owner = await pool.read.owner();
        assert.equal(
          owner.toLowerCase(),
          deployer.account.address.toLowerCase(),
          `owner() vaut ${owner}, attendu ${deployer.account.address}`,
        );
      });
    });

    describe("B) Valeurs prises sur le bloc de deploiement", function () {
      it("GENESIS vaut le timestamp du bloc de deploiement", async function () {
        // GENESIS ancre le decoupage en epoques de l'enchere (Pool.sol:67) :
        // une valeur nulle ou arbitraire y decalerait toutes les epoques a
        // venir. La valeur attendue est lue sur la chaine, dans le bloc qui a
        // porte le deploiement, et non calculee depuis l'horloge du test.
        const { pool, deploymentTimestamp } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const genesis = await pool.read.GENESIS();
        assert.equal(
          genesis,
          deploymentTimestamp,
          `GENESIS() vaut ${genesis}, attendu ${deploymentTimestamp} (timestamp du bloc de deploiement)`,
        );
      });

      it("GENESIS n'est pas nul", async function () {
        // Assertion volontairement redondante avec la precedente : elle seule
        // survit a l'hypothese ou la lecture du bloc rendrait zero. Sans
        // elle, `GENESIS == deploymentTimestamp` passerait aussi sur un
        // constructeur qui n'affecterait rien du tout.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const genesis = await pool.read.GENESIS();
        assert.ok(
          genesis > 0n,
          `GENESIS() vaut ${genesis}, attendu une valeur strictement positive`,
        );
      });
    });

    describe("C) Etat mutable de depart", function () {
      it("feeNum vaut _nominalFeeNum au deploiement", async function () {
        // Le pool demarre au tarif nominal sans qu'aucun argument dedie ne le
        // dise : feeNum est initialise depuis _nominalFeeNum (Pool.sol:77).
        // C'est la seule des valeurs de cette section qui soit mutable
        // ensuite, par setFee ; ce test fixe son point de depart.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        // feeNum est un uint16 depuis I.1.5 : viem le decode en number, pas en
        // bigint (seuil a 48 bits). L'arithmetique ne bouge pas, seul le type lu.
        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          DEFAULT_FEE_NUM,
          `feeNum() vaut ${feeNum} au deploiement, attendu ${DEFAULT_FEE_NUM} (_nominalFeeNum)`,
        );
      });

      it("feeNum et NOMINAL_FEE_NUM partent egaux", async function () {
        // Formule autrement, sans reference a la constante du test : quelle
        // que soit la valeur passee, le tarif courant part sur le tarif
        // nominal. C'est cette egalite, et non la valeur 5, que setFee fera
        // ensuite diverger.
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const feeNum = BigInt(await pool.read.feeNum());
        const nominalFeeNum = await pool.read.NOMINAL_FEE_NUM();
        assert.equal(
          feeNum,
          nominalFeeNum,
          `feeNum()=${feeNum} et NOMINAL_FEE_NUM()=${nominalFeeNum} devraient partir egaux`,
        );
      });
    });

    describe("D) Le panier de jetons", function () {
      it("token0, token1 et token2 reprennent _tokens dans l'ordre", async function () {
        // Une seule assertion, sur les trois adresses ensemble : ce qui est
        // affirme ici est un ORDRE (indice 0 = WBTC, 1 = cbBTC, 2 = LBTC),
        // et un ordre ne se decompose pas en trois tests independants sans
        // perdre ce qu'il affirme. Toute la suite en depend : les indices
        // passes a swap et a addLiquidity n'ont de sens que par lui.
        const { pool, tokenAddresses } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const stored = [
          await pool.read.token0(),
          await pool.read.token1(),
          await pool.read.token2(),
        ].map((address) => address.toLowerCase());
        const expected = tokenAddresses.map((address) => address.toLowerCase());
        assert.deepEqual(
          stored,
          expected,
          `panier lu=[${stored}], attendu=[${expected}] (indice 0 = WBTC, 1 = cbBTC, 2 = LBTC)`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] Les deux gardes de la bande de frais
  //
  // Les deux require du constructeur (Pool.sol:70-71) bornent le frais
  // EFFECTIF, jamais la base : `base * UNBALANCE_FACTOR <= MAX_FEE_NUM`. Avec
  // MAX_FEE_NUM = 50 et UNBALANCE_FACTOR = 2, la borne des DEUX arguments
  // tombe donc sur 25, pas sur 50. C'est la seule chose que ces gardes
  // disent, et c'est ce que cette section epingle des deux cotes de la
  // frontiere.
  // ---------------------------------------------------------------------------

  describe("II] Les deux gardes de la bande de frais", function () {
    describe("A) FeeTooHigh, la borne de _nominalFeeNum", function () {
      it("_nominalFeeNum = 25 passe : 25 * 2 = 50, exactement MAX_FEE_NUM", async function () {
        // Le require est un <=, pas un < : la base qui touche exactement le
        // plafond une fois doublee est acceptee. Le test ne se contente pas
        // de l'absence de revert, il relit NOMINAL_FEE_NUM : un constructeur
        // qui ecreterait silencieusement la valeur passerait sinon.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(base, MIN_FEE_NUM, MAX_BASE_FEE_NUM);

        const nominalFeeNum = await pool.read.NOMINAL_FEE_NUM();
        assert.equal(
          nominalFeeNum,
          MAX_BASE_FEE_NUM,
          `NOMINAL_FEE_NUM() vaut ${nominalFeeNum}, attendu ${MAX_BASE_FEE_NUM} (derniere base acceptee)`,
        );
      });

      it("_nominalFeeNum = 26 revert : 26 * 2 = 52 > MAX_FEE_NUM", async function () {
        // Un satoshi de base au-dessus de la borne precedente. Les deux `it`
        // pris ensemble situent la frontiere exactement, ce qu'aucun des deux
        // ne fait seul.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, ABOVE_MAX_BASE_FEE_NUM),
          "FeeTooHigh",
        );
      });
    });

    describe("B) EmptyFeeBand, la borne de _minFeeNum", function () {
      it("_minFeeNum = 25 passe : 25 * 2 = 50, exactement MAX_FEE_NUM", async function () {
        // _nominalFeeNum est laisse a la meme valeur, la seule qui satisfasse
        // aussi la premiere garde a cette hauteur : la borne etant commune
        // aux deux arguments, un _nominalFeeNum nominal en dessous ferait ici
        // une bande a l'envers (plancher au-dessus du nominal), etat que le
        // constructeur ne refuse pas mais que ce test n'a aucune raison de
        // fabriquer.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(base, MAX_BASE_FEE_NUM, MAX_BASE_FEE_NUM);

        const minFeeNum = await pool.read.MIN_FEE_NUM();
        assert.equal(
          minFeeNum,
          MAX_BASE_FEE_NUM,
          `MIN_FEE_NUM() vaut ${minFeeNum}, attendu ${MAX_BASE_FEE_NUM} (derniere base acceptee)`,
        );
      });

      it("_minFeeNum = 26 revert : 26 * 2 = 52 > MAX_FEE_NUM", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, ABOVE_MAX_BASE_FEE_NUM, MAX_BASE_FEE_NUM),
          "EmptyFeeBand",
        );
      });
    });

    describe("C) Chaque garde sort SON erreur", function () {
      // Les deux require sont litteralement la meme inegalite sur deux
      // arguments differents (Pool.sol:70-71). Rien dans le code ne garantit
      // donc, a la lecture seule, que l'erreur rendue nomme le bon argument :
      // une interversion des deux noms d'erreur compilerait, passerait les
      // sections A et B si elles n'exigeaient qu'un revert, et enverrait
      // l'operateur corriger le mauvais parametre au deploiement. C'est ce
      // que ces trois cas ferment.
      it("_nominalFeeNum hors borne, _minFeeNum en borne : FeeTooHigh, jamais EmptyFeeBand", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, ABOVE_MAX_BASE_FEE_NUM),
          "FeeTooHigh",
        );
      });

      it("_minFeeNum hors borne, _nominalFeeNum en borne : EmptyFeeBand, jamais FeeTooHigh", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, ABOVE_MAX_BASE_FEE_NUM, DEFAULT_FEE_NUM),
          "EmptyFeeBand",
        );
      });

      it("ordre des gardes : les deux arguments hors borne echouent par FeeTooHigh", async function () {
        // FeeTooHigh est verifie en premier (Pool.sol:70), EmptyFeeBand
        // ensuite (Pool.sol:71) : quand les deux arguments sont fautifs,
        // c'est donc le nominal que l'operateur voit signale. Meme genre de
        // cas que les tests d'ordre des gardes des trois autres suites, et
        // meme utilite : il documente ce que le deploiement rendra
        // reellement, plutot que de laisser croire que les deux erreurs sont
        // interchangeables.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, ABOVE_MAX_BASE_FEE_NUM, ABOVE_MAX_BASE_FEE_NUM),
          "FeeTooHigh",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Les deux gardes de l'horloge d'enchere
  //
  // Elles ne bornent pas une valeur economique mais la COHERENCE du decoupage
  // du temps que currentEpoch() derivera ensuite (Pool.sol:92-94, couvert par
  // test/Pool.currentEpoch.test.ts). Les deux echecs qu'elles ferment sont de
  // nature differente, et c'est ce qui justifie deux erreurs distinctes.
  //
  // _epochDuration = 0 est un contrat MORT : EPOCH_DURATION etant le
  // denominateur de currentEpoch(), toute lecture reverterait en panic 0x12,
  // division par zero. Sans cette garde, le deploiement reussirait et le
  // defaut ne se revelerait qu'au premier appel, sur un immuable qu'aucune
  // fonction ne peut plus corriger.
  //
  // _priorityWindow > _epochDuration est un contrat INCOHERENT plutot que
  // mort : la fenetre pendant laquelle le gestionnaire sortant garde la main
  // couvrirait alors plus que le mandat lui-meme, donc la priorite ne
  // s'eteindrait jamais et l'enchere ne changerait jamais de main. Le
  // deploiement passerait, et le protocole serait fige.
  // ---------------------------------------------------------------------------

  describe("III] Les deux gardes de l'horloge d'enchere", function () {
    describe("A) ZeroEpochDuration, la borne de _epochDuration", function () {
      it("_epochDuration = 0 revert : ZeroEpochDuration", async function () {
        // La fenetre est mise a zero elle aussi, pour que ce cas n'eprouve
        // QUE la premiere garde : avec la fenetre de production (12), la
        // seconde garde serait fautive en meme temps, et c'est le cas
        // d'ordre de la section C, pas celui-ci.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, DEFAULT_FEE_NUM, ZERO_EPOCH_DURATION, ZERO_PRIORITY_WINDOW),
          "ZeroEpochDuration",
        );
      });

      it("_epochDuration = 1 passe : c'est un > 0, pas un seuil de duree", async function () {
        // La garde ne dit rien de la PERTINENCE de la duree, seulement de sa
        // non-nullite : une epoque d'une seconde est un deploiement legitime
        // du point de vue du contrat. Le test relit EPOCH_DURATION plutot que
        // de constater l'absence de revert, un constructeur qui remplacerait
        // silencieusement la valeur par un plancher passerait sinon.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(
          base,
          MIN_FEE_NUM,
          DEFAULT_FEE_NUM,
          MIN_EPOCH_DURATION,
          MIN_EPOCH_DURATION, // 1 <= 1, la seconde garde passe de justesse
        );

        const epochDuration = await pool.read.EPOCH_DURATION();
        assert.equal(
          epochDuration,
          MIN_EPOCH_DURATION,
          `EPOCH_DURATION() vaut ${epochDuration}, attendu ${MIN_EPOCH_DURATION} (plus petite duree acceptee)`,
        );
      });
    });

    describe("B) PriorityWindowTooLong, la borne de _priorityWindow", function () {
      it("_priorityWindow = EPOCH_DURATION passe : le require est un <=", async function () {
        // La frontiere, et le seul cas ou les deux valeurs coincident. Une
        // fenetre egale a l'epoque signifie que le gestionnaire sortant garde
        // la priorite jusqu'a la derniere seconde de son mandat, ce que le
        // contrat autorise. Calcul a la main : 14400 <= 14400.
        // Le test relit PRIORITY_WINDOW : la seule absence de revert ne
        // distinguerait pas ce deploiement d'un ecretage silencieux.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(
          base,
          MIN_FEE_NUM,
          DEFAULT_FEE_NUM,
          EPOCH_DURATION,
          EPOCH_DURATION,
        );

        const priorityWindow = await pool.read.PRIORITY_WINDOW();
        assert.equal(
          priorityWindow,
          EPOCH_DURATION,
          `PRIORITY_WINDOW() vaut ${priorityWindow}, attendu ${EPOCH_DURATION} (derniere fenetre acceptee)`,
        );
      });

      it("_priorityWindow = EPOCH_DURATION + 1 revert : PriorityWindowTooLong", async function () {
        // Une seconde au-dessus de la borne precedente. Les deux `it` pris
        // ensemble situent la frontiere exactement, ce qu'aucun des deux ne
        // fait seul. Calcul a la main : 14401 > 14400.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, DEFAULT_FEE_NUM, EPOCH_DURATION, ABOVE_EPOCH_DURATION),
          "PriorityWindowTooLong",
        );
      });

      it("_priorityWindow = 0 passe : la garde n'a pas de borne basse", async function () {
        // Le pendant du cas precedent de l'autre cote. Une fenetre nulle est
        // un deploiement legitime, celui ou le gestionnaire sortant n'a
        // aucune priorite : l'enchere est alors ouverte a tous des la
        // premiere seconde de chaque epoque. Calcul a la main : 0 <= 14400.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(
          base,
          MIN_FEE_NUM,
          DEFAULT_FEE_NUM,
          EPOCH_DURATION,
          ZERO_PRIORITY_WINDOW,
        );

        const priorityWindow = await pool.read.PRIORITY_WINDOW();
        assert.equal(
          priorityWindow,
          ZERO_PRIORITY_WINDOW,
          `PRIORITY_WINDOW() vaut ${priorityWindow}, attendu ${ZERO_PRIORITY_WINDOW} (fenetre nulle, autorisee)`,
        );
      });
    });

  // ---------------------------------------------------------------------------
  // V] I.7 #3 — Garde d'adresse nulle sur les jetons du panier
  //
  // La garde de deploiement `token0 != address(0) && token1 != address(0)
  // && token2 != address(0)` (Pool.sol, en amont de la garde de doublons
  // et de decimales) sort `InvalidTokenAddress` : sans elle, `decimals()`
  // reverterait en panic 0x21 (appel sur adresse nulle ERC-20), et le
  // deployer verrait un revert sans cause lisible. L'ordre des trois
  // gardes d'adresse nulle (token0/1/2) -> doublons -> MRN -> decimales
  // tient : un panier a zeros ne traverse pas la garde de doublons.
  // ---------------------------------------------------------------------------

  describe("V] I.7 #3 — garde d'adresse nulle sur les jetons", function () {
    describe("A) Un token nul parmi trois : InvalidTokenAddress", function () {
      it("token0 = address(0) revert : InvalidTokenAddress", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);
        await assertDeployRevertsWithCustomError(
          viem.deployContract("Pool", [
            ["0x0000000000000000000000000000000000000000", base.tokenAddresses[1], base.tokenAddresses[2]],
            EPOCH_DURATION,
            PRIORITY_WINDOW,
            MIN_FEE_NUM,
            DEFAULT_FEE_NUM,
            base.treasury.account.address,
            base.mrn.address,
            base.deployer.account.address,
          ]),
          "InvalidTokenAddress",
        );
      });

      it("token1 = address(0) revert : InvalidTokenAddress", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);
        await assertDeployRevertsWithCustomError(
          viem.deployContract("Pool", [
            [base.tokenAddresses[0], "0x0000000000000000000000000000000000000000", base.tokenAddresses[2]],
            EPOCH_DURATION,
            PRIORITY_WINDOW,
            MIN_FEE_NUM,
            DEFAULT_FEE_NUM,
            base.treasury.account.address,
            base.mrn.address,
            base.deployer.account.address,
          ]),
          "InvalidTokenAddress",
        );
      });

      it("token2 = address(0) revert : InvalidTokenAddress", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);
        await assertDeployRevertsWithCustomError(
          viem.deployContract("Pool", [
            [base.tokenAddresses[0], base.tokenAddresses[1], "0x0000000000000000000000000000000000000000"],
            EPOCH_DURATION,
            PRIORITY_WINDOW,
            MIN_FEE_NUM,
            DEFAULT_FEE_NUM,
            base.treasury.account.address,
            base.mrn.address,
            base.deployer.account.address,
          ]),
          "InvalidTokenAddress",
        );
      });
    });

    describe("B) Panier nominal, le deployement reussit", function () {
      it("trois jetons non nuls passent la garde d'adresse", async function () {
        // La fixture nominale deployePoolWith(deployTokensFixture, ...)
        // couvre deja ce cas, mais on l'asserte explicitement ici pour
        // que la section V] soit autonome : la garde est satisfaite,
        // les trois adresses distinctes passent.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(base, MIN_FEE_NUM, DEFAULT_FEE_NUM);

        const t0 = (await pool.read.token0()).toLowerCase();
        const t1 = (await pool.read.token1()).toLowerCase();
        const t2 = (await pool.read.token2()).toLowerCase();
        assert.notEqual(t0, "0x0000000000000000000000000000000000000000", "token0 nul apres deployement");
        assert.notEqual(t1, "0x0000000000000000000000000000000000000000", "token1 nul apres deployement");
        assert.notEqual(t2, "0x0000000000000000000000000000000000000000", "token2 nul apres deployement");
      });
    });
  });

  describe("III.C) Chaque garde sort SON erreur, plusieurs arguments fautifs a la fois", function () {
      // Meme argument qu'a la section II.C, et meme necessite. Les quatre
      // require du constructeur se suivent (Pool.sol:70-73) et rendent quatre
      // erreurs sans argument : rien, a la lecture seule, ne garantit que
      // celle qui sort nomme le bon parametre. Une interversion compilerait,
      // passerait des tests qui n'exigeraient qu'un revert, et enverrait
      // l'operateur corriger la mauvaise valeur au deploiement — sur un
      // contrat dont ces quatre valeurs sont immuables.
      //
      // Les cas a UN seul argument fautif sont deja tenus par les sections A
      // et B : leurs deux `it` de revert decodent le nom de l'erreur, ils
      // affirment donc bien "ZeroEpochDuration ET PAS autre chose". Les
      // reprendre ici a l'identique n'ajouterait rien. Ce que cette section
      // ferme est le cas ou PLUSIEURS arguments sont hors borne en meme
      // temps, ou le nom rendu depend de l'ordre des require et de rien
      // d'autre.
      it("les deux arguments d'horloge fautifs echouent par ZeroEpochDuration, jamais PriorityWindowTooLong", async function () {
        // _epochDuration = 0 avec _priorityWindow = 12 rend les DEUX gardes
        // fautives a la fois : la duree est nulle, et 12 > 0 viole aussi la
        // seconde. ZeroEpochDuration est verifiee en premier (Pool.sol:72
        // avant 73), c'est donc elle que l'operateur voit — et c'est la bonne,
        // corriger la fenetre ne sauverait pas un contrat dont currentEpoch()
        // diviserait par zero.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, DEFAULT_FEE_NUM, ZERO_EPOCH_DURATION, PRIORITY_WINDOW),
          "ZeroEpochDuration",
        );
      });

      it("une bande de frais fautive ET une horloge fautive echouent par FeeTooHigh", async function () {
        // Les deux gardes de frais precedent les deux gardes d'horloge dans
        // le corps du constructeur (Pool.sol:70-71 avant 72-73). Ce cas
        // etablit l'ordre ENTRE les deux paires, ce qu'aucun des tests de la
        // section II.C ni des trois cas ci-dessus ne fait : eux comparent
        // deux gardes voisines, celui-ci compare les deux familles.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        await assertDeployRevertsWithCustomError(
          deployPoolWith(base, MIN_FEE_NUM, ABOVE_MAX_BASE_FEE_NUM, ZERO_EPOCH_DURATION, PRIORITY_WINDOW),
          "FeeTooHigh",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // IV] Cas limites
  // ---------------------------------------------------------------------------

  describe("IV] Cas limites", function () {
    describe("A) Frais nuls, acceptes deliberement", function () {
      // Ni l'une ni l'autre garde n'a de borne basse : 0 * 2 = 0 <= 50, les
      // deux passent. Ce n'est pas un oubli. Une partie de la suite existante
      // (deployZeroFeeTokensAndPoolFixture dans trois des quatre fichiers)
      // deploie a frais nul pour isoler l'arithmetique du produit constant du
      // bruit du frais : sans ce zero, les valeurs posees a la main dans ces
      // tests devraient toutes absorber une troncature supplementaire.
      it("_nominalFeeNum = 0 deploie, et feeNum part a zero", async function () {
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(base, ZERO_FEE_NUM, ZERO_FEE_NUM);

        const feeNum = BigInt(await pool.read.feeNum());
        assert.equal(
          feeNum,
          ZERO_FEE_NUM,
          `feeNum() vaut ${feeNum} sur un pool deploye a frais nul, attendu ${ZERO_FEE_NUM}`,
        );
      });

      it("_minFeeNum = 0 deploie, et MIN_FEE_NUM vaut zero", async function () {
        // Le plancher de la bande peut donc etre nul tout en laissant un
        // nominal strictement positif : la bande [0, 5] est un etat legitime
        // du contrat, et c'est celui qu'exercent les fixtures a frais nul
        // apres un setFee.
        const base = await networkHelpers.loadFixture(deployTokensFixture);

        const pool = await deployPoolWith(base, ZERO_FEE_NUM, DEFAULT_FEE_NUM);

        const minFeeNum = await pool.read.MIN_FEE_NUM();
        assert.equal(
          minFeeNum,
          ZERO_FEE_NUM,
          `MIN_FEE_NUM() vaut ${minFeeNum} sur un pool deploye a plancher nul, attendu ${ZERO_FEE_NUM}`,
        );
      });
    });

    describe("B) treasury et owner sont deux roles distincts", function () {
      // Le constructeur prend les deux separement (Pool.sol:64-65). Rien ne
      // les empeche d'etre confondus en production, mais la fixture les
      // separe exactement pour que les tests ci-dessus prouvent quelque
      // chose : sur un deploiement ou treasury == owner, une affectation
      // croisee entre les deux passerait inapercue.
      it("la fixture donne bien deux adresses differentes a treasury et a owner", async function () {
        const { pool } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const storedTreasury = (await pool.read.treasury()).toLowerCase();
        const owner = (await pool.read.owner()).toLowerCase();
        assert.notEqual(
          storedTreasury,
          owner,
          `treasury()=${storedTreasury} et owner()=${owner} sont confondus : le test de cablage ne prouverait plus rien`,
        );
      });

      it("treasury n'est aucune des autres adresses de la fixture", async function () {
        // Les quatre comptes de la fixture sont deployer, depositor, other et
        // treasury, dans cet ordre. Verifier que treasury() n'est aucun des
        // trois premiers ferme les affectations croisees que la seule
        // comparaison a l'owner laisserait passer.
        const { pool, deployer, depositor, other } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        const storedTreasury = (await pool.read.treasury()).toLowerCase();
        const forbidden = [deployer, depositor, other].map((client) =>
          client.account.address.toLowerCase(),
        );
        assert.ok(
          !forbidden.includes(storedTreasury),
          `treasury()=${storedTreasury} coincide avec l'un des trois autres comptes de la fixture [${forbidden}]`,
        );
      });
    });
  });
});
