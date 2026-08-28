// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";
import {MockWrappedBTC} from "../contracts/MockWrappedBTC.sol";

// Couche Solidity de l'etape I.2 : les bornes croisees-multipliees et
// l'invariant de conservation des frais.
//
// Ce fichier se divise en quatre sections, dans l'ordre ou elles ont ete
// ajoutees au fur et a mesure que la migration I.2 a progresse :
//
//   I]   Bornes croisees-multipliees (test 5.2.4 + 10d)
//   II]  Deploiement avec FEE_DEN non divisible (test 10e)
//   III] Invariant I1 — les soldes ERC-20 du pool couvrent toujours les
//         reserves plus les deux registres de frais (build-auction.md 7.2
//         I1, etape 8)
//   IV]  Migrations FEE_DEN — la derive du floor porte son unite (10e
//         partie 2)
//
// Le contexte de chaque section est dans son entete.

abstract contract FeeSplitTestBase is Test, PoolTestBase {

  // Le gestionnaire des mandats de ce fichier. Une adresse posee,
  // distincte d'address(this) (le contrat de test est l'owner du pool,
  // et confondre les deux ferait passer la garde d'acces de setFee
  // pour la mauvaise raison — voir Pool.setFee.t.sol pour la
  // justification complete).
  address internal constant MANAGER = address(uint160(0xA11CE));

  function _warpTo(uint256 epoch, uint256 offset) internal {
    vm.warp(pool.GENESIS() + epoch * pool.EPOCH_DURATION() + offset);
  }

  // Seed a 1e10 sur chaque jambe. C'est la valeur de toutes les autres
  // suites TypeScript (SEED_AMOUNT = 100e8 = 1e10), et la condition
  // minimale pour que les swaps ci-dessous restent dans les bandes.
  function _seedBalancedPool() internal {
    pool.addLiquidity(0, 1e10, 0);
  }

  // _seedSkewedPool desequilibre la pool par un swap prealable qui reste
  // dans les bandes. Le swap va de token0 vers token2, ce qui rend
  // token0 abondant et token2 rare. Reserves finales approx
  // [1.21e10, 1e10, 0.79e10], toutes dans la bande 13-53 %.
  function _seedSkewedPool() internal {
    pool.addLiquidity(0, 1e10, 0);
    pool.swap(0, 1e9, 2, 0);
  }

  // Pose un gestionnaire pour le mandat `epoch`, transporte l'horloge
  // au debut de ce mandat, et appelle setFee(feeNum) si feeNum != 0.
  function _setManagerAndSetFee(uint256 epoch, uint256 feeNum) internal {
    pool.setManager(epoch, MANAGER);
    _warpTo(epoch, 0);
    if (feeNum > 0) {
      vm.prank(MANAGER);
      pool.setFee(feeNum);
    }
  }
}

// ---------------------------------------------------------------------------
// I] Bornes croisees-multipliees (test 5.2.4 + 10d)
//
// Trois bornes vivent dans le contrat, et chacune est codee en dur dans
// sa propre unite (FEE_NUM sur FEE_DEN, TOL_BPS sur TOL_DEN, BPS sur
// 10000). Les tests suivants affirment l'INDEPENDANCE de ces unites en
// montrant que les produits croises ne se telescopent pas : un 50 bp
// (MAX_FEE_NUM * 10000) ne donne pas le meme resultat qu'un 50 bp
// (MAX_FEE_NUM * FEE_DEN). Si une unite etait silencieusement
// remplacee par une autre, un de ces tests tomberait. C'est aussi le
// garde-fou contre une refactorisation future qui chercherait a
// factoriser les denominateurs.
// ---------------------------------------------------------------------------

contract FeeSplitBoundednessTest is FeeSplitTestBase {

  function test_MaxFeeNumAsBpsEqualsFiftyBps() public view {
    // 50 bp en valeur absolue, sur FEE_DEN. MAX_FEE_NUM = 50, FEE_DEN =
    // 10000, donc 50 * 10000 = 5e5 = 50 * FEE_DEN. Le plafond du
    // protocole est bien 0,50 % du swapper, jamais davantage.
    assertEq(
      pool.MAX_FEE_NUM() * 10000,
      50 * pool.FEE_DEN(),
      "MAX_FEE_NUM * 10000 doit valoir 50 * FEE_DEN (MAX_FEE_NUM est code en bp, pas en fraction de FEE_DEN)"
    );
  }

  function test_MinFeeNumAsBpsEqualsOneBp() public view {
    // 1 bp en valeur absolue, sur FEE_DEN. MIN_FEE_NUM est pose a la
    // construction, et le test Pool.constructor.test.ts II.B epingle
    // deja que _minFeeNum = 1 est accepte. Le present test fixe la
    // MEME borne du point de vue de l'unite, en montrant que le contrat
    // n'a pas re-echelle la bande pour economiser un mot de storage.
    assertEq(
      pool.MIN_FEE_NUM() * 10000,
      1 * pool.FEE_DEN(),
      "MIN_FEE_NUM * 10000 doit valoir 1 * FEE_DEN (1 bp code en dur, jamais 0)"
    );
  }

  function test_UnbalanceTolBpsTimes10000EqualsTwoHundredTps() public view {
    // 200 bps = 2 % en valeur absolue, sur TOL_DEN (10000). La bande
    // morte de la surcharge directionnelle est bien 2 %, et c'est une
    // constante du contrat, pas un parametre de deploiement. Si un
    // refactoring futur decidait d'exposer UNBALANCE_TOL_BPS en
    // parametre, ce test devrait sauter, mais le caractere "code en
    // dur" est aujourd'hui une propriete du design.
    assertEq(
      pool.UNBALANCE_TOL_BPS() * 10000,
      200 * pool.TOL_DEN(),
      "UNBALANCE_TOL_BPS * 10000 doit valoir 200 * TOL_DEN (la bande morte est codee en dur a 2 %)"
    );
  }
}

// ---------------------------------------------------------------------------
// II] Deploiement avec FEE_DEN non divisible (test 10e)
//
// L'idee est de deployer un pool avec un denominateur de frais qui
// ne divise pas exactement les bornes, pour verifier que le
// constructeur borne en valeur ABSOLUE et non en fraction de FEE_DEN.
// En pratique FEE_DEN est `constant` (Pool.sol:36), donc on ne peut
// PAS le modifier apres deploiement. La voie usuelle (un wrapper de
// fork) demanderait un fixture externe, ce qui est hors du perimetre
// de ce fichier.
//
// La section est donc documentee en FIXME et le test est
// systematiquement skip. La migration (section IV) essaie une autre
// voie.
// ---------------------------------------------------------------------------

contract FeeSplitFeeDenNotDivisibleTest is FeeSplitTestBase {

  function test_MinFeeNumZeroIsAcceptedAsZeroBp() public {
    // FIXME: FEE_DEN est constant (Pool.sol:36), donc on ne peut pas
    // deployer un pool avec un denominateur different. Ce test ne
    // peut pas etre execute sans modifier Pool.sol, ce qui est hors
    // du perimetre I.2. Le skip ci-dessous est la position
    // explicite de ce fichier : la migration est documentee dans
    // la section IV, et ce test reprendrait sa place quand le
    // fork ou la parameterisation de FEE_DEN sera ajoute.
    vm.skip(true);
  }
}

// ---------------------------------------------------------------------------
// III] Invariant I1 — conservation des frais
//
// Le coeur de l'etape 8 du plan (build-auction.md 7.2 I1) : pour
// chaque token, le solde ERC-20 du pool couvre sa reserve plus les
// frais accredites et pas encore tires. C'est la propriete qui ferme
// la regression silencieuse "le pool promet plus de fees qu'il n'a
// d'argent", et la base sur laquelle repose la garantie
// "claimManagerFees / claimProtocolFees ne reverteront pas par
// manque de fonds".
//
// Deux invariants :
//
//   A) balance >= reserves + protocolFeesOwed + sum(feesOwed[m]) :
//      pour chaque token, le pool ne s'est pas engage au-dela de ses
//      fonds. C'est l'invariant d'EXISTENCE des tirages.
//
//   B) conservation stricte : la difference entre la variation du
//      solde et la variation des reserves vaut la variation des
//      registres, sur tout swap. C'est l'invariant de COMPTABILITE,
//      plus fort que A : non seulement le pool couvre ses
//      engagements, mais il ne detient pas non plus d'argent
//      "fantome" que les registres ne traceraient pas.
// ---------------------------------------------------------------------------

contract FeeSplitInvariantTest is FeeSplitTestBase {

  // L'invariant Foundry exige une cible explicite. C'est la pool
  // elle-meme, posee avant le setUp du handler.
  function setUp() public override {
    super.setUp();
    targetContract(address(this));
  }

  // Pas de handler : l'invariant est pose directement sur l'etat
  // final du pool, apres une sequence d'appels. Pour etre aussi
  // robuste qu'un invariant Foundry classique, il faudrait un
  // handler, mais le scope de ce fichier se limite a la migration
  // I.2 et le handler complet appartient a Pool.invariant.t.sol.
  // Les tests ci-dessous utilisent donc des sequences posees a la
  // main.

  function _totalOwedForToken(uint256 tokenIndex) internal view returns (uint256) {
    // Somme sur tous les gestionnaires (en pratique, 0 ou 1 sur
    // cette fixture) du registre feesOwed[m][tokenIndex]. Le
    // mapping est iterable en theorie mais pas en Solidity ; on
    // utilise le fait que seul MANAGER est susceptible d'etre
    // nomme dans nos tests, et address(0) n'accumule rien
    // (Pool.sol:354).
    return pool.feesOwed(MANAGER, tokenIndex) + pool.feesOwed(address(0), tokenIndex);
  }

  function _balanceCoversReservesAndOwed() internal view {
    for (uint256 i = 0; i < 3; i++) {
      uint256 bal;
      if (i == 0) bal = wbtc.balanceOf(address(pool));
      else if (i == 1) bal = cbbtc.balanceOf(address(pool));
      else bal = lbtc.balanceOf(address(pool));
      uint256 reserve = pool.reserves(i);
      uint256 owed = pool.protocolFeesOwed(i) + _totalOwedForToken(i);
      assertGe(
        bal,
        reserve + owed,
        string.concat(
          "I1 : balanceOf(pool, token", vm.toString(i),
          ")=", vm.toString(bal),
          " < reserves+owed = ", vm.toString(reserve + owed)
        )
      );
    }
  }

  // Sequence 1 : un swap equilibre sur un pool sans gestionnaire,
  // suivi d'un claimProtocolFees. Apres le claim, l'invariant
  // tient toujours : la balance a baisse du montant du claim, et
  // le registre aussi, par construction (CEI : remise a zero avant
  // le transfert).
  function test_InvariantI1_BalanceCoversReservesAndOwed_AfterSwapAndClaim() public {
    _seedBalancedPool();

    // Un swap, qui credite protocolFeesOwed[0] de protocolCut.
    pool.swap(0, 1e8, 1, 0);

    _balanceCoversReservesAndOwed();

    // Un claim, qui vide protocolFeesOwed[0] et decremente la
    // balance du pool du meme montant.
    pool.claimProtocolFees(0);

    _balanceCoversReservesAndOwed();
  }

  // Sequence 2 : un swap sur un pool avec gestionnaire pose, qui
  // credite feesOwed[manager][0] ET protocolFeesOwed[0], suivi
  // d'un claimManagerFees puis d'un claimProtocolFees. L'invariant
  // tient a chaque etape, ce qui verifie que la double ecriture
  // du contrat (Pool.sol:354-358) ne cree pas d'engagement
  // fantome.
  function test_InvariantI1_BalanceCoversReservesAndOwed_WithManagerAndBothClaims() public {
    _seedBalancedPool();
    _setManagerAndSetFee(1, 10); // manager pose, tarif dans la bande

    // Le test setManagerAndSetFee a deja transporte l'horloge, mais
    // _seedBalancedPool l'a rebasculee sur l'epoch 0 (un swap
    // immediat en epoch 1 necessite un re-warp). On rebascule ici.
    _warpTo(1, 0);

    pool.swap(0, 1e8, 1, 0);
    _balanceCoversReservesAndOwed();

    vm.prank(MANAGER);
    pool.claimManagerFees(0);
    _balanceCoversReservesAndOwed();

    pool.claimProtocolFees(0);
    _balanceCoversReservesAndOwed();
  }

  // Sequence 3 : sur un pool skew, plusieurs swaps successifs
  // depuis la jambe abondante. Chaque swap credite un peu de frais,
  // et l'invariant tient apres chaque etape. C'est la version
  // I.2-aware de l'invariant "le pool arbitre reste solvable face
  // a la surcharge directionnelle".
  function test_InvariantI1_BalanceCoversReservesAndOwed_RepeatedSkewedSwaps() public {
    _seedSkewedPool();

    for (uint256 i = 0; i < 5; i++) {
      pool.swap(0, 1e7, 1, 0);
      _balanceCoversReservesAndOwed();
    }
  }

  // Sequence 4 : conservation stricte sur un seul swap. La somme
  // (balance - reserve) avant le swap vaut la somme (balance -
  // reserve - protocolFeesOwed - sum(feesOwed)) apres le swap,
  // parce que le swap ajoute _amount a la balance, _amount -
  // protocolCut - managerCut a la reserve, et credite les registres
  // de la difference. Les autres termes (le swap ne touche pas aux
  // soldes sortants) ne bougent pas.
  function test_InvariantI2_StrictConservationOfFeesPerSwap() public {
    _seedBalancedPool();

    uint256 balBefore = wbtc.balanceOf(address(pool));
    uint256 reserveBefore = pool.reserves(0);
    uint256 protocolOwedBefore = pool.protocolFeesOwed(0);

    pool.swap(0, 1e8, 1, 0);

    uint256 balAfter = wbtc.balanceOf(address(pool));
    uint256 reserveAfter = pool.reserves(0);
    uint256 protocolOwedAfter = pool.protocolFeesOwed(0);

    // Variation de la balance = _amount (le transferFrom entrant).
    // Variation de la reserve = _amount - protocolCut (sans
    // manager). Variation du registre = +protocolCut.
    // La difference (balance - reserve - protocolOwed) doit etre
    // inchangee :
    uint256 netBefore = balBefore - reserveBefore - protocolOwedBefore;
    uint256 netAfter = balAfter - reserveAfter - protocolOwedAfter;
    assertEq(
      netAfter,
      netBefore,
      string.concat(
        "I2 : balance - reserve - protocolFeesOwed a change de ",
        vm.toString(int256(netAfter) - int256(netBefore)),
        " (devrait etre inchange sur un swap sans manager)"
      )
    );
  }
}

// ---------------------------------------------------------------------------
// IV] Migrations FEE_DEN — la derive du floor porte son unite
//
// Si FEE_DEN etait un parametre du constructeur (au lieu d'une
// constante), deployer un pool avec FEE_DEN = 1e6 et MIN_FEE_NUM = 10
// donnerait une fee effective de 10/1e6 = 1e-5, soit 1 bp en valeur
// absolue, independamment du denominateur. C'est la propriete que
// cette section verifierait : la derive du floor porte son unite, et
// un passage a FEE_DEN = 1e6 ne change pas la fee effective de 1 bp
// du minimum.
//
// En l'etat (FEE_DEN constant), ce test ne peut pas etre execute.
// La section reste en place comme rappel de la migration a venir.
// ---------------------------------------------------------------------------

contract FeeSplitFeeDenMigrationTest is FeeSplitTestBase {

  function test_FeeDenMigration_FloorCarriesItsUnit() public {
    // FIXME: FEE_DEN est constant (Pool.sol:36). Pour deployer un
    // pool avec un denominateur different, il faudrait soit un
    // fork sur un mainnet, soit une parameterisation du
    // constructeur. Aucune des deux n'est en place dans le
    // perimetre I.2, donc ce test est skip.
    vm.skip(true);
  }
}
