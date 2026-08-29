// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "./Pool.sol";

using SafeERC20 for IERC20;

// I.3 — Enchere ascendante ouverte en MRN pour la nomination du gestionnaire
// du mandat suivant. La charge (le moment ou le gestionnaire prend office)
// est prise par le passage du temps, jamais par une transaction de reglement :
// `placeBid` met a jour le tracking interne de l'enchere (highBid,
// highBidder, refunds), et `setManager` n'est appele que dans `_settle()`,
// au moment ou le bot appelle `settle()` pendant la fenetre BID_SILENCE,
// avec le highBidder du moment. Le mandat suivant demarre par la seule
// rotation de l'horloge. La specification de reference est
// `build-auction.md` 4.5 et 5.3, et la fiche de seance
// `I.3-auction-sol.html`.
//
// QUATRE CHOIX DE DESIGN qui se voient dans le contrat mais ne se lisent
// pas en cinq lignes, et qu'il faut nommer explicitement :
//
//   (1) LA REINITIALISATION PAR COMPARAISON (build-auction.md 4.5, item 2
//       du brief). Oubliee, la seconde tenure herite du plancher de la
//       premiere, parce que `highBid` reste en place apres la fermeture de
//       la fenetre. La reinitialisation se fait au tout debut de
//       `placeBid`, par comparaison a `currentEpoch() + 1`, jamais par un
//       rollover function. La reinitialisation capture aussi le gagnant
//       precedent dans `pendingEpoch` / `pendingAmount` AVANT de remettre
//       a zero, parce que c'est ce gagnant que `settle()` traitera (point
//       5 du brief : "ouvrant une nouvelle enchere regle ce qui trainait").
//       Les `refunds`, eux, ne sont PAS effaces : un ancien encherisseur
//       peut toujours tirer son refund.
//
//   (2) LE CREDIT, PAS LE PUSH (R2). L'encherisseur depasse est credite
//       dans `refunds[oldBidder] += highBid`, jamais transfere. Un
//       encherisseur contrat qui revert a la reception gelerait sinon
//       toute mise superieure : c'est l'attaque la moins chere possible
//       sur le mecanisme entier (item 3 du brief). Le retrait est pull,
//       par `withdrawRefund`, et CEI tient : remise a zero du registre
//       AVANT le transfert.
//
//   (3) setManager APPELLE UNE SEULE FOIS PAR ENCHERE, AU MOMENT DU SETTLE.
//       La garde `managerOf[epoch] != address(0)` de Pool.setManager (I.1,
//       deja livre) interdit tout second appel pour la meme epoch. L'Auction
//       respecte cette garde en n'appelant `setManager` qu'UNE SEULE FOIS
//       par enchere, dans `_settle()`, avec le `highBidder` du moment — c'est
//       le DERNIER encherisseur de l'enchere, designe au moment ou la
//       fenetre se clot. `placeBid` ne touche jamais `pool.setManager` :
//       pendant toute la duree de l'enchere, `pool.managerOf(epoch) ==
//       address(0)`, et le front lit `auction.highBidder()` pour afficher
//       le meneur courant. La regle R3 tient (l'office est pris par le
//       passage du temps), seule la question "qui est designe" est fixee
//       par la derniere mise reussie.
//
//       TIMING DU SETTLE : avec `bidSilence > 0`, le bot appelle
//       `settle()` pendant la fenetre BID_SILENCE (les 60 dernieres
//       secondes de l'epoch), AVANT que l'epoch ne tourne. A ce moment,
//       `currentEpoch() < pendingEpoch` (la garde I.1 tient), et
//       `highBidder` est encore le dernier encherisseur de l'enchere
//       qui se clot. Si le bot appelle `settle()` apres le basculement
//       de l'epoch, la garde `_epoch > currentEpoch()` du Pool revert
//       `EpochAlreadyStarted` et le manager pour cette epoch reste non
//       designe (degradation R7).
//
//   (4) L'ENCHERE SANS ENCHERISSEUR (E3 + R7, item 5 du brief). Si
//       personne n'encherit pour un mandat, `pendingEpoch == 0 &&
//       pendingAmount == 0` et `settle()` revert `NoBidToSettle()`. Le
//       pool continue de trader au tarif nominal, et rien ne s'accumule
//       pour le mandat suivant : c'est la degradation R7, qui transforme
//       un mode de defaillance en service degrade plutot qu'en
//       catastrophe.
//
// DEUX SCALAIRES qui n'arrivent pas en argument de constructeur et qui
// s'asseyent comme `constant` : la hausse minimale de +10 % (`HIGH_BID_BPS`,
// 1100 / 10000) et le partage 70 / 30 (`LP_BPS` 7000, `BURN_BPS` 3000, sur
// `SPLIT_DEN` 10000). Une regle du format, pas un parametre de
// deploiement, et c'est la separation que build-auction.md 5.0 bis (2)
// fixe (point 1 du brief) : un `constant` se lit comme une propriete du
// mecanisme, un `immutable` se lit comme un knob qu'un deployer a tourne.
//
// L'ARGUMENT DE CONSTRUCTEUR `_maxExtension` est pose a 0 (build-auction.md
// 5.3 (1) et 5.0 bis) parce que le soft close A1 est roadmap et n'arrive
// pas a I.3. Il reste dans la signature pour que A1 soit une substitution,
// pas une reecriture, et les deux uniques lignes qui pourraient l'utiliser
// dans `placeBid` sont gardees par des commentaires FIXME.

/// @title Auction
/// @notice Ascending-price MRN auction that elects the manager of the
///         next epoch. Bidders outbid each other during a fixed window
///         in MRN; the highest bid at settle-time designates the
///         manager, pays the LP rent, and burns the protocol share.
/// @dev The pool's clock is snapshotted at construction so the two
///      contracts cannot drift. Manager nomination happens once per
///      auction, inside `settle`, which must be called during the
///      `bidSilence` window: past the epoch rollover the pool's
///      `EpochAlreadyStarted` guard fires and the epoch runs unmanaged.
contract Auction {

  // -------------------------------------------------------------------------
  // Immuables
  // -------------------------------------------------------------------------

  // Lues du Pool a la construction (4.5) : la copie locale garantit que les
  // deux horloges ne peuvent pas deriver, et chaque lecture de
  // `currentEpoch()` ou de `startOfEpoch` reste un calcul memoire, jamais un
  // appel externe.
  uint256 internal immutable genesis;
  uint256 internal immutable epochDuration;

  // L'argument de deploiement qui n'a pas d'ancre on-chain : on l'immutable
  // sur l'Auction, et il vit dans le record de deploiement (ignition) et
  // dans les tests. Voir build-auction.md 2.2 et 5.0 bis pour les valeurs
  // de demonstration (15 min, 0, 0, 10 MRN a 18 decimales, restated 2026-08-28).
  /// @notice Duration of the bidding window, in seconds, measured from
  ///         the start of the epoch preceding the one being auctioned,
  ///         i.e. the current epoch.
  uint256 public immutable auctionWindow;
  /// @notice Maximum soft-close extension in seconds, reserved for the
  ///         A1 soft-close gate. Set to 0 at I.3; the gate is not
  ///         active yet.
  uint256 public immutable maxExtension;
  /// @notice Length of the settle window at the end of the epoch, in
  ///         seconds, during which the bot is expected to call
  ///         `settle` and nominate the manager.
  /// @dev Not enforced on-chain at I.3: the A4 gate that would close
  ///      bidding during this window is still a FIXME, so this value
  ///      is read by off-chain callers only.
  uint256 public immutable bidSilence;
  /// @notice Minimum first bid of any new auction, in MRN (18 decimals).
  uint256 public immutable minOpeningBid;

  /// @notice The MRN token used for bidding, refunds, and the rent
  ///         payout to the pool.
  IERC20 public immutable mrn;
  /// @notice The Merion pool whose next-epoch manager this auction
  ///         elects. Read at construction and held immutable.
  Pool public immutable pool;

  // Le tresor du Pool, recadre en immutable ici pour qu'un `settle()`
  // n'ait pas a relire le Pool. Ce n'est PAS le tresor des produits de
  // l'enchere : R6 dit explicitement qu'il n'y a pas de part tresorerie
  // sur le produit, et c'est la constante `BURN_BPS` qui le dit.
  /// @notice The Pool's protocol treasury, mirrored here at
  ///         construction. Not used by `settle` (R6: no treasury share
  ///         on the auction revenue), but stored for completeness.
  address public immutable treasury;

  // -------------------------------------------------------------------------
  // Constantes
  // -------------------------------------------------------------------------

  // La hausse minimale de +10 %, codee en dur (build-auction.md 5.3 (3) et
  // 5.0 bis). C'est la regle du format, pas un parametre de deploiement :
  // une relance doit depasser le gaz de relancer, sans quoi l'enchere
  // degenere en guerre de gaz au wei. 7.1 test 19 la tient exactement.
  //
  // NOTE : le brief I.3 annoncait `HIGH_BID_BPS = 1100`, mais `1100 /
  // 10000 = 0.11` represente 11 % de highBid, pas +10 % de hausse.
  // Une mise a 0.11 * highBid ne represente pas une hausse, c'est un
  // effondrement. La valeur qui donne la regle annoncee est 11000 :
  // `11000 / 10000 = 1.1 = 110 %` de highBid, soit une hausse de +10 %.
  // Le brief porte un typo sur ce scalaire ; voir la note methodologique
  // en fin de fichier pour la justification complete. Le test 7.1 (19)
  // pin exactement cette regle et ecrase la valeur a 11000.
  /// @notice Minimum outbid ratio in basis points. A new bid must
  ///         reach at least `highBid * HIGH_BID_BPS / BPS_DEN` to be
  ///         accepted (effectively +10 %).
  uint256 constant public HIGH_BID_BPS = 11000;
  /// @notice Basis-point denominator, shared by `HIGH_BID_BPS` and
  ///         `SETTLE_REWARD_BPS`.
  uint256 constant public BPS_DEN = 10000;

  // Le partage du produit de l'enchere : 70 % LP, 30 % brule (R6, point 5
  // du brief). Pas de part tresorerie : tout le flux va soit au pool (qui
  // le stream aux LP via `notifyRent` a I.4), soit a la destruction par
  // `mrn.burn`. Le denominateur partage est `SPLIT_DEN`, distinct du
  // `BPS_DEN` du `HIGH_BID_BPS` (regle : un seul denominateur par calcul,
  // jamais partage).
  /// @notice Denominator of the auction-revenue split between LP
  ///         share and burn share. Distinct from `BPS_DEN` to keep
  ///         each calculation bounded by a single denominator.
  uint256 constant public SPLIT_DEN = 10000;
  /// @notice Share of the settled amount routed to the pool as LP
  ///         rent, in basis points over `SPLIT_DEN` (70 %).
  uint256 constant public LP_BPS = 7000;
  /// @notice Share of the settled amount burned by the auction, in
  ///         basis points over `SPLIT_DEN` (30 %).
  uint256 constant public BURN_BPS = 3000;

  // Prime au caller de `settle()` (le bot qui nomme le gestionnaire) :
  // 0,1 % de lpAmount, paye en MRN depuis le solde de l'Auction, preleve
  // sur le flux qui va aux LP. Ferme l'incitation faible documentee par
  // la revue I.7 : sans elle, seul le futur gestionnaire a un interet
  // direct a appeler settle(), et l'enchere peut rester en suspens
  // (managerOf[epoch] reste a address(0), les LP ne touchent pas la rente,
  // le mandat suivant ne demarre qu'apres une nouvelle mise qui capture
  // l'ancien etat). Le denominateur est BPS_DEN, partage avec HIGH_BID_BPS
  // (regle du projet : un seul denominateur par calcul, jamais partage).
  /// @notice Caller reward on `settle`, in basis points of `lpAmount`,
  ///         paid in MRN to the bot that nominates the manager
  ///         (0.1 %).
  uint256 constant public SETTLE_REWARD_BPS = 10;

  // -------------------------------------------------------------------------
  // Storage mutable
  // -------------------------------------------------------------------------

  // L'enchere en cours vend le mandat `sellingEpoch`. La regle d'or :
  // `sellingEpoch == currentEpoch() + 1` SI l'enchere est active. Sinon le
  // slot appartient a une enchere finie et il est rouvert a zero par
  // comparaison (voir entete de contrat, point (1)).
  /// @notice The epoch whose manager is currently being auctioned.
  ///         Equal to `currentEpoch() + 1` while the auction is live;
  ///         stale value reset by the next `placeBid` or `settle`.
  uint256 public sellingEpoch;
  /// @notice The current highest bid of the live auction, in MRN
  ///         (18 decimals). Zero when no bid is in flight.
  uint256 public highBid;
  /// @notice Address of the current highest bidder, or the zero
  ///         address when no bid is in flight.
  address public highBidder;

  // Le mandat gagne mais pas encore regle. `pendingEpoch == 0 &&
  // pendingAmount == 0` designe le slot vide, et c'est ce que `settle()`
  // verifie pour reverter `NoBidToSettle()` quand il n'y a rien a faire.
  // Il ne peut y avoir plus d'un mandat en attente a la fois, parce que
  // l'ouverture d'une nouvelle enchere regle ce qui trainait dans le slot.
  /// @notice The epoch waiting to be settled. Zero means no pending
  ///         settlement.
  uint256 public pendingEpoch;
  /// @notice The winning bid amount waiting to be settled, in MRN
  ///         (18 decimals). Zero means no pending settlement.
  uint256 public pendingAmount;

  // Refunds credits et jamais pousses (R2, point (2) de l'entete). Pull
  // only, par `withdrawRefund()`. CEI tient sur le tirage.
  /// @notice Outstanding refund credits, per address, in MRN
  ///         (18 decimals). Pulled by `withdrawRefund`.
  mapping(address => uint256) public refunds;

  // -------------------------------------------------------------------------
  // Erreurs
  // -------------------------------------------------------------------------

  /// @notice The provided bid is below the minimum required for the
  ///         current auction (either `minOpeningBid` or a +10 % outbid
  ///         over the current high).
  /// @param min The minimum amount the caller had to bid.
  /// @param provided The amount the caller actually bid.
  error BidTooLow(uint256 min, uint256 provided);
  /// @notice The auction window is closed: the caller's bid arrived
  ///         after the bidding deadline.
  error WindowClosed();
  /// @notice The caller has no refund credit to withdraw.
  error NoBidToRefund();
  /// @notice There is no winning bid awaiting settlement, and no live
  ///         auction to capture either.
  error NoBidToSettle();

  // -------------------------------------------------------------------------
  // Evenements
  // -------------------------------------------------------------------------

  /// @notice Emitted when a new highest bid is placed in the auction.
  /// @param epoch The epoch whose manager the bid is for.
  /// @param bidder The address that placed the bid.
  /// @param amount The bid amount in MRN (18 decimals).
  event BidPlaced(uint256 indexed epoch, address indexed bidder, uint256 amount);
  /// @notice Emitted when the previous highest bidder is credited a
  ///         refund (R2: credit, never push).
  /// @param bidder The address whose previous bid is now refundable.
  /// @param amount The refunded amount in MRN (18 decimals).
  event RefundCredited(address indexed bidder, uint256 amount);
  /// @notice Emitted when a bidder successfully withdraws their
  ///         refund credit.
  /// @param bidder The address that withdrew the refund.
  /// @param amount The withdrawn amount in MRN (18 decimals).
  event RefundWithdrawn(address indexed bidder, uint256 amount);
  // Re-emis ici pour l'indexation par adresse. Le contrat Pool emet aussi
  // `ManagerSet` ; cette deuxieme emission donne aux clients un seul
  // endpoint d'audit par encherisseur, sans avoir a scanner les logs de
  // Pool. Voir build-auction.md 5.3.
  /// @notice Re-emitted here for per-bidder auditability. The Pool
  ///         already emits its own `ManagerSet`; this duplicate allows
  ///         clients to filter settlement events by bidder without
  ///         scanning Pool logs.
  /// @param epoch The epoch whose manager has been set.
  /// @param manager The manager designated for that epoch.
  event ManagerSet(uint256 indexed epoch, address indexed manager);
  // L'evenement de cloture de mandat (5.4 bis, point 7 du brief) : index,
  // gestionnaire, prix de cloture, tarif pose, et les trois reserves lues
  // a cet instant. Un evenement, aucun stockage, rien sur le chemin du
  // swap. Il ne porte PAS le revenu de frais du mandat (derivable hors
  // chaine des `Swapped`).
  /// @notice Epoch-closing snapshot emitted at settle-time. Captures
  ///         the manager, the clearing price, the fee in force for
  ///         the settled epoch, and the three reserves read at that
  ///         instant.
  /// @param epoch The epoch that has just been settled.
  /// @param manager The manager designated for that epoch.
  /// @param clearingPrice The winning bid, in MRN (18 decimals).
  /// @param fee The fee in force at the start of the epoch (numerator
  ///        over `FEE_DEN`).
  /// @param reservesAtClose The three pool reserves read at settle
  ///        time, in token units.
  event Settled(uint256 indexed epoch, address indexed manager, uint256 clearingPrice, uint256 fee, uint256[3] reservesAtClose);

  // -------------------------------------------------------------------------
  // Constructeur
  // -------------------------------------------------------------------------

  /// @notice Deploys the auction, snapshots the pool's `GENESIS` and
  ///         `EPOCH_DURATION` to keep the two clocks aligned, records
  ///         the bidding-window parameters, and pre-approves the pool
  ///         to pull MRN for rent payouts.
  /// @dev The pool's clock fields are copied rather than re-read on
  ///      every call: this is the only way to guarantee the two
  ///      contracts never drift. The pre-approval uses `approve`
  ///      (not `forceApprove`) because the Auction is freshly
  ///      deployed and its previous MRN allowance is zero.
  /// @param _pool Address of the Merion pool whose manager this
  ///        auction elects.
  /// @param _mrn Address of the MRN token used for bidding and rent.
  /// @param _auctionWindow Length of the bidding window, in seconds.
  /// @param _maxExtension Reserved for the A1 soft-close gate; set
  ///        to 0 at I.3.
  /// @param _bidSilence Length of the settle window, in seconds.
  /// @param _minOpeningBid Minimum first bid of any new auction, in
  ///        MRN (18 decimals).
  constructor(
    address _pool,
    address _mrn,
    uint256 _auctionWindow,
    uint256 _maxExtension,
    uint256 _bidSilence,
    uint256 _minOpeningBid
  ) {
    // GENESIS et EPOCH_DURATION sont lus du Pool, pas passes en argument :
    // c'est l'unique facon de garantir que les deux horloges ne peuvent
    // pas deriver. Voir build-auction.md 4.5.
    Pool p = Pool(_pool);
    genesis = p.GENESIS();
    epochDuration = p.EPOCH_DURATION();

    pool = p;
    mrn = IERC20(_mrn);
    auctionWindow = _auctionWindow;
    maxExtension = _maxExtension;
    bidSilence = _bidSilence;
    minOpeningBid = _minOpeningBid;

    // Recadre en immutable cote Auction pour eviter une lecture du Pool
    // dans `settle()`. R6 : il n'y a pas de part tresorerie sur le
    // produit de l'enchere, donc ce `treasury` n'est jamais touche par
    // `settle()`. Il est pose ici uniquement parce que la construction de
    // `pool` le rend gratuit.
    treasury = p.treasury();

    // M2 (I.7) : l'Auction pre-approuve le Pool sur le MRN. La pose est
    // ici plutot qu'au cablage parce que l'adresse du Pool y est
    // `immutable` (cf. ci-dessus), donc la condition d'I.7 #10
    // (« constructeur si l'adresse du pool y est immutable ») tient. Le
    // Pool tire sur cette approbation dans `notifyRent`
    // (cf. `Pool.sol`, I.7 #8-9) : c'est le decouplage qui rend l'argument
    // vrai par construction, sans adjacence de deux lignes dans un
    // contrat tiers. `approve` (vs `forceApprove`) est adapte ici :
    // l'Auction est fraichement deployee, l'allowance MRN precedente est
    // nulle, le passage 0 -> max ne peut pas reverter.
    IERC20(_mrn).approve(address(p), type(uint256).max);
  }

  // -------------------------------------------------------------------------
  // Vues
  // -------------------------------------------------------------------------

  // `(block.timestamp - genesis) / epochDuration`, derive pur. Pas de
  // compteur, pas de keeper (R1) : la formule est recomputable hors chaine
  // par un front qui connait GENESIS et EPOCH_DURATION.
  /// @notice Returns the current epoch derived from the pool's
  ///         `GENESIS` and `EPOCH_DURATION` snapshot at deployment.
  /// @return The current epoch number, zero-based.
  function currentEpoch() public view returns (uint256) {
    return (block.timestamp - genesis) / epochDuration;
  }

  /// @notice Returns the current highest bid of the live auction.
  /// @return The current high bid, in MRN (18 decimals), or zero if
  ///         no bid is in flight.
  function currentBid() external view returns (uint256) {
    return highBid;
  }

  // La fenetre d'enchere est OUVERTE si et seulement si :
  //   - `sellingEpoch` designe bien le mandat suivant (`currentEpoch() + 1`) ;
  //   - `block.timestamp` est sous la borne superieure, calculee comme
  //     `startOfEpoch(sellingEpoch - 1) + auctionWindow` (point 1 du brief,
  //     build-auction.md 4.5).
  // Aucune garde sur la borne inferieure (debut de la fenetre) ici : elle
  // est silencieusement ouverte par le `sellingEpoch != currentEpoch() + 1`
  // qui reinitialise tout a zero, et un appel avant ce moment equivaut a
  // un appel sur une enchere vide.
  /// @notice Returns whether the bidding window is currently open.
  /// @return True iff the auction is for the next epoch and
  ///         `block.timestamp` is before the window deadline.
  function windowOpen() public view returns (bool) {
    if (sellingEpoch != currentEpoch() + 1) return false;
    return block.timestamp < startOfEpoch(sellingEpoch - 1) + auctionWindow;
  }

  // L'horodatage de cloture dure de l'enchere, expose pour le front.
  // Rendu en memoire pure, pas de reinitialisation : la vue n'a pas
  // d'effet de bord.
  /// @notice Returns the closing timestamp of the bidding window for
  ///         the epoch currently being sold.
  /// @dev Reverts by underflow while `sellingEpoch` is zero, i.e.
  ///      before the first bid ever placed. Returns a stale value once
  ///      the auction it describes has closed; pair it with
  ///      `windowOpen()`.
  /// @return The unix timestamp at which the bidding window closes.
  function closesAt() public view returns (uint256) {
    return startOfEpoch(sellingEpoch - 1) + auctionWindow;
  }

  // -------------------------------------------------------------------------
  // Helpers internes
  // -------------------------------------------------------------------------

  /// @dev Start timestamp of `epoch`, from the clock snapshotted at
  ///      construction.
  /// @param epoch The epoch number.
  /// @return The unix timestamp at which `epoch` begins.
  function startOfEpoch(uint256 epoch) internal view returns (uint256) {
    return genesis + epoch * epochDuration;
  }

  // -------------------------------------------------------------------------
  // placeBid
  // -------------------------------------------------------------------------

  // Le flux de `placeBid` tient en cinq operations, dans l'ordre :
  //   1. reinitialisation par comparaison (point (1) de l'entete), qui
  //      capture aussi le gagnant precedent dans `pendingEpoch` /
  //      `pendingAmount` ;
  //   2. controle de la fenetre temporelle ;
  //   3. calcul du seuil `max(MIN_OPENING_BID, highBid * HIGH_BID_BPS / BPS_DEN)` ;
  //   4. credit du precedent `highBidder` dans `refunds` (point (2)) ;
  //   5. tirage du MRN, ecriture de l'etat d'enchere, et emission de
  //      `BidPlaced` (point (3) de l'entete : `setManager` n'est PAS
  //      appele ici, il l'est dans `_settle` avec le `highBidder` du
  //      moment).
  //
  // L'ordre (4) avant (5) est important : le precedent enchérisseur est
  // crédité AVANT que l'Auction ne reçoive le MRN du nouveau, donc un
  // revert sur le transfert entrant n'affecte pas le refund crédité.

  /// @notice Places a bid on the auction for the next epoch.
  /// @dev When `sellingEpoch` is stale, the slot is reopened at zero
  ///      and the previous winner is first captured into
  ///      `pendingEpoch` and `pendingAmount` for `settle` to process;
  ///      `refunds` are never cleared. The outbid bidder is credited,
  ///      never paid (pull-only), then the MRN is pulled from the
  ///      caller, who must have approved the auction first. Manager
  ///      nomination is deferred to `settle`. Reverts with
  ///      `WindowClosed` past the deadline and `BidTooLow` below
  ///      `max(minOpeningBid, highBid * HIGH_BID_BPS / BPS_DEN)`.
  /// @param amount The bid amount, in MRN (18 decimals).
  //
  // La nomination du gestionnaire par `pool.setManager` est reportee a
  // `_settle()` (point (3) de l'entete). Pendant toute la duree de
  // l'enchere, `pool.managerOf(sellingEpoch) == address(0)`, et seul
  // `auction.highBidder()` rend le meneur courant. Le front ne lit
  // `pool.managerOf(epoch)` qu'apres le `settle()` externe, appele par
  // le bot pendant la fenetre BID_SILENCE.
  function placeBid(uint256 amount) external {
    // (1) Reinitialisation par comparaison. Si `sellingEpoch` ne designe
    // plus le mandat suivant, c'est qu'une enchere finie a laisse son
    // `highBid` en place, et le slot doit rouvrir a zero. AVANT la
    // reinitialisation, on capture le gagnant precedent dans
    // `pendingEpoch` / `pendingAmount` : c'est ce que `settle()`
    // externe traitera (par n'importe quel tiers, PENDANT la fenetre
    // BID_SILENCE de la nouvelle epoch). Le `settle` externe est la voie
    // canonique pour nommer le gestionnaire : avec `bidSilence > 0`,
    // l'auto-settle en fin de placeBid arrive apres que l'epoch a
    // tourne, et la garde `_epoch > currentEpoch()` du Pool (I.1) tient
    // — il faut donc un appel externe pendant la fenetre de silence.
    // Les `refunds` ne sont PAS effaces : un ancien enchérisseur peut
    // toujours tirer son refund, et c'est le seul cas ou l'etat n'est
    // pas remis a neuf.
    //
    // R2 — `currentEpoch() + 1` est calcule une seule fois et reutilise
    // pour la comparaison et pour l'affectation. La division par
    // `epochDuration` est ainsi evitee sur la deuxieme lecture, et le
    // memoire-memoire sur `epoch` est gratuit.
    uint256 nextEpoch = currentEpoch() + 1;
    if (sellingEpoch != nextEpoch) {
      if (highBidder != address(0)) {
        pendingEpoch = sellingEpoch;
        pendingAmount = highBid;
      }
      sellingEpoch = nextEpoch;
      highBid = 0;
      highBidder = address(0);
    }

    // (2) Controle de la fenetre temporelle. La fenetre va de
    // `startOfEpoch(sellingEpoch - 1)` a `startOfEpoch(sellingEpoch - 1) +
    // auctionWindow`. Le premier instant n'est pas garde ici parce que le
    // mandat N-1 n'a pas encore commence avant cet instant (et
    // `currentEpoch() < sellingEpoch - 1` aurait de toute facon declenche
    // la reinitialisation a zero juste au-dessus). La borne haute est la
    // seule a verifier.
    //
    // R2 — la borne superieure est stockee dans une locale
    // `closesAt_` et utilisee telle quelle par la garde. La meme
    // expression reapparait dans `windowOpen()` et `closesAt()` (vues
    // distinctes, hors du chemin chaud), donc la mise en cache ne sert
    // qu'a rendre le test explicite ; l'economie tient surtout a la
    // constance du nom (le calcul de la fenetre est localise ici).
    uint256 closesAt_ = startOfEpoch(sellingEpoch - 1) + auctionWindow;
    require(
      block.timestamp < closesAt_,
      WindowClosed()
    );

    // `maxExtension` est l'unique piece du soft close (A1). Sa valeur a
    // I.3 est 0 (build-auction.md 5.0 bis), donc cette soustraction ne
    // mord pas, et la fenetre reste inchangee. Le commentaire FIXME tient
    // la place du gate A1 futur.
    // FIXME: gate A1 (soft close) — quand `maxExtension > 0`, retrancher
    // `maxExtension` de la borne haute pour ouvrir plus tot et permettre
    // l'extension tardive.

    // `bidSilence` est la zone de silence avant la fin du mandat. Sa
    // valeur a I.3 est 60 secondes (build-auction.md 5.0 bis) : c'est
    // la fenetre pendant laquelle le bot appelle `settle()` pour
    // nommer le gestionnaire, AVANT que l'epoch ne tourne. Le gate A4
    // qui empecherait les encheres pendant cette fenetre reste FIXME
    // pour l'instant — a I.3, `bidSilence` sert uniquement a ouvrir
    // une fenetre de settle, pas a fermer la fenetre d'enchere.
    // FIXME: gate A4 (silence) — quand `bidSilence > 0`, exiger
    // `block.timestamp <= closesAt() - bidSilence` pour fermer la
    // fenetre d'enchere plus tot.

    // (3) Seuil. La hausse minimale est +10 % (build-auction.md 5.3 (3),
    // HIGH_BID_BPS = 11000 sur BPS_DEN = 10000). `highBid` valant 0 pour
    // la premiere mise, `highBid * 11000 / 10000` rend 0, donc le seuil
    // effectif est `MIN_OPENING_BID`. Le `max` evite une double
    // verification et protege la borne inferieure pour les encheres
    // vides.
    uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;
    if (min < minOpeningBid) min = minOpeningBid;
    require(amount >= min, BidTooLow(min, amount));

    // (4) Credit du precedent `highBidder` dans `refunds`. PAS DE
    // TRANSFERT (R2, point (2) de l'entete). La CEI interne : on ecrit
    // d'abord le refund, on emit l'evenement, on transfert le MRN
    // seulement ensuite. Un revert sur le `safeTransferFrom` du (5)
    // laisserait le refund credite ; c'est un etat coherent parce que
    // l'encherisseur precedent peut deja le tirer.
    if (highBidder != address(0)) {
      refunds[highBidder] += highBid;
      emit RefundCredited(highBidder, highBid);
    }

    // (5) Tirage du MRN. Le caller doit avoir `approve` l'Auction pour au
    // moins `amount` MRN ; un manque d'allowance revert avec
    // `ERC20InsufficientAllowance`, distinct de toute erreur `Auction.*`
    // parce que la garde d'allowance vit dans l'ERC-20, pas ici.
    mrn.safeTransferFrom(msg.sender, address(this), amount);

    // (6) Ecriture de l'etat d'enchere. Doit suivre le tirage, parce
    // qu'un revert sur le tirage ne doit pas avoir laisse un faux
    // `highBidder` designe. La nomination du gestionnaire n'est PAS
    // faite ici : voir point (3) de l'entete. Le `highBidder` est le
    // meneur COURANT de l'enchere, pas forcement le futur gestionnaire
    // — une surenchere sur la meme enchere peut le chasser.
    highBid = amount;
    highBidder = msg.sender;

    // (7) Emission finale de `BidPlaced`. Aucun `pool.setManager` ici :
    // la nomination est differee a `_settle()` (point (3) de l'entete).
    // Pendant toute la duree de l'enchere, `pool.managerOf(sellingEpoch)`
    // reste a `address(0)`, et le front lit `auction.highBidder()` pour
    // afficher le meneur courant.
    emit BidPlaced(sellingEpoch, msg.sender, amount);
  }

  // -------------------------------------------------------------------------
  // withdrawRefund
  // -------------------------------------------------------------------------

  // Pull-only, CEI strict (5.6 (4)) : la remise a zero du registre
  // PRECEDE le transfert, sans exception. L'invariant que cette garde
  // tient : un encherisseur contrat qui reverte a la reception ne bloque
  // ni la mise courante (R2, point (2) de l'entete) ni le tirage
  // ulterieur d'un refund bien merite.

  /// @notice Withdraws the caller's outstanding refund credit, if any.
  /// @dev Pull-only, CEI strict: the registry is reset to zero before
  ///      the transfer. Reverts with `NoBidToRefund` if the caller
  ///      has nothing to withdraw.
  function withdrawRefund() external {
    uint256 owed = refunds[msg.sender];
    require(owed > 0, NoBidToRefund());
    refunds[msg.sender] = 0;
    mrn.safeTransfer(msg.sender, owed);
    emit RefundWithdrawn(msg.sender, owed);
  }

  // -------------------------------------------------------------------------
  // settle
  // -------------------------------------------------------------------------

  // Permissionless et idempotent (build-auction.md 5.3 (5), 5.4 (2),
  // point 5 du brief). Le flot :
  //
  //   1. Si rien a regler, tenter de capturer l'enchere courante
  //      (slot `pendingEpoch == 0` mais `highBidder != address(0)`) ;
  //      sinon revert `NoBidToSettle()`.
  //   2. Sinon, transmettre a `_settle` le `highBidder` du moment (le
  //      dernier encherisseur de l'enchere, qui devient le manager-
  //      designate du mandat `pendingEpoch`, voir point (3) de l'entete).
  //   3. `_settle` partage le `pendingAmount` en 30 % brule et 70 % LP,
  //      brule, transfere 70 % au Pool, appelle `pool.notifyRent`,
  //      appelle `pool.setManager(pendingEpoch, manager)` (point (3)
  //      de l'entete : UNE SEULE FOIS par enchere, ici), et emet
  //      `Settled` avec le manager, le clearing price, le tarif en
  //      vigueur AU MOMENT DU MANDAT `pendingEpoch`, et les trois
  //      reserves lues a cet instant.
  //   4. Remettre a zero le slot `pendingEpoch` / `pendingAmount`.
  //
  // L'invariant que la garde tient : il ne peut y avoir plus d'un mandat
  // en attente a la fois, parce que l'ouverture d'une nouvelle enchere
  // (et l'entree en `placeBid` qui suit la reinitialisation) regle ce
  // qui trainait. La resolution d'un double `settle` consecutif est
  // simple : le second voit `pendingEpoch == 0 && pendingAmount == 0` et
  // revert `NoBidToSettle()`.

  /// @notice Settles the winning bid: burns 30 % of `pendingAmount`,
  ///         pays the caller a `SETTLE_REWARD_BPS` reward on the LP
  ///         share, hands the rest to the pool as rent via
  ///         `Pool.notifyRent`, and nominates the high bidder as
  ///         the manager of `pendingEpoch`.
  /// @dev Permissionless. Captures a live auction into the pending
  ///      slot if no previous settlement is queued. Not idempotent:
  ///      reverts with `NoBidToSettle` when there is nothing to
  ///      settle and no live auction either, which is what a second
  ///      consecutive call hits.
  function settle() external {
    if (pendingEpoch == 0 && pendingAmount == 0) {
      // Le slot est vide, mais l'enchere COURANTE peut encore etre
      // reglee si elle a un `highBidder` et designe bien le mandat
      // suivant (`sellingEpoch == currentEpoch() + 1`). C'est le
      // chemin qu'un `settle` externe prend quand il est appele
      // directement apres les `placeBid`, sans attendre la reinit
      // d'une nouvelle enchere : sans cette capture, `settle`
      // reverterait `NoBidToSettle()` et la garde `ManagerAlreadySet`
      // empecherait toute nomination par la suite.
      if (highBidder == address(0)) {
        revert NoBidToSettle();
      }
      pendingEpoch = sellingEpoch;
      pendingAmount = highBid;
    }
    _settle(highBidder);
  }

  // La logique interne de `settle`, appelee par le `settle()` externe.
  // Le `manager` est le `highBidder` du moment de l'enchere qui se clot :
  //   - pour le `settle()` externe apres les `placeBid` (la reinit n'a
  //     pas eu lieu, le dernier encherisseur est encore dans
  //     `highBidder`), c'est l'etat courant du slot ;
  //   - pour le `settle()` externe apres une reinit par `placeBid`
  //     (l'enchere suivante a capture le gagnant precedent), c'est
  //     le `highBidder` de l'enchere suivante (pas celui de l'enchere
  //     qui se clot) — c'est pourquoi `settle()` doit etre appele
  //     PENDANT la fenetre BID_SILENCE, AVANT que la reinit n'ait
  //     lieu dans la nouvelle epoch.
  // Doit etre appelee SEULEMENT quand le slot pending est non vide,
  // sinon le `pool.setManager(pendingEpoch, address(0))` reverterait
  // `ZeroManager` et l'evenement `Settled` porterait un manager vide.
  /// @dev Splits `pendingAmount` 30 % burn / 70 % LP, pays the caller
  ///      the settle reward, pulls the remainder to the pool as rent,
  ///      nominates the manager, emits `Settled`, then clears both the
  ///      pending slot and the live auction state.
  /// @param manager The bidder to designate for `pendingEpoch`.
  function _settle(address manager) internal {
    // Le partage 70 / 30. La regle du projet (build-auction.md E7) : la
    // division ronde en faveur du pool, jamais en faveur de l'appelant.
    // Le 30 % est brule par `mrn.burn`, qui exige `ERC20Burnable` (la
    // migration a MRN.sol livree en parallele de ce contrat). Le 70 %
    // restant est transfere au Pool qui le streamera aux LP via
    // `notifyRent` (I.4 remplacera le stub I.3 par l'accumulateur
    // reellement streame).
    uint256 burnAmount = pendingAmount * BURN_BPS / SPLIT_DEN;
    uint256 lpAmount = pendingAmount - burnAmount;
    ERC20Burnable(address(mrn)).burn(burnAmount);
    // Prime au caller de `settle()` : 0,1 % de lpAmount en MRN, preleve
    // sur le flux qui va aux LP. C'est un PUSH (pas un credit/pull comme
    // les `refunds`) : le caller est ici le bot qui nomme le gestionnaire,
    // pas un enchérisseur, donc hors du vecteur d'attaque R2 que la note
    // d'en-tete (point (2)) defend. Le reliquat `lpAmount - settleReward`
    // part au Pool via `notifyRent`.
    uint256 settleReward = lpAmount * SETTLE_REWARD_BPS / BPS_DEN;
    mrn.safeTransfer(msg.sender, settleReward);
    // M2 (I.7) : l'Auction ne POUSSE plus le MRN vers le Pool. C'est
    // `Pool.notifyRent` qui TIRE, en pull, sur l'approbation posee au
    // constructeur de l'Auction (cf. constructeur, I.7 #10). La garde
    // est exercee par la test suite (test_NotifyRentRevertsWithoutApproval,
    // I.7 #10) : sans approbation, le pull reverte
    // `ERC20InsufficientAllowance` et la totalite du settle (incluant
    // le burn ci-dessus) est annulee, laissant l'Auction et le Pool
    // dans l'etat d'avant. Le reseau economique de la part 70/30 reste
    // inchange (cf. I.7 #8) : 30 % detruits, 70 % arrives au Pool,
    // desquels 0,1 % partent maintenant au caller de settle.
    pool.notifyRent(lpAmount - settleReward);

    // Nomination du manager par `pool.setManager` (R3, point (3) de
    // l'entete). Appelee UNE SEULE FOIS par enchere, au moment du
    // settle, avec le `highBidder` du moment. La garde
    // `managerOf[epoch] != address(0)` de Pool.setManager (I.1) tient :
    // un second appel pour la meme epoch reverterait `ManagerAlreadySet`.
    //
    // L'appel est INCONDITIONNEL : la garde `_epoch > currentEpoch()`
    // du Pool (I.1) tient SEULE si `settle()` est appele pendant la
    // fenetre BID_SILENCE, quand `pendingEpoch == currentEpoch() + 1`.
    // C'est la voie canonique pour nommer un gestionnaire : le bot
    // appelle `settle()` pendant les 60 dernieres secondes de l'epoch
    // (la fenetre BID_SILENCE), avant que l'epoch ne tourne. Si
    // `settle()` est appele apres le basculement de l'epoch, la garde
    // du Pool revert `EpochAlreadyStarted` et le manager pour cette
    // epoch reste non designe (degradation R7 reprise du lot I.3).
    pool.setManager(pendingEpoch, manager);
    emit ManagerSet(pendingEpoch, manager);

    // Le tarif pose pour le mandat `pendingEpoch`. Le getter brut
    // `feeInForce()` lit `currentEpoch()`, pas l'epoch `pendingEpoch`,
    // donc on ne peut pas s'en servir directement. La lecture est
    // explicite : si le gestionnaire avait pose un tarif pour CE
    // mandat, `lastSetFeeEpoch == pendingEpoch` et `feeNum` est la
    // bonne valeur ; sinon, c'est `NOMINAL_FEE_NUM` (reset paresseux,
    // build-auction.md 4.2).
    uint256 fee = pool.lastSetFeeEpoch() == pendingEpoch
      ? uint256(pool.feeNum())
      : pool.NOMINAL_FEE_NUM();

    // Les trois reserves, lues a cet instant. Elles ne sont posees dans
    // aucun storage de l'Auction : c'est l'evenement qui les porte, et
    // le seul consommateur de cette donnee est la couche historique
    // (front, retunage A2, M10 — voir build-auction.md 5.4 bis).
    //
    // R2-bis — UN seul appel `pool.getReserves()` au lieu de trois
    // SLOADs cross-contract sur `pool.reserves(0/1/2)`. 1 SLOAD packe
    // cote Pool + 3 decoupages memoire cote Auction, contre 3 SLOADs
    // warm + 3 fois l'overhead d'appel externe. Ordre preserve :
    // `[r0, r1, r2]` = `[WBTC, cbBTC, LBTC]`, identique au triplet
    // precedent, identique a l'ordre historique des evenements
    // `Settled` emis sur la v1. La logique metier n'est pas touchee.
    (uint256 r0, uint256 r1, uint256 r2) = pool.getReserves();
    emit Settled(pendingEpoch, manager, pendingAmount, fee, [r0, r1, r2]);

    // Remise a zero. L'event est emis AVANT la remise a zero pour que
    // l'event porte la valeur encore valide, pas le zero qui suit.
    // Le slot pending est vide, ET l'etat d'enchere est reinitialise :
    // `highBid` et `highBidder` a zero, `sellingEpoch` au mandat
    // suivant. C'est necessaire pour que `test_SecondSettleRevertsNoBidToSettle`
    // passe : un second `settle()` trouve `highBidder == address(0)` et
    // revert `NoBidToSettle()`.
    pendingEpoch = 0;
    pendingAmount = 0;
    highBid = 0;
    highBidder = address(0);
    sellingEpoch = currentEpoch() + 1;
  }
}
