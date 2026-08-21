// Suite fonctionnelle TypeScript pour Pool.pause() / Pool.unpause() et pour
// l'effet de l'etat mis en pause sur les points d'entree du pool.
//
// Pourquoi un fichier a part plutot que des sections ajoutees aux trois
// autres : ce que cette suite verifie n'est pas une formule mais une phrase,
// "en pause on n'entre plus et on sort toujours". Eclatee entre
// addLiquidity, removeLiquidity et swap, cette promesse devient invisible :
// chaque fichier n'en montrerait qu'un tiers, et le fait que removeLiquidity
// reste ouvert quand les deux autres ferment ne se lirait nulle part.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : le parcours change de
// nature par rapport aux trois autres fonctions. Il n'y a ni token a
// approuver ni montant a transferer sur pause() et unpause(), seulement un
// appelant et un droit. Ce qui se verifie a travers l'ABI est donc un
// controle d'acces exerce depuis deux comptes distincts (l'owner du
// deploiement et un tiers), puis l'effet de l'etat mis en pause sur les
// fonctions d'entree appelees exactement comme le front les appelle.
//
// Perimetre : on teste ce que Pool.sol DECIDE, jamais ce qu'OpenZeppelin
// EXECUTE. Sont donc volontairement absents de ce fichier : repauser une
// pool deja en pause (EnforcedPause), depauser une pool qui ne l'est pas
// (ExpectedPause), et l'emission des evenements Paused / Unpaused. Ces trois
// comportements viennent du modifieur et des fonctions internes d'OZ, pas
// d'une ligne de Pool.sol. En revanche "l'owner appelle pause(), puis
// paused() vaut true" est bien teste (section I.B) : c'est la seule
// assertion qui distingue une fonction externe reellement branchee sur
// _pause() d'une fonction au corps vide, laquelle passerait sans elle toute
// la suite. Meme raison pour onlyOwner sur les deux leviers, et meme raison
// pour toute la section II, qui ne verifie pas le fonctionnement du
// modifieur mais le CHOIX des fonctions sur lesquelles il est pose.
//
// Voir test/README.md pour la demarche complete, la liste des cas limites
// groupee par fonction, et pourquoi les fixtures ci-dessous sont dupliquees
// depuis Pool.addLiquidity.test.ts / Pool.removeLiquidity.test.ts /
// Pool.swap.test.ts plutot que partagees.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const DEFAULT_FEE_NUM = 5n; // reprend la valeur du Pool.t.sol d'origine
const MIN_SET_FEE_DELAY = 24n * 60n * 60n; // 1 days, Pool.sol:24
// Sur les fixtures de cette suite, les reserves valent au plus 1e10 : aucun
// amountOut ne peut donc jamais atteindre UINT72_MAX, ce qui en fait un
// _minOut insatisfaisable par construction. C'est ce qui rend le test
// d'ordre des gardes (section II.B) probant : sans la pause, le meme appel
// echouerait sur BadSlippage.
const UINT72_MAX = 2n ** 72n - 1n;

// ---------------------------------------------------------------------------
// Fixtures et helpers
//
// Dupliquees depuis Pool.swap.test.ts, deliberement. Ce fichier ouvre sa
// propre connexion reseau via network.create() : la partager avec les autres
// fichiers de test reviendrait a partager l'etat blockchain et le cache de
// loadFixture entre des fichiers qui tournent independamment, ce qui est
// fragile (voir test/README.md pour la discussion complete).
// ---------------------------------------------------------------------------

async function deployTokensAndPool(feeNum: bigint) {
  const [deployer, depositor, other] = await viem.getWalletClients();

  const tbtc = await viem.deployContract("MockWrappedBTC", ["Threshold BTC", "tBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [tbtc, cbbtc, lbtc] as const;

  // Le troisieme argument du constructeur est le _feeSetter, qui devient
  // l'owner (Ownable(_feeSetter), Pool.sol:40) : dans toute cette suite,
  // `deployer` est donc l'owner, et `other` le tiers non autorise.
  const pool = await viem.deployContract("Pool", [
    [tbtc.address, cbbtc.address, lbtc.address],
    feeNum,
    deployer.account.address,
  ]);

  return { deployer, depositor, other, tbtc, cbbtc, lbtc, tokens, pool };
}

async function deployTokensAndPoolFixture() {
  return deployTokensAndPool(DEFAULT_FEE_NUM);
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Mint `amount` des 3 tokens vers `account` et approuve le pool pour ce meme
// montant sur chacun : c'est le parcours d'un deposant, addLiquidity exigeant
// bien les trois approves (trois transferFrom entrants, Pool.sol:108).
async function mintAndApprove(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["depositor"],
  amount: bigint,
) {
  for (const token of tokens) {
    await token.write.mint([account.account.address, amount]);
    await token.write.approve([pool.address, amount], { account: account.account });
  }
}

// Mint `amount` d'UN SEUL token (celui d'indice `tokenIndex`) vers `account`
// et approuve le pool pour ce meme montant sur ce seul token : c'est le
// parcours reel d'un swapper, swap() ne faisant qu'un seul transferFrom
// entrant, sur le token d'indice _indexIn.
async function mintAndApproveSingleToken(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["other"],
  tokenIndex: 0 | 1 | 2,
  amount: bigint,
) {
  await tokens[tokenIndex].write.mint([account.account.address, amount]);
  await tokens[tokenIndex].write.approve([pool.address, amount], { account: account.account });
}

async function readReserves(pool: PoolFixture["pool"]): Promise<[bigint, bigint, bigint]> {
  return [
    await pool.read.reserves([0n]),
    await pool.read.reserves([1n]),
    await pool.read.reserves([2n]),
  ];
}

async function readBalances(
  tokens: PoolFixture["tokens"],
  address: `0x${string}`,
): Promise<[bigint, bigint, bigint]> {
  return [
    await tokens[0].read.balanceOf([address]),
    await tokens[1].read.balanceOf([address]),
    await tokens[2].read.balanceOf([address]),
  ];
}

const SEED_AMOUNT = 100n * 10n ** 8n; // pool amorce a 100 (8 decimales) sur chaque reserve

async function deploySeededPoolFixture() {
  const base = await deployTokensAndPoolFixture();
  const { depositor, tokens, pool } = base;

  // Marge genereuse pour les depots additionnels effectues dans les tests qui
  // reutilisent cette fixture.
  const headroom = SEED_AMOUNT * 10n;
  await mintAndApprove(tokens, pool, depositor, headroom);

  await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

  return { ...base, seedAmount: SEED_AMOUNT };
}

// Pool tout juste deploye, jamais amorce, mis en pause par son owner.
async function deployPausedPoolFixture() {
  const base = await deployTokensAndPoolFixture();
  await base.pool.write.pause({ account: base.deployer.account });
  return base;
}

// Pool amorce a 100 sur chaque reserve, puis mis en pause par son owner :
// c'est l'etat de depart de toute la section II et de la section III.
async function deployPausedSeededPoolFixture() {
  const base = await deploySeededPoolFixture();
  await base.pool.write.pause({ account: base.deployer.account });
  return base;
}

// Etat du pool amorce, commun a toutes les fixtures ci-dessus :
//   addLiquidity([0, 1e10, 0]) sur un pool vide mint 3 * 1e10 - 1000 parts au
//   deposant et 1000 (MINIMUM_LIQUIDITY) a l'adresse morte, soit
//   totalSupply = 30 000 000 000, et reserves = [1e10, 1e10, 1e10].

// Parts brulees par le test de retrait en pause (section II.C) : 10% du
// totalSupply du pool amorce. Choisi parce qu'il divise proprement.
const BURN_AMOUNT = (3n * SEED_AMOUNT) / 10n; // 3 000 000 000
// Calcul a la main (reserves = [1e10, 1e10, 1e10], totalSupply = 3e10) :
//   amountsOut[i] = reserves[i] * _burnedShares / totalSupply
//                 = 1e10 * 3e9 / 3e10
//                 = 1 000 000 000
// Aucune troncature : la division tombe juste sur les trois tokens.
const EXPECTED_AMOUNTS_OUT_WHILE_PAUSED: [bigint, bigint, bigint] = [
  1_000_000_000n,
  1_000_000_000n,
  1_000_000_000n,
];

// _amount du swap nominal de la section III : 10% de SEED_AMOUNT.
const NOMINAL_SWAP_AMOUNT_IN = SEED_AMOUNT / 10n; // 1 000 000 000
// Calcul a la main (feeNum = 5, reserves = [1e10, 1e10, 1e10]) :
//   amountAfterFee = 1e9 * (1000 - 5) / 1000 = 995 000 000
//   amountOut = 995 000 000 * 1e10 / (995 000 000 + 1e10)
//             = 9 950 000 000 000 000 000 / 10 995 000 000
//             = 904 956 798 (tronque vers le bas)
// C'est exactement la valeur attendue sur une pool jamais mise en pause
// (elle est posee a l'identique dans Pool.swap.test.ts) : la retrouver apres
// un cycle pause / unpause est precisement ce que la section III affirme.
const NOMINAL_SWAP_AMOUNT_OUT = 904_956_798n;

// _amount du depot nominal de la section III : 10% de SEED_AMOUNT, ancre sur
// token0.
const NOMINAL_DEPOSIT_AMOUNT = SEED_AMOUNT / 10n; // 1 000 000 000
// Calcul a la main (reserves = [1e10, 1e10, 1e10], totalSupply = 3e10,
// ancre = 0) :
//   mintedShares = totalSupply * _amount / reserves[0]
//                = 3e10 * 1e9 / 1e10
//                = 3 000 000 000
const NOMINAL_MINTED_SHARES = 3_000_000_000n;

// Nouveau taux pose par le test de setFee en pause (section II.D),
// different de DEFAULT_FEE_NUM pour que l'assertion ait quelque chose a
// distinguer, et sous MAX_FEE_NUM (10, Pool.sol:20).
const NEW_FEE_NUM = 7n;

describe("Pool.pause", async function () {

  // ---------------------------------------------------------------------------
  // I] pause et unpause
  // ---------------------------------------------------------------------------

  describe("I] pause et unpause", function () {
    describe("A) Controle d'acces", function () {
      it("un tiers appelle pause() : OwnableUnauthorizedAccount", async function () {
        // onlyOwner sur pause() est un choix de Pool.sol (Pool.sol:62), pas un
        // comportement herite passivement : c'est a ce titre qu'il est teste.
        const { pool, other } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.pause({ account: other.account }),
          pool,
          "OwnableUnauthorizedAccount",
        );
      });

      it("un tiers appelle unpause() sur une pool mise en pause par l'owner : OwnableUnauthorizedAccount", async function () {
        // Cas symetrique du precedent, et le plus important des deux du point
        // de vue du protocole : si unpause() n'etait pas garde, n'importe qui
        // pourrait rouvrir la pool au milieu de l'incident qui a motive sa
        // fermeture.
        const { pool, other } = await networkHelpers.loadFixture(deployPausedPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.unpause({ account: other.account }),
          pool,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("B) Cablage sur l'etat OZ", function () {
      it("l'owner appelle pause() : paused() vaut true", async function () {
        // Seule assertion de la suite qui distingue une fonction externe
        // reellement branchee sur _pause() d'une fonction au corps vide :
        // sans elle, `function pause() external onlyOwner {}` passerait le
        // controle d'acces ci-dessus, et toute la section II echouerait sans
        // qu'on sache pourquoi.
        const { pool, deployer } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);

        await pool.write.pause({ account: deployer.account });

        const paused = await pool.read.paused();
        assert.equal(paused, true, `paused() vaut ${paused} apres pause(), attendu true`);
      });

      it("l'owner appelle unpause() apres pause() : paused() revient a false", async function () {
        const { pool, deployer } = await networkHelpers.loadFixture(deployPausedPoolFixture);

        await pool.write.unpause({ account: deployer.account });

        const paused = await pool.read.paused();
        assert.equal(paused, false, `paused() vaut ${paused} apres unpause(), attendu false`);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] Effet sur les points d'entree, pool en pause
  //
  // Cette section ne verifie pas le fonctionnement du modifieur whenNotPaused,
  // qui appartient a OZ, mais le choix des fonctions sur lesquelles Pool.sol
  // l'a pose : addLiquidity et swap (Pool.sol:79 et 129) le portent,
  // removeLiquidity et setFee non, et ces deux absences sont deliberees.
  // ---------------------------------------------------------------------------

  describe("II] Effet sur les points d'entree, pool en pause", function () {
    describe("A) addLiquidity refuse", function () {
      it("addLiquidity sur pool vierge en pause : EnforcedPause", async function () {
        // Le deposant est mint et approuve avant l'appel : sans la pause, ce
        // depot amorcerait la pool. C'est bien la pause qui le refuse, pas
        // une allowance manquante.
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployPausedPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account }),
          pool,
          "EnforcedPause",
        );
      });

      it("addLiquidity sur pool amorcee en pause : EnforcedPause", async function () {
        // La branche supply == 0 et la branche supply > 0 d'addLiquidity sont
        // deux chemins distincts (Pool.sol:84 et 93) ; le modifieur est pose
        // sur la fonction, donc en amont des deux, et les deux cas le
        // verifient separement. Le deposant garde ici de quoi deposer : la
        // fixture amorcee lui a mint et approuve dix fois SEED_AMOUNT.
        const { pool, depositor } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, NOMINAL_DEPOSIT_AMOUNT, 0n], { account: depositor.account }),
          pool,
          "EnforcedPause",
        );
      });
    });

    describe("B) swap refuse", function () {
      it("swap sur pool amorcee en pause : EnforcedPause", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account }),
          pool,
          "EnforcedPause",
        );
      });

      it("ordre des gardes : un swap en pause avec un _minOut inatteignable echoue par EnforcedPause, jamais par BadSlippage", async function () {
        // Un modifieur n'est pas un require place avant la fonction : c'est un
        // corps dans lequel le compilateur inline le corps de la fonction
        // decoree, a l'emplacement du `_;`. Tout ce qui precede ce `_;`
        // s'execute donc en premier, et whenNotPaused preempte integralement
        // les gardes du corps : BadSlippage, ZeroOutput, les erreurs ERC-20 et
        // jusqu'aux panics d'index hors bornes. Un seul cas suffit a etablir
        // la preemption, celui-ci : _minOut = UINT72_MAX est insatisfaisable
        // par construction sur ce pool (les reserves valent 1e10, aucun
        // amountOut ne peut les depasser), donc sans la pause cet appel
        // echouerait sur BadSlippage (Pool.sol:139).
        //
        // Ce test appartient a la section B) plutot qu'a une section propre :
        // c'est un swap, et l'arborescence de test/README.md arrete la
        // section II a D).
        const { pool, tokens, other } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
        await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);

        await viem.assertions.revertWithCustomError(
          pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, UINT72_MAX], { account: other.account }),
          pool,
          "EnforcedPause",
        );
      });
    });

    describe("C) removeLiquidity accepte", function () {
      // C'est la promesse centrale de la pause : on n'entre plus, mais on sort
      // toujours. Les deux tests ci-dessous ne se contentent donc jamais de
      // constater l'absence de revert, ce qu'une fonction au corps vide
      // satisferait aussi : ils portent sur les montants reellement recus,
      // puis sur les reserves apres coup.
      it("un LP brule des parts en pause : les trois montants attendus arrivent bien sur son solde", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
        const balancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const balancesAfter = await readBalances(tokens, depositor.account.address);
        const received = balancesBefore.map((before, i) => balancesAfter[i] - before);
        assert.deepEqual(
          received,
          EXPECTED_AMOUNTS_OUT_WHILE_PAUSED,
          `recu en pause=[${received}], attendu=[${EXPECTED_AMOUNTS_OUT_WHILE_PAUSED}] (10% de chaque reserve)`,
        );
      });

      it("le meme retrait fait baisser les trois reserves exactement de ces montants", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
        const reservesBefore = await readReserves(pool);

        await pool.write.removeLiquidity([BURN_AMOUNT, [0n, 0n, 0n]], { account: depositor.account });

        const reservesAfter = await readReserves(pool);
        const reserveDrop = reservesBefore.map((before, i) => before - reservesAfter[i]);
        assert.deepEqual(
          reserveDrop,
          EXPECTED_AMOUNTS_OUT_WHILE_PAUSED,
          `baisse des reserves=[${reserveDrop}], attendu=[${EXPECTED_AMOUNTS_OUT_WHILE_PAUSED}] : la comptabilite interne doit suivre les tokens reellement sortis`,
        );
      });
    });

    describe("D) setFee reste appelable", function () {
      it("l'owner appelle setFee en pause : l'appel passe et feeNum prend la nouvelle valeur", async function () {
        // Choix delibere : la pause sert a preparer la reprise, et bloquer
        // setFee forcerait a depauser d'abord puis fixer le taux ensuite,
        // laissant une fenetre ou la pool rouvre au taux que la crise a rendu
        // inadapte.
        //
        // Le delai de setFee (MIN_SET_FEE_DELAY, Pool.sol:56) court sur
        // block.timestamp et lastFeeUpdate est initialise a la construction :
        // il faut donc avancer le temps avant l'appel, sinon ce test echoue
        // sur FeeUpdateTooSoon et ne prouve plus rien sur la pause. C'est
        // aussi la contrepartie a connaitre de ce choix de conception : le
        // delai tourne pendant la pause, donc consommer le droit la veille de
        // la reprise le rend indisponible pour les vingt-quatre heures qui
        // suivent la reouverture.
        const { pool, deployer } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
        await networkHelpers.time.increase(Number(MIN_SET_FEE_DELAY));

        await pool.write.setFee([NEW_FEE_NUM], { account: deployer.account });

        const feeNum = await pool.read.feeNum();
        assert.equal(
          feeNum,
          NEW_FEE_NUM,
          `feeNum vaut ${feeNum} apres un setFee en pause, attendu ${NEW_FEE_NUM}`,
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // III] Retour a l'etat normal apres unpause
  //
  // La pause ne laisse aucune trace dans l'etat : apres unpause(), les deux
  // fonctions qu'elle fermait rendent exactement les montants qu'elles
  // rendent sur une pool jamais mise en pause. Les valeurs attendues sont
  // posees en dur avec leur calcul a la main plus haut, et NON recalculees en
  // JavaScript depuis la formule du contrat.
  // ---------------------------------------------------------------------------

  describe("III] Retour a l'etat normal apres unpause", function () {
    it("apres unpause(), un swap nominal rend exactement le montant qu'il rend sur une pool jamais mise en pause", async function () {
      const { pool, tokens, deployer, other } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
      await pool.write.unpause({ account: deployer.account });
      await mintAndApproveSingleToken(tokens, pool, other, 0, NOMINAL_SWAP_AMOUNT_IN);
      const balanceBefore = await tokens[2].read.balanceOf([other.account.address]);

      await pool.write.swap([0n, NOMINAL_SWAP_AMOUNT_IN, 2n, 0n], { account: other.account });

      const balanceAfter = await tokens[2].read.balanceOf([other.account.address]);
      const received = balanceAfter - balanceBefore;
      assert.equal(
        received,
        NOMINAL_SWAP_AMOUNT_OUT,
        `swap 0 -> 2 apres unpause : recu=${received}, attendu=${NOMINAL_SWAP_AMOUNT_OUT} (la valeur d'une pool jamais mise en pause)`,
      );
    });

    it("apres unpause(), un addLiquidity nominal mint exactement les parts attendues", async function () {
      const { pool, tokens, deployer, other } = await networkHelpers.loadFixture(deployPausedSeededPoolFixture);
      await pool.write.unpause({ account: deployer.account });
      await mintAndApprove(tokens, pool, other, NOMINAL_DEPOSIT_AMOUNT);

      await pool.write.addLiquidity([0n, NOMINAL_DEPOSIT_AMOUNT, 0n], { account: other.account });

      // `other` n'a jamais detenu de part LP avant cet appel : son solde apres
      // coup est donc exactement ce que ce depot a minte.
      const mintedShares = await pool.read.balanceOf([other.account.address]);
      assert.equal(
        mintedShares,
        NOMINAL_MINTED_SHARES,
        `depot ancre sur token0 apres unpause : parts mintees=${mintedShares}, attendu=${NOMINAL_MINTED_SHARES}`,
      );
    });
  });
});
