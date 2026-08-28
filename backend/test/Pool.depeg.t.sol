// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {Pool} from "../contracts/Pool.sol";
import {MockWrappedBTC} from "../contracts/MockWrappedBTC.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// Ce que les bandes valent face a une decote reelle d'un des trois wrappers.
//
// LE MODELE, qui justifie tout le fichier
// ---------------------------------------
// Les trois jetons du pool (0 = WBTC, 1 = cbBTC, 2 = LBTC) visent tous la
// parite avec le BTC, et le pool les traite a cibles egales, un tiers chacun.
// Si l'un d'eux decote de `d` sur le marche exterieur (un doute sur le
// custodian, un depeg de LBTC...), le pool cote encore l'ancienne parite : il
// est donc arbitrable. L'arbitragiste y deverse le jeton decote et en retire
// les deux autres, jusqu'a ce que le prix marginal du pool rejoigne celui du
// marche. Sur une courbe a produit constant, le prix marginal de la paire
// (i, j) vaut r_i / r_j : l'equilibre est atteint quand
//
//     r_decote / r_autre = 1 / (1 - d)
//
// c'est-a-dire quand les trois reserves sont dans le rapport
//
//     r_decote : r_autre : r_autre  =  1/(1-d) : 1 : 1
//
// Le pool arbitre n'est donc PAS un etat arbitraire qu'on tirerait au hasard :
// c'est une fonction de la seule decote. Chaque test de ce fichier construit
// exactement cet etat pour une decote donnee, puis regarde si le pool y reste
// echangeable. `_arbitragedReserves` est la traduction litterale de la formule
// ci-dessus, avec `1/(1-d) = 10000 / (10000 - depegBps)`.
//
// Ce que le modele donne, en clair (chiffres verifies par les tests) :
//
//     decote        jambe decotee   les deux autres
//     -------------------------------------------------
//     0 bps            33.33 %         33.33 %
//     1000 bps         35.71 %         32.14 %
//     5000 bps         50.00 %         25.00 %
//     5566 bps         52.9998 %       23.5001 %  <- derniere decote en bande
//     5567 bps         53.0054 %       23.4972 %  <- premiere hors bande
//     8000 bps         71.43 %         14.29 %
//
// C'est TOUJOURS le plafond de la jambe decotee qui mord en premier : le
// plancher des deux autres ne serait atteint qu'a 1/(x+2) = 13 %, soit
// x = 5.6923, soit une decote de 8243 bps (82.4 %), tres au-dela du point ou
// le plafond a deja ferme le pool. Le domaine hors bande teste ici s'arrete
// donc a 8000 bps, ou l'on est encore dans le regime "c'est le plafond qui
// mord".
//
// COMMENT ON OBSERVE "LE POOL EST EN BANDE"
// -----------------------------------------
// La boucle de bandes de Pool.sol (lignes 151-154) ne s'applique qu'a l'etat
// d'ARRIVEE d'un `swap` : il n'existe aucune lecture directe, aucun getter,
// aucun modificateur qui dise "ce pool est en bande". L'observable est donc
// l'acceptation d'un echange de SONDE : un swap petit devant les reserves
// (PROBE_AMOUNT, 0.01 % d'une reserve), assez grand pour que `amountOut > 0`,
// assez petit pour ne pas deplacer les ratios de facon significative. Un pool
// en bande l'accepte ; un pool hors bande le refuse.
//
// La sonde nominale va d'une jambe SAINE vers l'autre jambe saine. Ce choix
// est delibere : la jambe decotee n'y est ni l'entree ni la sortie, donc sa
// valeur absolue ne bouge pas, et son ratio ne bouge que par la variation de
// la somme (les frais, ~0.5 % de la sonde, soit 5e-7 de la somme). La sonde
// ne peut donc pas, a elle seule, faire basculer le verdict qu'elle mesure.
//
// L'INTERVALLE ]5500, 5600[ EST LAISSE DE COTE VOLONTAIREMENT
// ------------------------------------------------------------
// Tout pres de la frontiere, la sonde elle-meme peut faire basculer le ratio
// dans un sens ou dans l'autre : un fuzz qui traverserait la frontiere y
// deviendrait ambigu. Le trou est couvert par
// test_BandFrontierSitsExactlyBetween5566And5567Bps, qui epingle les deux
// valeurs entieres qui l'encadrent.
contract PoolDepegBandsTest is Test, PoolTestBase {

  // Reserve de base des jambes SAINES, avant decote : 1000 BTC par jambe.
  // Assez grosse pour que les ratios soient nets (un satoshi vaut 1e-11 de la
  // reserve, donc la troncature entiere ne joue aucun role dans les verdicts
  // de bande de ce fichier), assez petite pour que le pire cas teste,
  // 5 * BASE_RESERVE = 5e11 a 8000 bps, tienne tres largement dans un uint72
  // (max ~4.72e21). `_forgeArbitragedState` le verifie a chaque appel.
  uint256 constant BASE_RESERVE = 1000e8;

  // Sonde : 0.01 % d'une reserve saine, soit 0.1 BTC. Sortie attendue ~0.0995
  // BTC, donc jamais ZeroOutput ; et 1e-4 de la reserve d'en face, donc sans
  // effet mesurable sur les ratios.
  uint256 constant PROBE_AMOUNT = BASE_RESERVE / 10000;

  // Bornes des domaines fuzzes, en points de base de decote.
  uint256 constant NOMINAL_MAX_DEPEG_BPS = 1000;    // regime nominal : 10 %
  uint256 constant IN_BAND_MAX_DEPEG_BPS = 5500;    // sous la frontiere
  uint256 constant OUT_OF_BAND_MIN_DEPEG_BPS = 5600; // au-dessus de la frontiere
  uint256 constant OUT_OF_BAND_MAX_DEPEG_BPS = 8000; // avant que le plancher n'entre en jeu

  // La frontiere exacte, epinglee par test_BandFrontierSitsExactlyBetween5566And5567Bps.
  uint256 constant LAST_IN_BAND_DEPEG_BPS = 5566;
  uint256 constant FIRST_OUT_OF_BAND_DEPEG_BPS = 5567;

  bytes32 internal reservesSlot;

  function setUp() public override {
    super.setUp();
    reservesSlot = _findReservesSlot();
  }

  // -------------------------------------------------------------------
  // Appareillage : forger l'etat arbitre
  // -------------------------------------------------------------------

  // Slot de `reserves` dans le stockage de Pool. Le packing d'un uint72[3]
  // loge les trois valeurs dans un seul slot : poids faibles = reserves[0],
  // puis reserves[1] decale de 72 bits, puis reserves[2] de 144. Le slot est
  // resolu a l'execution en amorcant le pool a montants egaux puis en
  // balayant les slots candidats, de sorte qu'un changement de disposition
  // (OZ, contrats parents) se manifeste par un echec propre de la sonde
  // plutot que par une ecriture silencieusement fausse. Duplique depuis
  // test/Pool.invariant.t.sol et test/Pool.forgedState.t.sol : la convention
  // du projet est de dupliquer ce petit helper plutot que de forcer un import
  // croise entre suites independantes (voir test/README.md).
  function _findReservesSlot() internal returns (bytes32) {
    pool.addLiquidity(0, BASE_RESERVE, 0);

    uint256 r0 = pool.reserves(0);
    uint256 r1 = pool.reserves(1);
    uint256 r2 = pool.reserves(2);
    require(r0 == r1 && r1 == r2, "seed reserves not equal; bootstrap changed shape");
    uint256 packed = (r2 << 144) | (r1 << 72) | r0;

    for (uint256 i = 0; i < 20; i++) {
      bytes32 slot = bytes32(i);
      bytes32 value = vm.load(address(pool), slot);
      if (uint256(value) == packed) {
        return slot;
      }
    }
    revert("reserves slot not found in slots 0..19");
  }

  function _token(uint256 index) internal view returns (MockWrappedBTC) {
    if (index == 0) return wbtc;
    if (index == 1) return cbbtc;
    return lbtc;
  }

  // Traduction litterale du modele : 1/(1-d) : 1 : 1, avec d en points de base.
  function _arbitragedReserves(uint256 legIndex, uint256 depegBps) internal pure returns (uint256[3] memory reserves) {
    reserves[0] = BASE_RESERVE;
    reserves[1] = BASE_RESERVE;
    reserves[2] = BASE_RESERVE;
    reserves[legIndex] = BASE_RESERVE * 10000 / (10000 - depegBps);
  }

  // Ecrit l'etat arbitre dans le slot de `reserves`, puis remet les soldes
  // ERC-20 du pool a niveau. Sans cette seconde moitie, le transfert de sortie
  // du swap echouerait faute de jetons, pour une raison SANS RAPPORT avec les
  // bandes : le test prouverait alors autre chose que ce qu'il annonce.
  // Le complement est transfere depuis address(this) et non minte : les mocks
  // sont ERC20Capped a 21_000_000e8 et PoolTestBase a deja frappe la totalite
  // du cap vers le contrat de test, donc tout `mint` supplementaire reverterait.
  function _forgeArbitragedState(uint256 legIndex, uint256 depegBps) internal returns (uint256[3] memory reserves) {
    reserves = _arbitragedReserves(legIndex, depegBps);

    for (uint256 i; i < 3; i++) {
      assertLe(
        reserves[i],
        type(uint72).max,
        "fixture cassee : la reserve arbitree deborde uint72, le packing du slot serait faux"
      );
    }

    uint256 packed = (reserves[2] << 144) | (reserves[1] << 72) | reserves[0];
    vm.store(address(pool), reservesSlot, bytes32(packed));

    for (uint256 i; i < 3; i++) {
      assertEq(pool.reserves(i), reserves[i], "vm.store n'a pas ecrit la reserve attendue");

      MockWrappedBTC token = _token(i);
      uint256 held = token.balanceOf(address(pool));
      if (held < reserves[i]) {
        token.transfer(address(pool), reserves[i] - held);
      }
      assertGe(
        token.balanceOf(address(pool)),
        reserves[i],
        "solde ERC-20 du pool sous sa reserve : le swap echouerait au transfert, pas sur les bandes"
      );
    }
  }

  // Les deux jambes restees a la parite : la sonde neutre va de l'une a l'autre.
  function _healthyPair(uint256 legIndex) internal pure returns (uint256 indexIn, uint256 indexOut) {
    indexIn = (legIndex + 1) % 3;
    indexOut = (legIndex + 2) % 3;
  }

  // La formule du contrat (Pool.sol:359-360), rejouee pour servir d'oracle a
  // la sonde acceptee. Le ceilDiv suit la regle E7 de build-auction.md : la
  // division ronde en faveur du pool. La forme reduite `amount *
  // (FEE_DEN - feeNum) / FEE_DEN` (FLOOR) sous-estime d'au plus une unite
  // quand `amount * feeNum % FEE_DEN != 0` ; sur les valeurs divisibles de
  // cette sonde, les deux formes coincident, mais la forme ceilDiv reste la
  // formulation qui matche exactement le swap apres Minimax 2.
  function _expectedAmountOut(uint256 indexIn, uint256 amount, uint256 indexOut) internal view returns (uint256) {
    uint256 effective = pool.effectiveFeeNum(indexIn, indexOut);
    uint256 amountAfterFee = amount - Math.ceilDiv(amount * effective, pool.FEE_DEN());
    return amountAfterFee * pool.reserves(indexOut) / (amountAfterFee + pool.reserves(indexIn));
  }

  // -------------------------------------------------------------------
  // Appareillage : diagnostics
  // -------------------------------------------------------------------

  // Quatre decimales, et pas deux : a la frontiere, 52.9998 % et 53.0054 %
  // s'arrondiraient l'un comme l'autre a "53.00 %" et le diagnostic ne dirait
  // plus de quel cote de la bande le pool se trouve.
  function _formatRatio(uint256 reserve, uint256 sum) internal pure returns (string memory) {
    uint256 tenThousandths = reserve * 1000000 / sum;
    uint256 whole = tenThousandths / 10000;
    uint256 frac = tenThousandths % 10000;

    string memory padding;
    if (frac < 10) {
      padding = "000";
    } else if (frac < 100) {
      padding = "00";
    } else if (frac < 1000) {
      padding = "0";
    } else {
      padding = "";
    }
    return string.concat(vm.toString(whole), ".", padding, vm.toString(frac), "%");
  }

  function _context(uint256[3] memory reserves, uint256 legIndex, uint256 depegBps) internal pure returns (string memory) {
    uint256 sum = reserves[0] + reserves[1] + reserves[2];
    return string.concat(
      "decote=", vm.toString(depegBps), " bps sur la jambe ", vm.toString(legIndex),
      " | ratios ", _formatRatio(reserves[0], sum),
      " / ", _formatRatio(reserves[1], sum),
      " / ", _formatRatio(reserves[2], sum),
      " | bande autorisee ]13.0000%, 53.0000%["
    );
  }

  function _describeRevert(bytes memory reason) internal pure returns (string memory) {
    if (reason.length < 4) return "revert sans selecteur";
    bytes4 selector;
    assembly {
      selector := mload(add(reason, 32))
    }
    if (selector == Pool.CeilingTouched.selector) return "CeilingTouched(uint256)";
    if (selector == Pool.FloorTouched.selector) return "FloorTouched(uint256)";
    if (selector == Pool.ZeroOutput.selector) return "ZeroOutput()";
    if (selector == Pool.InsufficientReserve.selector) return "InsufficientReserve()";
    if (selector == Pool.ReserveOverflow.selector) return "ReserveOverflow()";
    if (selector == Pool.BadSlippage.selector) return "BadSlippage()";
    if (selector == bytes4(0x4e487b71)) return "Panic(uint256)";
    if (selector == bytes4(0x08c379a0)) return "Error(string)";
    return "erreur inconnue";
  }

  // -------------------------------------------------------------------
  // Appareillage : les deux verdicts
  // -------------------------------------------------------------------

  function _assertProbeAccepted(
    uint256[3] memory reserves,
    uint256 legIndex,
    uint256 depegBps,
    uint256 indexIn,
    uint256 indexOut
  ) internal {
    string memory ctx = _context(reserves, legIndex, depegBps);
    uint256 expected = _expectedAmountOut(indexIn, PROBE_AMOUNT, indexOut);
    assertGt(expected, 0, string.concat("fixture cassee : la sonde ne peut rien sortir, ", ctx));

    try pool.swap(indexIn, PROBE_AMOUNT, indexOut, 0) returns (uint256 amountOut) {
      assertEq(
        amountOut,
        expected,
        string.concat(
          "sonde acceptee mais amountOut different de la formule du contrat ; ", ctx
        )
      );
    } catch (bytes memory reason) {
      fail(
        string.concat(
          "sonde de ", vm.toString(PROBE_AMOUNT), " satoshis (jambe ", vm.toString(indexIn),
          " -> jambe ", vm.toString(indexOut), ") REFUSEE avec ", _describeRevert(reason),
          " alors que les trois ratios sont dans la bande ; ", ctx
        )
      );
    }
  }

  function _assertProbeRejectedByCeiling(
    uint256[3] memory reserves,
    uint256 legIndex,
    uint256 depegBps,
    uint256 indexIn,
    uint256 indexOut
  ) internal {
    string memory ctx = _context(reserves, legIndex, depegBps);

    try pool.swap(indexIn, PROBE_AMOUNT, indexOut, 0) returns (uint256 amountOut) {
      fail(
        string.concat(
          "sonde (jambe ", vm.toString(indexIn), " -> jambe ", vm.toString(indexOut),
          ") ACCEPTEE, amountOut=", vm.toString(amountOut),
          ", alors que la jambe decotee est au-dessus du plafond ; ", ctx
        )
      );
      return;
    } catch (bytes memory reason) {
      // On exige le selecteur exact ET son argument d'index : c'est ce qui
      // exclut ZeroOutput, InsufficientReserve, ReserveOverflow et un panic
      // arithmetique. Un simple "ca a reverte" laisserait passer un refus
      // pour une raison etrangere aux bandes, et le test prouverait autre
      // chose que ce qu'il annonce.
      bytes4 selector;
      if (reason.length >= 4) {
        assembly {
          selector := mload(add(reason, 32))
        }
      }
      assertEq(
        bytes32(selector),
        bytes32(Pool.CeilingTouched.selector),
        string.concat(
          "refus obtenu via ", _describeRevert(reason),
          " ; attendu CeilingTouched(uint256), la seule garde de bande qui puisse mordre ici ; ", ctx
        )
      );
      assertEq(
        reason.length,
        36,
        string.concat("CeilingTouched doit porter son argument d'index sur 32 octets ; ", ctx)
      );
      uint256 tokenIndex;
      assembly {
        tokenIndex := mload(add(reason, 36))
      }
      assertEq(
        tokenIndex,
        legIndex,
        string.concat(
          "CeilingTouched pointe la mauvaise jambe : c'est la jambe decotee qui creve son plafond, ",
          "les deux autres sont a ", _formatRatio(reserves[(legIndex + 1) % 3], reserves[0] + reserves[1] + reserves[2]),
          " chacune, loin sous 53% ; ", ctx
        )
      );
    }
  }

  // -------------------------------------------------------------------
  // 1. Regime nominal : arbitrage ordinaire, jusqu'a 10 % de decote
  // -------------------------------------------------------------------

  // Le regime de tous les jours. Une decote de 10 % sur un wrapper de BTC est
  // deja un evenement de marche considerable, du genre a faire la une : ce
  // n'est en rien un cas limite. Et pourtant le pool arbitre s'y installe a
  // 35.71 / 32.14 / 32.14, soit dix-sept points de marge sous le plafond de
  // 53. Autrement dit, les bandes ne genent jamais l'arbitrage nominal : sur
  // toute cette plage, le pool reste ouvert et l'arbitragiste peut faire son
  // travail de remise a niveau.
  function test_FuzzNormalArbitrageKeepsPoolSwappable(uint256 _depegBps, uint256 _leg) public {
    uint256 depegBps = bound(_depegBps, 0, NOMINAL_MAX_DEPEG_BPS);
    uint256 legIndex = bound(_leg, 0, 2);

    uint256[3] memory reserves = _forgeArbitragedState(legIndex, depegBps);
    (uint256 indexIn, uint256 indexOut) = _healthyPair(legIndex);

    _assertProbeAccepted(reserves, legIndex, depegBps, indexIn, indexOut);
  }

  // -------------------------------------------------------------------
  // 2. Decote reelle, sous la frontiere : le pool reste ouvert
  // -------------------------------------------------------------------

  // Meme propriete que ci-dessus, poussee jusqu'a 55 % de decote, c'est-a-dire
  // jusqu'a un wrapper qui aurait perdu plus de la moitie de sa valeur. Le
  // pool y est deforme (52.63 / 23.68 / 23.68 a 5500 bps) mais toujours
  // echangeable : les bandes tolerent la quasi-totalite du domaine de decote
  // qu'un marche peut produire sans que le wrapper soit purement et
  // simplement mort.
  function test_FuzzRealDepegBelowFrontierKeepsPoolSwappable(uint256 _depegBps, uint256 _leg) public {
    uint256 depegBps = bound(_depegBps, 0, IN_BAND_MAX_DEPEG_BPS);
    uint256 legIndex = bound(_leg, 0, 2);

    uint256[3] memory reserves = _forgeArbitragedState(legIndex, depegBps);
    (uint256 indexIn, uint256 indexOut) = _healthyPair(legIndex);

    _assertProbeAccepted(reserves, legIndex, depegBps, indexIn, indexOut);
  }

  // -------------------------------------------------------------------
  // 3. Decote reelle, au-dela de la frontiere : le pool se ferme
  // -------------------------------------------------------------------

  // Au-dela de la frontiere, la jambe decotee depasse 53 % de la somme et la
  // boucle de Pool.sol (151-154) refuse tout etat d'arrivee. Le refus doit
  // venir des bandes et de rien d'autre : `_assertProbeRejectedByCeiling`
  // exige CeilingTouched(legIndex), selecteur et argument, ce qui exclut
  // ZeroOutput, InsufficientReserve, ReserveOverflow et un panic.
  //
  // La boucle balaie les indices 0, 1, 2 dans l'ordre : les deux jambes saines
  // sont entre 14.29 % et 23.40 % sur tout ce domaine, donc a l'interieur de
  // leur bande, et c'est bien l'indice de la jambe decotee qui interrompt
  // l'appel.
  function test_FuzzDepegBeyondFrontierRejectsProbeWithCeilingError(uint256 _depegBps, uint256 _leg) public {
    uint256 depegBps = bound(_depegBps, OUT_OF_BAND_MIN_DEPEG_BPS, OUT_OF_BAND_MAX_DEPEG_BPS);
    uint256 legIndex = bound(_leg, 0, 2);

    uint256[3] memory reserves = _forgeArbitragedState(legIndex, depegBps);
    (uint256 indexIn, uint256 indexOut) = _healthyPair(legIndex);

    _assertProbeRejectedByCeiling(reserves, legIndex, depegBps, indexIn, indexOut);
  }

  // Le piege, rendu executable. Un pool hors bande refuse TOUT swap, y compris
  // celui qui le reparerait. Ici la sonde va d'une jambe saine VERS la jambe
  // decotee : c'est exactement le sens de l'arbitrage correcteur, celui qui
  // fait redescendre la jambe decotee sous son plafond. Il est refuse comme
  // les autres, parce que la garde ne juge que l'etat d'arrivee et ne
  // s'interesse pas au fait que cet etat soit MEILLEUR que le precedent : a
  // 53.01 %, une sonde de 0.01 % ne ramene pas la jambe sous 53 %, donc l'etat
  // d'arrivee est encore hors bande, donc l'appel reverte. Le pool est ferme,
  // et sa seule porte de sortie est un depot ou un retrait de liquidite, qui
  // eux ne portent pas la boucle de bandes (voir
  // test/Pool.forgedState.t.sol:test_AddAndRemoveLiquidityStayUnguardedWhilePoolIsForgedOutOfBand)
  // mais qui, etant proportionnels, ne corrigent pas non plus le ratio.
  function test_FuzzDepegBeyondFrontierRejectsEvenTheRepairingSwap(uint256 _depegBps, uint256 _leg) public {
    uint256 depegBps = bound(_depegBps, OUT_OF_BAND_MIN_DEPEG_BPS, OUT_OF_BAND_MAX_DEPEG_BPS);
    uint256 legIndex = bound(_leg, 0, 2);

    uint256[3] memory reserves = _forgeArbitragedState(legIndex, depegBps);
    uint256 indexIn = (legIndex + 1) % 3; // jambe saine en entree
    uint256 indexOut = legIndex;          // on retire de la jambe decotee : le sens correcteur

    _assertProbeRejectedByCeiling(reserves, legIndex, depegBps, indexIn, indexOut);
  }

  // -------------------------------------------------------------------
  // 4. La frontiere exacte
  // -------------------------------------------------------------------

  // Le seul test non fuzze du fichier, et son role est d'etre fragile.
  //
  // La frontiere se resout a la main : la jambe decotee vaut x = 1/(1-d) quand
  // les deux autres valent 1, donc son ratio vaut x / (x + 2). L'egaler au
  // plafond donne 0.47 x = 1.06, soit x = 106/47 = 2.25532, soit
  // 10000 - depegBps = 10000 * 47 / 106 = 4433.96, soit depegBps = 5566.04.
  // La derniere decote ENTIERE en bande est donc 5566 (ratio 52.9998 %, la
  // stricte inegalite de Pool.sol:152 tient encore) et la premiere hors bande
  // est 5567 (ratio 53.0054 %).
  //
  // Ce nombre est une fonction des bandes, des frais et du modele d'arbitrage
  // lui-meme : si l'un des trois change, ce test doit tomber, et c'est
  // precisement pour cela qu'il existe. Les trois assertions de fixture qui
  // ouvrent le test nomment ce qui a bouge, pour que l'echec dise quoi
  // recalculer plutot que de laisser un nombre magique orphelin.
  function test_BandFrontierSitsExactlyBetween5566And5567Bps() public {
    assertEq(pool.ceiling(), 53, "la frontiere 5566/5567 est calculee pour ceiling = 53 ; recalculer");
    assertEq(pool.floor(), 13, "la frontiere suppose que c'est le plafond qui mord en premier, pas le plancher ; recalculer");
    assertEq(pool.feeNum(), 5, "la sonde suppose feeNum = 5 ; recalculer sa taille et l'amountOut attendu");

    uint256 legIndex = 1; // cbBTC ; le fuzz ci-dessus a deja montre que la jambe ne change rien

    uint256[3] memory inBand = _forgeArbitragedState(legIndex, LAST_IN_BAND_DEPEG_BPS);
    (uint256 indexIn, uint256 indexOut) = _healthyPair(legIndex);
    _assertProbeAccepted(inBand, legIndex, LAST_IN_BAND_DEPEG_BPS, indexIn, indexOut);

    uint256[3] memory outOfBand = _forgeArbitragedState(legIndex, FIRST_OUT_OF_BAND_DEPEG_BPS);
    _assertProbeRejectedByCeiling(outOfBand, legIndex, FIRST_OUT_OF_BAND_DEPEG_BPS, indexIn, indexOut);
  }
}
