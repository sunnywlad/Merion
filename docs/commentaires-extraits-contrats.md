# Commentaires extraits des smart contracts Merion

Extraction verbatim, 2026-08-29. Aucune reecriture.

Les contrats ne conservent que la NatSpec (`///`) et la ligne SPDX. Tout commentaire `//` a ete retire du code et deplace ici, dans l'ordre du fichier.

Chaque bloc porte son fichier, sa plage de lignes d'origine, et la ligne de code qui le suivait immediatement (son ancre).


---

## `Pool.sol`

56 blocs, 365 lignes extraites.


### L32-41

Ancre : `uint256 private _reservesPacked;`

```
// I.2+R2 — packing des reserves en UN slot de 32 octets. Le format est
// [reserve0 : 72 | reserve1 : 72 | reserve2 : 72 | 40 bits libres], ce qui
// tient : 3 * 72 = 216 bits < 256. La lecture passe par le getter public
// `reserves(uint256)` qui preserve la signature ABI d'origine (les tests
// Pool.depeg, Pool.forgedState, Pool.removeLiquidity, Pool.swap, Pool.feeSplit
// et `Auction._settle` lisent `pool.reserves(i)`). L'ecriture passe par
// `_loadReserves` / `_storeReserves`, internes. Une seule
// SLOAD au lieu de 3, une seule SSTORE au lieu de 3 sur les chemins
// ecrivants (addLiquidity, removeLiquidity, swap) : economies d'environ
// 2 * 2100 + 2 * 5000 = ~14 200 gas sur le chemin nominal de swap.
```


### L54-63

Ancre : `uint16 public feeNum;`

```
// Slot packing : uint16 feeNum + uint32 lastSetFeeEpoch partagent UN slot de
// 32 octets, dont ils n'occupent que 6 ; les 26 restants sont libres.
// Le compilateur aligne feeNum sur les bits bas (16 bits) puis lastSetFeeEpoch
// au-dessus (32 bits), soit feeNum | (lastSetFeeEpoch << 16). 2 octets couvrent
// MAX_FEE_NUM = 50 ; 4 octets couvrent 4,3 milliards d'epochs (~4 970 ans à
// 4 h/epoch). priorityBlock a quitté ce slot avec l'exclusivité qu'il servait
// (septième passe, item 3) et ne reviendra pas.
// Aucune fonction n'écrit ce slot au passage d'epoch : la lecture passe par le
// reset paresseux, feeInForce() rend NOMINAL_FEE_NUM dès que lastSetFeeEpoch
// diffère de currentEpoch().
```


### L114-120

Ancre : `address public immutable mrn;`

```
// I.4 — MRN que le Pool doit connaitre pour transferer le loyer
// accumule en MRN aux LP via `claimRent`. L'Auction a deja sa
// propre reference (en argument de constructeur) ; le Pool
// prend la sienne en immuable de deploiement, ce qui l'expose
// a un changement de token MRN entre Pool et Auction seulement
// si le deploiement est incoherent — c'est une garde de plus
// contre un couplage mal assemble.
```


### L135-139

Ancre : `mapping(address manager => uint256[3]) public feesOwed;`

```
// I.2 — sortie des reserves : deux registres, l'un par gestionnaire
// (l'adresse du mandat, pas le role) et l'un global pour la part
// protocole. L'argent reste dans le pool tant que les fonctions de tirage
// ne l'ont pas pousse vers le manager ou vers la tresorerie, et CEI tient
// chaque tirage : remise a zero AVANT le transfert.
```


### L148-153

Ancre : `uint256 public accPerShare;`

```
// I.4 — loyer LP : un accumulateur `accPerShare` echelonne par 1e18,
// une dette par adresse, et un stream lineaire sur `EPOCH_DURATION`
// a partir de chaque `notifyRent`. La regle Synthetix/MasterChef tient :
// `pending = balance * accPerShare / 1e18 - rentDebt`. La mise a jour
// est paresseuse, declenchee par chaque touch (`_update`, `notifyRent`,
// `claimRent`), jamais par une boucle sur les LP.
```


### L241-242

Ancre : `error FeeOutOfBand(uint256 min, uint256 max);`

```
// Seule erreur de setFee à porter des arguments : c'est la seule dont
// l'appelant ne peut pas dériver la cause sans lire deux constantes.
```


### L249-251

Ancre : `error ZeroFeesOwed();`

```
// I.2 — appel d'un tirage alors que le registre est vide ; distincte de
// BadSlippage parce que la cause n'est pas un seuil rate mais une
// quantite nulle.
```


### L255

Ancre : `error NotAuction();`

```
// I.4 — notifyRent par un non-auction, claimRent sur un registre vide.
```


### L311-312

Ancre : `event RentNotified(uint256 amount, uint256 rate, uint256 end);`

```
// I.4 — loyer LP : notification d'un nouveau stream de rent, avec
// montant, taux par seconde (echelle 1e18) et timestamp de fin.
```


### L319

Ancre : `event RentClaimed(address indexed claimant, uint256 amount);`

```
// I.4 — tirage du loyer LP : quand un LP reclame sa part.
```


### L375-381

Ancre : `require(token0 != address(0) && token1 != address(0) && token2 != address(0), InvalidTokenAddress())`

```
// I.7 #3 : garde d'erreur de deploiement sur l'adresse nulle des
// trois jetons du panier, avant la garde de doublons et celle des
// decimales. Sans elle, `decimals()` reverterait en panic 0x21 (appel
// sur adresse nulle ERC-20) au lieu d'une erreur nommee : le
// deployer verrait un revert sans cause lisible. Meme classe que la
// garde decimales acceptee le 24-08 : le deployer doit pouvoir
// nommer la faute.
```


### L415-425

Ancre : `function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 reserve2) `

```
// R2-bis — vue de batch des trois reserves en un seul appel. Concu
// pour les consommateurs externes (Auction._settle) qui lisent
// `reserves(0/1/2)` separement, chacun payant un SLOAD warm
// cross-contract (~2 100 gas chacun). Un seul SLOAD sur le slot
// packe + trois decoupages en memoire cote caller, soit ~2 600 gas
// au total contre ~7 800. Le pattern de lecture reste strictement
// identique a `_loadReserves` (meme decoupage, meme `unchecked`),
// seule la surface publique change : `uint256` au lieu de `uint72`
// pour eviter au caller de re-caster. ABI tuple, pas de struct,
// pour rester compatible avec le pattern d'appel off-chain qui
// attend deja 3 valeurs positionnelles alignees sur `reserves(i)`.
```


### L448-452

Ancre : `function _loadReserves() internal view returns (uint72[3] memory r) {`

```
// I.2+R2 — helpers internes du packing de reserves. La lecture
// prend UN SLOAD et peuple un `uint72[3] memory` (les casts
// uint256→uint72 sont bornes par le shift, pas de risque
// d'overflow, d'ou le `unchecked`). L'ecriture prend UNE SSTORE,
// contre 3 dans la version `uint72[3]` (3 SSTOREs distincts).
```


### L524-545

Ancre : `function effectiveFeeNum(uint256 _indexIn, uint256 _indexOut) public view returns (uint256) {`

```
// I.2 — surcharge directionnelle, lue sur l'etat d'avant-swap.
// Le swap et get_dy passent tous deux par cette vue, ce qui garantit
// l'accord entre le devis execute et le devis quotable.
//
// DEUX BRANCHES, pas de palier intermediaire : la remise directionnelle
// (R3 bis) et la lecture au point milieu (E6) sont roadmap. La forme
// reduite tient la demi-journee du chantier, parce que le swap n'a qu'un
// appel a _getAmountOut et get_dy reste trois lignes au-dessus.
//
// La direction se compare sur les RESERVES, jamais sur les parts cibles,
// et depuis 2026-08-22 les trois cibles sont egales : la regle est exacte
// dans les deux sens, l'asymetrie du 45/45/10 ne reapparait que le jour
// ou les cibles cessent d'etre egales.
//
// BANDE MORTE lue sur TOL_DEN, JAMAIS sur FEE_DEN. Granularite de tarif
// et granularite de bande morte ne partagent pas un denominateur (voir
// build-auction.md 2.1).
//
// Le max dans la branche skew protege le cas biaise : un gestionnaire qui
// ecrit 0 en base ne peut pas rendre la piscine gratuite quand elle est
// la plus desiquilibree. C'est ce que bunni-v2 faisait avec
// max(amAmmSwapFee, surgeFee), voir build-auction.md 4.3 (1).
```


### L561-569

Ancre : `function _computeEffective(`

```
// I.2+R2 — variante `view` du calcul de frais effectif, parametree
// par la base de frais et par les reserves. `view` (et non `pure`)
// parce que `NOMINAL_FEE_NUM` est un `immutable` : Solidity le
// considere comme une lecture d'environnement. Permet a `swap` de
// partager la lecture de `feeInForce()` (2 SLOADs) et celle de
// `reserves` (1 SLOAD apres packing) avec le calcul du frais, sans
// repasser par la vue publique (qui re-ferait 2 + 1 SLOADs en
// interne). Pas de SLOAD supplementaire ici : `NOMINAL_FEE_NUM` est
// un PUSH sur l'immutable, comme dans l'original.
```


### L584-586

Ancre : `function _getAmountOut(uint72[3] memory _cachedReserves, uint256 _indexIn, uint256 _indexOut, uint25`

```
// I.2 — helper de prix, pur sur les reserves qu'on lui passe. Prend la
// forme d'un quotient de produit constant, sans frais : la function
// appelante (swap ou get_dy) a deja nette les frais de l'entree.
```


### L591-592

Ancre : `function get_dy(uint256 _indexIn, uint256 _indexOut, uint256 _dx) external view returns (uint256) {`

```
// I.2 — interface Curve. C'est la seule raison pour laquelle un
// agregateur peut coter ce pool.
```


### L606

Ancre : `uint72[3] memory cachedReserves = _loadReserves();`

```
// R2 — 1 SLOAD au lieu de 3 (meme packing que dans le swap).
```


### L613-624

Ancre : `function setFee(uint256 _feeNum) external {`

```
// Le seul levier du gestionnaire du mandat courant : il fixe la base de
// frais pour son epoch, une fois, au début de son mandat.
//
// La fenêtre de priorité borne setFee et SEULEMENT setFee. Elle n'accorde
// aucune exclusivité de swap : le design a retiré cette exclusivité, et le
// champ priorityBlock qui la servait, le 2026-08-25. La fenêtre n'est pas un
// droit d'échanger en premier, c'est le créneau pendant lequel le tarif de
// l'epoch se décide ; passé ce créneau, le tarif est figé pour tout le monde,
// gestionnaire compris.
//
// Pas de whenNotPaused, délibérément : la pause arrête ce qui déplace de la
// valeur entre les jambes du pool, et setFee n'en déplace pas.
```


### L637-641

Ancre : `uint256 epoch = currentEpoch();`

```
// R2 — `currentEpoch()` est calcule une seule fois et reutilise
// pour la garde d'epoch, l'event et la mise a jour de
// `lastSetFeeEpoch`. La division `(block.timestamp - GENESIS) /
// EPOCH_DURATION` devient gratuite cote deuxieme et troisieme
// appel.
```


### L645-651

Ancre : `require(lastSetFeeEpoch != epoch, FeeAlreadySetThisEpoch());`

```
// L'accès gestionnaire passe EN PREMIER, et c'est ce qui rend cette garde
// correcte. Au mandat 0, lastSetFeeEpoch vaut 0 et currentEpoch() vaut 0 :
// la garde serait fausse d'emblée et laisserait passer une écriture. Mais
// le mandat 0 ne peut JAMAIS avoir de gestionnaire, setManager exigeant
// _epoch > currentEpoch() ; managerOf[0] y rend donc address(0) et la garde
// d'accès referme avant. L'amorçage est fermé par du code, pas par une
// coïncidence de valeurs.
```


### L653-655

Ancre : `uint256 maxManagerFeeNum = MAX_FEE_NUM / UNBALANCE_FACTOR;`

```
// Le plafond du gestionnaire est dérivé à la volée, jamais MAX_FEE_NUM et
// jamais une seconde constante stockée : personne ne paie jamais plus de
// 0,50 %, et le gestionnaire écrit une base entre 0,01 % et 0,25 %.
```


### L699

Ancre : `uint256[3] memory amounts;`

```
// WBTC, LBTC and cbBTC all return true or revert on transferFrom, and none of them is a fee-on-transfer token: no need to check balanceOf
```


### L708-712

Ancre : `uint72[3] memory r = [`

```
// R2 — pool vide, une seule SSTORE suffit pour les trois reserves
// (le slot passe de 0 a la valeur packee, cout de cold SSTORE
// absorbe en une fois au lieu de trois). Le path bootstrap est
// le seul qui passait par un helper 3-args ; inliné en memory
// array pour converger sur la convention `_storeReserves`.
```


### L722-726

Ancre : `uint72[3] memory cachedReserves = _loadReserves();`

```
// R2 — pool amorce : 1 SLOAD au lieu de 3 pour la lecture des
// reserves, et la verification de ReserveOverflow utilise le
// cache memoire (l'absence d'autre ecrivain sur `reserves`
// dans cette fonction rend l'egalite exacte avec la lecture
// stockage d'origine).
```


### L733-737

Ancre : `amounts[0] = Math.ceilDiv(_amount * cachedReserves[0], cachedReserves[_anchorIndex]);`

```
// R2-ter — boucle deroulee en 3 lignes : 3 multiplications et
// 3 divisions sont inlinées, plus de compteur `i`, plus de
// test `i < 3`, plus de JUMP pour la fin de boucle. Le pattern
// est fixe (3 jambes, c.f. `token0/1/2` immuables), donc le
// deroulement est sans risque de drift.
```


### L749

Ancre : `_storeReserves(cachedReserves);`

```
// R2 — une seule SSTORE au lieu de 3 dans la version uint72[3].
```


### L804

Ancre : `uint72[3] memory cachedReserves = _loadReserves();`

```
// R2 — 1 SLOAD au lieu de 3 pour la lecture des reserves.
```


### L807-821

Ancre : `uint256 epoch = currentEpoch();`

```
// R2 — `feeInForce` est lu une seule fois et passe a
// `_computeEffective`, qui prend egalement le cache memoire. Avant
// le refactor, `effectiveFeeNum` re-lisait `feeInForce` (2 SLOADs)
// et `reserves` (3 SLOADs, puis 1 apres packing), et la baseAmount
// re-lisait `feeInForce` (2 SLOADs supplementaires). On tombe a 0
// re-lecture cote `swap`.
//
// R2-bis — `currentEpoch()` est calculee une seule fois et sert
// a la fois a `feeInForce` (inline) et a `manager()` (inline).
// Avant, les deux fonctions recalculaient `currentEpoch()`
// separement (2 DIV et 2 lectures de `lastSetFeeEpoch` /
// `managerOf` disjointes). Le `epoch` cache economise 1 DIV et 1
// appel de fonction ; la base fee lit `lastSetFeeEpoch` puis
// conditionnellement `feeNum`, et `currentManager` lit
// `managerOf[epoch]` directement sans repasser par `manager()`.
```


### L825-828

Ancre : `uint256 feeAmount = Math.ceilDiv(_amount * effective, FEE_DEN);`

```
// I.2 — le frais n'est plus une constante de pool, c'est une lecture
// d'etat partagee entre la base (feeInForce) et la surcharge
// directionnelle (effectiveFeeNum). ceilDiv : E7 — la division ronde
// en faveur du pool, jamais en faveur de l'appelant.
```


### L836-842

Ancre : `uint256 baseAmount = _amount * baseFee / FEE_DEN;`

```
// I.2 — partage (base, baseCut, protocolCut, managerCut) deplace AVANT
// la mise a jour memoire des reserves : les bandes (floor/ceiling)
// verifient le meme etat que l'ecriture, soit le flux net qui entre
// dans les reserves (cuts du manager et du protocole defalques). Sans
// cet ordre, les bandes s'appliqueraient a un etat sur evalue de
// `baseAmount`, le swap passerait la garde avec un pot que
// l'ecriture ne materialise pas.
```


### L844-854

Ancre : `uint256 protocolCut = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN;`

```
// I.7 #6 : plancher `protocolCut` = `baseAmount * PROTOCOL_FEE_BPS /
// SPLIT_DEN`, soit 10 % de la base (PROTOCOL_FEE_BPS = 1000 sur
// SPLIT_DEN = 10000). Le partage reste INTERNE : `protocolCut` +
// `managerCut` = `baseAmount` (90 % au manager) quand un
// gestionnaire est nomme, sinon `protocolCut` seul = `baseAmount/10`
// et le 9/10 restant tombe dans les reserves par defaut de
// gestionnaire (cf. commentaire des ecritures ci-dessous). Aucune
// fuite vers l'appelant : le swap recoit `amountOut` en jeton de
// sortie, le frais ne sort pas du pool avant `claimManagerFees` /
// `claimProtocolFees` (pull-only). Arbitrage tranche le 27-08 : le
// plancher reste, pas de liberte a la baisse.
```


### L860-865

Ancre : `unchecked {`

```
// R2 — au lieu d'allouer un second `uint256[3] memory
// afterSwapReserves`, on modifie `cachedReserves` en place. La
// ReserveOverflow verifiee ci-dessus garantit que l'addition
// tient dans uint72 ; InsufficientReserve garantit que la
// soustraction ne underflow pas. D'ou le `unchecked` (gain : pas
// de check arithmetique sur les deux operations).
```


### L871-872

Ancre : `uint256 ceilingTimesSum = uint256(ceiling) * sum;`

```
// R2 — `ceiling * sum` et `floor * sum` sont invariants dans la
// boucle des bandes, on les calcule une fois au lieu de trois.
```


### L876-880

Ancre : `require(uint256(cachedReserves[0]) * 100 < ceilingTimesSum, CeilingTouched(0));`

```
// R2-ter — boucle deroulee en 6 `require` (3 jambes × 2 sens),
// cf. `addLiquidity` ci-dessus pour la justification. Le pattern
// est fixe (3 jambes) et chaque garde se distingue uniquement par
// l'index passe en argument de l'erreur, donc le deroulement ne
// fait pas perdre de lisibilite.
```


### L890-900

Ancre : `_storeReserves(cachedReserves);`

```
// R2 — une seule SSTORE pour les trois reserves (le slot packe
// est ecrit entierement, contre 2 SSTOREs avant le packing).
// I.2 — ligne de credit des reserves (4.3, regle R5) et ecriture des
// deux registres. Le partage est asymetrique par construction :
// protocolCut + managerCut = baseAmount quand un gestionnaire est
// nomme (90 % / 10 %), mais seulement protocolCut = baseAmount/10
// sinon, le reste de la base (9/10) tombant dans les reserves par
// defaut de gestionnaire. La surcharge (feeAmount - baseAmount) reste
// dans les reserves dans les deux cas. Le manager ne touche JAMAIS
// la surcharge, sinon il profiterait du desequilibre qu'il tarifie
// (4.3 (4)). CEI tient : effets avant les transferts.
```


### L915-916

Ancre : `function claimManagerFees(uint256 _tokenIndex) external {`

```
// I.2 — tirage des frais du gestionnaire, pull-only. CEI tient : la
// remise a zero du registre precede le transfert, sans exception (5.6 (4)).
```


### L929-934

Ancre : `function claimProtocolFees(uint256 _tokenIndex) external {`

```
// I.2 — tirage de la part protocole, pull-only, payable a la tresorerie
// immuable. L'argent ne suit jamais la propriete (build-auction.md 4.2) :
// meme si owner() etait detourne, le flux de tresorerie ne le suivrait
// pas. Permissionless : n'importe qui peut declencher le virement vers
// la tresorerie, ce qui supprime la dependance a la bonne volonte d'un
// bot de gouvernance.
```


### L948-979

Ancre : `function _accProjected() internal view returns (uint256) {`

```
// I.4 — projection sans ecriture de l'accumulateur paresseux. C'est le
// seul calcul que `_updateRent` et `claimable` doivent partager, sans
// quoi la vue et le transfert derivent au premier changement de l'un
// des deux. `_updateRent` prend la valeur et l'ecrit, `claimable` la
// retourne telle quelle : l'invariant Foundry differentiel
// (la vue rend exactement ce que `claimRent` transfere) tient par
// construction, pas par coincidence.
//
// ECHELLE : `rentRate` porte deja le facteur 1e18 (pose par `notifyRent`,
// consomme par `/ 1e18` dans le repli de traine et dans `claimRent`).
// L'increment est donc `dt * rentRate / supply`, PAS `* 1e18` de plus :
// `accPerShare` = loyer par part x 1e18, et `claimRent` retire ce seul
// 1e18 par `balanceOf(x) * accPerShare / 1e18`.
//
// Sous-cas `supply == 0` (aucune part, ni vivante ni morte) : la
// tranche n'est pas accumulee ; `accPerShare` reste a sa valeur
// courante et `rentLastUpdate` n'est pas avance ici (c'est le role de
// `_updateRent`, voir ci-dessous). La tranche sautee n'est jamais
// reanimee par `_accProjected` : la rent correspondante reste en
// solde MRN du Pool, non reclamable. `claimable` rapporte donc la
// valeur figee a `rentLastUpdate`, identique a ce que `claimRent`
// transfererait apres le flush interne qu'il appelle.
//
// Sous-cas `supply == MINIMUM_LIQUIDITY` (I.7 #4) : seules les 1000
// parts mortes 0x...dEaD subsistent. La branche early-return de
// `notifyRent` empile alors le rent dans `rentLeftOver` et ne touche
// NI `accPerShare` NI `rentRate` NI `rentEnd`, donc cette garde
// n'atteint jamais l'increment : `supply > 0` mais `rentRate == 0`,
// et la formule `dt * rentRate / supply` rend 0 sans division. Le
// `claimable` de 0x...dEaD reste nul, conforme au E4 documente (la
// poussiere est differee, jamais perdue, distribuee au premier LP
// vivant via le repli de `rentLeftOver`).
```


### L981 *(commentaire de fin de ligne)*

Ancre : `uint256 end = block.timestamp < rentEnd ? block.timestamp : rentEnd;`

```
// stream fini ou jamais demarre
```


### L989-999

Ancre : `function _updateRent() internal {`

```
// I.4 — helper interne : flush l'accumulateur jusqu'a min(now, rentEnd).
// Aucune boucle sur les LP, c'est une multiplication et une division.
// L'early-return coupe court avant le premier `notifyRent` (rentEnd == 0
// et rentLastUpdate == 0) puis une fois le stream epuise (rentLastUpdate
// a rattrape rentEnd) : plus de SSTORE gaspille a chaque transfert.
// Chaque appel accumule sur `min(now, rentEnd) - rentLastUpdate`, donc
// toute la rent d'une epoch entre dans `accPerShare` meme si aucun
// `_update` n'a lieu entre `notifyRent` et la fin du stream.
//
// Le facteur 1e18 et le sous-cas supply nul sont documentes sur
// `_accProjected` ci-dessus, dont cette fonction prend la valeur.
```


### L1001 *(commentaire de fin de ligne)*

Ancre : `accPerShare = _accProjected();`

```
// stream fini ou jamais demarre
```


### L1006-1013

Ancre : `function claimable(address _who) external view returns (uint256) {`

```
// I.4 — vue du loyer reclamable par une adresse, fondation de
// l'invariant Foundry differentiel. Reproduit le calcul que `claimRent`
// realise cote transfert (accru - rentDebt + rentPending) sans appeler
// `_updateRent` (une `view` ne peut pas ecrire) et sans muter l'etat :
// c'est la projection pure, partagee via `_accProjected` avec le
// chemin d'ecriture, qui garantit l'alignement. Cote front, cette vue
// remplace le miroir `lib/rentClaimable.ts` et les huit lectures
// accumulees dans `useRentPosition` (hors de ce diff).
```


### L1028-1034

Ancre : `function _update(address from, address to, uint256 value) internal virtual override {`

```
// I.4 — override du choke point d'OZ v5 (5.6.1) : mint, burn et transfer
// passent tous par `_update`. L'ordre (1) → (5) est obligatoire :
// l'accru en attente des DEUX parties se capture sur leur solde
// PRE-transfert (etapes 2 et 4), puis leurs dettes se recalent sur le
// solde POST-transfert (etape 5). Chacun ne touche que le loyer couru
// pendant qu'il detenait ses parts : « a reward belongs to whoever held
// the shares WHILE it accrued, not to whoever holds them at claim time ».
```


### L1036-1037

Ancre : `_updateRent();`

```
// (1) Flush l'accumulateur jusqu'a maintenant. Cote sender et
// receiver voient la meme valeur d'`accPerShare`.
```


### L1039-1041

Ancre : `uint256 acc = accPerShare;`

```
// `_updateRent` est le seul point qui bouge `accPerShare` sur ce
// chemin (`super._update` ne le touche pas) : une seule lecture,
// reutilisee en (2), (4) et (5).
```


### L1044

Ancre : `if (from != address(0)) {`

```
// (2) Capturer le loyer en attente du sender (solde pre-transfert).
```


### L1053

Ancre : `super._update(from, to, value);`

```
// (3) Mise a jour des soldes (OZ v5).
```


### L1056-1061

Ancre : `uint256 toBalance;`

```
// (4) Capturer le loyer en attente du receiver sur son solde
// PRE-transfert : `balanceOf(to)` est deja post-`super._update`, le
// solde d'avant vaut `toBalance - value` (le receiver gagne exactement
// `value`, mint comme transfert). Le crediter sur le solde post
// compterait deux fois l'accru des `value` parts, deja porte au sender
// en (2). Symetrique de l'etape (2). Pas de capture si `to == from`.
```


### L1071-1076

Ancre : `if (from != address(0)) {`

```
// (5) Reinitialisation des dettes sur les soldes post-transfert. Le
// sender a maintenant `pre - value` parts, le receiver `pre + value`.
// Leur futur loyer cumulera a partir de `balance * accPerShare /
// 1e18` qui vaut leur nouveau solde * l'accumulateur courant.
// `toBalance` est deja le solde post-transfert du receiver, capture
// en (4) sous la meme condition : pas de second SLOAD cote receiver.
```


### L1085-1110

Ancre : `function notifyRent(uint256 amount) external {`

```
// I.4 — point d'entree du loyer. Reserve a l'auction (setAuction
// est one-shot, donc personne d'autre ne peut l'appeler). Flush le
// stream courant, puis pose le nouveau rate et le nouvel end.
//
// Cas E4 (premier mandat, totalSupply == MINIMUM_LIQUIDITY, soit
// seules les parts mortes existent) : on accumule le rent dans
// `rentLeftOver` et on ne modifie pas l'accumulateur. Le residu
// sera distribuable a un futur LP, mais la part acquise aux parts
// mortes de 0x...dEaD reste non reclamable — c'est la reponse
// honnete a « ou va la poussiere ? » documentee dans
// build-auction.md 4.4 (1).
//
// M2 (I.7) : le MRN est tire en PULL, pas pousse par l'Auction. Le
// decouplage entre les deux contrats est l'argument load-bearing :
// `notifyRent` EST deja garde `onlyAuction` (NotAuction, teste) ; le
// pull ne rajoute aucune parade, il garantit que la garde de cablage
// (approbation Auction -> Pool, posee au constructeur de l'Auction,
// cf. `Auction.sol` constructeur) est l'unique condition manquante.
// Sans approbation, `safeTransferFrom` reverte `ERC20InsufficientAllowance`
// et la totalite de la transaction est annulee, y compris les effets
// d'etat poses plus haut (re-base, rentLeftOver, rentRate, rentEnd,
// rentLastUpdate) : c'est l'echec bruyant documente en I.7 #10,
// preferable a une sur-declaration silencieuse. Le retrait du
// `safeTransfer` de `_settle` rend l'argument vrai PAR CONSTRUCTION :
// les deux contrats n'ont plus besoin de transferer l'un vers l'autre,
// chacun n'a qu'a connaitre l'adresse de l'autre et l'approbation.
```


### L1126-1132

Ancre : `rentLeftOver += amount;`

```
// Seules les parts mortes 0x...dEaD subsistent (ou aucune part) :
// dEaD ne reclame jamais, la rent ne peut aller a personne. Elle
// s'empile dans `rentLeftOver`, repliee integralement par le prochain
// `notifyRent` fait avec `totalSupply() > MINIMUM_LIQUIDITY` et
// distribuee aux LP alors presents, jamais rendue recouvrable par un
// admin (build-auction.md E4). Valeur differee, pas perdue : la voie
// de retour est le fonctionnement nominal du protocole.
```


### L1135-1142

Ancre : `if (rentEnd > block.timestamp) {`

```
// Re-base du stream : la traine non encore distribuee du stream courant
// (`rentRate * temps restant`, echelle 1e18) est reversee dans
// `rentLeftOver` avant l'ecrasement de `rentRate`, sinon elle
// disparaitrait en silence. `_updateRent()` a deja fige l'accru jusqu'a
// maintenant, donc la periode ecoulee n'est pas comptee deux fois. Si
// le stream courant est deja expire la traine vaut zero et seul le
// `rentLeftOver` deja present (cycle supply bas anterieur) compte, ce
// que la formule ci-dessous gere sans branche supplementaire.
```


### L1152-1156

Ancre : `IERC20(mrn).safeTransferFrom(msg.sender, address(this), amount);`

```
// CEI strict : effets d'etat poses AVANT l'interaction externe. Une
// rejection ici (allowance ou balance de l'Auction) revert
// integralement la transaction, donc rien de ce qui precede n'est
// engage. Un appel ulterieur rejoue alors le meme scenario sur le
// meme `rentLeftOver` / `rentRate` / `rentEnd`.
```


### L1160-1168

Ancre : `function claimRent() external {`

```
// I.4 — tirage du loyer LP, pull-only. Flush l'accumulateur, puis ajoute
// l'accru vivant du claimant sur son solde courant : un LP passif qui ne
// bouge jamais ses parts n'a rien dans `rentPending` (alimente seulement
// par `_update`), il faut donc lire `balanceOf * accPerShare / 1e18 -
// rentDebt` ici aussi. On y ajoute le `rentPending` deja capture par les
// transferts passes, puis on refixe la dette sur l'accru courant. CEI
// strict : toutes les ecritures d'etat (`rentDebt`, `rentPending`)
// precedent le transfert, un transfert qui revert ne donne pas de
// double claim.
```


### L1182-1191

Ancre : `rentDebt[msg.sender] = accrued;`

```
// I.7 #7 : `rentDebt = accrued` est INCONDITIONNEL, contrairement
// au `if` ci-dessus qui ne paye la diff que si `accrued > rentDebt`.
// C'est intentionnel : `rentDebt` est une dette checkpoint, pas un
// solde cumule. Le rebaser sur l'accru courant a chaque claim (meme
// quand l'accru n'a pas bouge, par troncature entiere) garantit
// que le prochain claim diff depuis le bon point de depart, sans
// piéger un `rentDebt` desynchronise du `accPerShare` courant.
// Mettre l'ecriture dans le `if` la rendrait dependante du paiement
// de la diff, et une succession de claims a `accrued == rentDebt`
// (troncature au wei pres) figerait `rentDebt` au point precedent.
```


---

## `Auction.sol`

51 blocs, 418 lignes extraites.


### L12-89

Ancre : `contract Auction {`

```
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
```


### L103-105

Ancre : `uint256 internal immutable genesis;`

```
// -------------------------------------------------------------------------
// Immuables
// -------------------------------------------------------------------------
```


### L107-110

Ancre : `uint256 internal immutable genesis;`

```
// Lues du Pool a la construction (4.5) : la copie locale garantit que les
// deux horloges ne peuvent pas deriver, et chaque lecture de
// `currentEpoch()` ou de `startOfEpoch` reste un calcul memoire, jamais un
// appel externe.
```


### L114-117

Ancre : `uint256 public immutable auctionWindow;`

```
// L'argument de deploiement qui n'a pas d'ancre on-chain : on l'immutable
// sur l'Auction, et il vit dans le record de deploiement (ignition) et
// dans les tests. Voir build-auction.md 2.2 et 5.0 bis pour les valeurs
// de demonstration (15 min, 0, 0, 10 MRN a 18 decimales, restated 2026-08-28).
```


### L143-146

Ancre : `address public immutable treasury;`

```
// Le tresor du Pool, recadre en immutable ici pour qu'un `settle()`
// n'ait pas a relire le Pool. Ce n'est PAS le tresor des produits de
// l'enchere : R6 dit explicitement qu'il n'y a pas de part tresorerie
// sur le produit, et c'est la constante `BURN_BPS` qui le dit.
```


### L152-154

Ancre : `uint256 constant public HIGH_BID_BPS = 11000;`

```
// -------------------------------------------------------------------------
// Constantes
// -------------------------------------------------------------------------
```


### L156-168

Ancre : `uint256 constant public HIGH_BID_BPS = 11000;`

```
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
```


### L177-182

Ancre : `uint256 constant public SPLIT_DEN = 10000;`

```
// Le partage du produit de l'enchere : 70 % LP, 30 % brule (R6, point 5
// du brief). Pas de part tresorerie : tout le flux va soit au pool (qui
// le stream aux LP via `notifyRent` a I.4), soit a la destruction par
// `mrn.burn`. Le denominateur partage est `SPLIT_DEN`, distinct du
// `BPS_DEN` du `HIGH_BID_BPS` (regle : un seul denominateur par calcul,
// jamais partage).
```


### L194-202

Ancre : `uint256 constant public SETTLE_REWARD_BPS = 10;`

```
// Prime au caller de `settle()` (le bot qui nomme le gestionnaire) :
// 0,1 % de lpAmount, paye en MRN depuis le solde de l'Auction, preleve
// sur le flux qui va aux LP. Ferme l'incitation faible documentee par
// la revue I.7 : sans elle, seul le futur gestionnaire a un interet
// direct a appeler settle(), et l'enchere peut rester en suspens
// (managerOf[epoch] reste a address(0), les LP ne touchent pas la rente,
// le mandat suivant ne demarre qu'apres une nouvelle mise qui capture
// l'ancien etat). Le denominateur est BPS_DEN, partage avec HIGH_BID_BPS
// (regle du projet : un seul denominateur par calcul, jamais partage).
```


### L208-210

Ancre : `uint256 public sellingEpoch;`

```
// -------------------------------------------------------------------------
// Storage mutable
// -------------------------------------------------------------------------
```


### L212-215

Ancre : `uint256 public sellingEpoch;`

```
// L'enchere en cours vend le mandat `sellingEpoch`. La regle d'or :
// `sellingEpoch == currentEpoch() + 1` SI l'enchere est active. Sinon le
// slot appartient a une enchere finie et il est rouvert a zero par
// comparaison (voir entete de contrat, point (1)).
```


### L227-231

Ancre : `uint256 public pendingEpoch;`

```
// Le mandat gagne mais pas encore regle. `pendingEpoch == 0 &&
// pendingAmount == 0` designe le slot vide, et c'est ce que `settle()`
// verifie pour reverter `NoBidToSettle()` quand il n'y a rien a faire.
// Il ne peut y avoir plus d'un mandat en attente a la fois, parce que
// l'ouverture d'une nouvelle enchere regle ce qui trainait dans le slot.
```


### L239-240

Ancre : `mapping(address => uint256) public refunds;`

```
// Refunds credits et jamais pousses (R2, point (2) de l'entete). Pull
// only, par `withdrawRefund()`. CEI tient sur le tirage.
```


### L245-247

Ancre : `error BidTooLow(uint256 min, uint256 provided);`

```
// -------------------------------------------------------------------------
// Erreurs
// -------------------------------------------------------------------------
```


### L264-266

Ancre : `event BidPlaced(uint256 indexed epoch, address indexed bidder, uint256 amount);`

```
// -------------------------------------------------------------------------
// Evenements
// -------------------------------------------------------------------------
```


### L283-286

Ancre : `event ManagerSet(uint256 indexed epoch, address indexed manager);`

```
// Re-emis ici pour l'indexation par adresse. Le contrat Pool emet aussi
// `ManagerSet` ; cette deuxieme emission donne aux clients un seul
// endpoint d'audit par encherisseur, sans avoir a scanner les logs de
// Pool. Voir build-auction.md 5.3.
```


### L294-298

Ancre : `event Settled(uint256 indexed epoch, address indexed manager, uint256 clearingPrice, uint256 fee, ui`

```
// L'evenement de cloture de mandat (5.4 bis, point 7 du brief) : index,
// gestionnaire, prix de cloture, tarif pose, et les trois reserves lues
// a cet instant. Un evenement, aucun stockage, rien sur le chemin du
// swap. Il ne porte PAS le revenu de frais du mandat (derivable hors
// chaine des `Swapped`).
```


### L312-314

Ancre : `constructor(`

```
// -------------------------------------------------------------------------
// Constructeur
// -------------------------------------------------------------------------
```


### L342-344

Ancre : `Pool p = Pool(_pool);`

```
// GENESIS et EPOCH_DURATION sont lus du Pool, pas passes en argument :
// c'est l'unique facon de garantir que les deux horloges ne peuvent
// pas deriver. Voir build-auction.md 4.5.
```


### L356-360

Ancre : `treasury = p.treasury();`

```
// Recadre en immutable cote Auction pour eviter une lecture du Pool
// dans `settle()`. R6 : il n'y a pas de part tresorerie sur le
// produit de l'enchere, donc ce `treasury` n'est jamais touche par
// `settle()`. Il est pose ici uniquement parce que la construction de
// `pool` le rend gratuit.
```


### L363-372

Ancre : `IERC20(_mrn).approve(address(p), type(uint256).max);`

```
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
```


### L376-378

Ancre : `function currentEpoch() public view returns (uint256) {`

```
// -------------------------------------------------------------------------
// Vues
// -------------------------------------------------------------------------
```


### L380-382

Ancre : `function currentEpoch() public view returns (uint256) {`

```
// `(block.timestamp - genesis) / epochDuration`, derive pur. Pas de
// compteur, pas de keeper (R1) : la formule est recomputable hors chaine
// par un front qui connait GENESIS et EPOCH_DURATION.
```


### L397-405

Ancre : `function windowOpen() public view returns (bool) {`

```
// La fenetre d'enchere est OUVERTE si et seulement si :
//   - `sellingEpoch` designe bien le mandat suivant (`currentEpoch() + 1`) ;
//   - `block.timestamp` est sous la borne superieure, calculee comme
//     `startOfEpoch(sellingEpoch - 1) + auctionWindow` (point 1 du brief,
//     build-auction.md 4.5).
// Aucune garde sur la borne inferieure (debut de la fenetre) ici : elle
// est silencieusement ouverte par le `sellingEpoch != currentEpoch() + 1`
// qui reinitialise tout a zero, et un appel avant ce moment equivaut a
// un appel sur une enchere vide.
```


### L414-416

Ancre : `function closesAt() public view returns (uint256) {`

```
// L'horodatage de cloture dure de l'enchere, expose pour le front.
// Rendu en memoire pure, pas de reinitialisation : la vue n'a pas
// d'effet de bord.
```


### L428-430

Ancre : `function startOfEpoch(uint256 epoch) internal view returns (uint256) {`

```
// -------------------------------------------------------------------------
// Helpers internes
// -------------------------------------------------------------------------
```


### L440-442

Ancre : `function placeBid(uint256 amount) external {`

```
// -------------------------------------------------------------------------
// placeBid
// -------------------------------------------------------------------------
```


### L444-458

Ancre : `function placeBid(uint256 amount) external {`

```
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
```


### L471-477

Ancre : `function placeBid(uint256 amount) external {`

```
//
// La nomination du gestionnaire par `pool.setManager` est reportee a
// `_settle()` (point (3) de l'entete). Pendant toute la duree de
// l'enchere, `pool.managerOf(sellingEpoch) == address(0)`, et seul
// `auction.highBidder()` rend le meneur courant. Le front ne lit
// `pool.managerOf(epoch)` qu'apres le `settle()` externe, appele par
// le bot pendant la fenetre BID_SILENCE.
```


### L479-497

Ancre : `uint256 nextEpoch = currentEpoch() + 1;`

```
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
```


### L509-522

Ancre : `uint256 closesAt_ = startOfEpoch(sellingEpoch - 1) + auctionWindow;`

```
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
```


### L529-535

Ancre : `uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;`

```
// `maxExtension` est l'unique piece du soft close (A1). Sa valeur a
// I.3 est 0 (build-auction.md 5.0 bis), donc cette soustraction ne
// mord pas, et la fenetre reste inchangee. Le commentaire FIXME tient
// la place du gate A1 futur.
// FIXME: gate A1 (soft close) — quand `maxExtension > 0`, retrancher
// `maxExtension` de la borne haute pour ouvrir plus tot et permettre
// l'extension tardive.
```


### L537-546

Ancre : `uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;`

```
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
```


### L548-553

Ancre : `uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;`

```
// (3) Seuil. La hausse minimale est +10 % (build-auction.md 5.3 (3),
// HIGH_BID_BPS = 11000 sur BPS_DEN = 10000). `highBid` valant 0 pour
// la premiere mise, `highBid * 11000 / 10000` rend 0, donc le seuil
// effectif est `MIN_OPENING_BID`. Le `max` evite une double
// verification et protege la borne inferieure pour les encheres
// vides.
```


### L558-563

Ancre : `if (highBidder != address(0)) {`

```
// (4) Credit du precedent `highBidder` dans `refunds`. PAS DE
// TRANSFERT (R2, point (2) de l'entete). La CEI interne : on ecrit
// d'abord le refund, on emit l'evenement, on transfert le MRN
// seulement ensuite. Un revert sur le `safeTransferFrom` du (5)
// laisserait le refund credite ; c'est un etat coherent parce que
// l'encherisseur precedent peut deja le tirer.
```


### L569-572

Ancre : `mrn.safeTransferFrom(msg.sender, address(this), amount);`

```
// (5) Tirage du MRN. Le caller doit avoir `approve` l'Auction pour au
// moins `amount` MRN ; un manque d'allowance revert avec
// `ERC20InsufficientAllowance`, distinct de toute erreur `Auction.*`
// parce que la garde d'allowance vit dans l'ERC-20, pas ici.
```


### L575-580

Ancre : `highBid = amount;`

```
// (6) Ecriture de l'etat d'enchere. Doit suivre le tirage, parce
// qu'un revert sur le tirage ne doit pas avoir laisse un faux
// `highBidder` designe. La nomination du gestionnaire n'est PAS
// faite ici : voir point (3) de l'entete. Le `highBidder` est le
// meneur COURANT de l'enchere, pas forcement le futur gestionnaire
// — une surenchere sur la meme enchere peut le chasser.
```


### L584-588

Ancre : `emit BidPlaced(sellingEpoch, msg.sender, amount);`

```
// (7) Emission finale de `BidPlaced`. Aucun `pool.setManager` ici :
// la nomination est differee a `_settle()` (point (3) de l'entete).
// Pendant toute la duree de l'enchere, `pool.managerOf(sellingEpoch)`
// reste a `address(0)`, et le front lit `auction.highBidder()` pour
// afficher le meneur courant.
```


### L592-594

Ancre : `function withdrawRefund() external {`

```
// -------------------------------------------------------------------------
// withdrawRefund
// -------------------------------------------------------------------------
```


### L596-600

Ancre : `function withdrawRefund() external {`

```
// Pull-only, CEI strict (5.6 (4)) : la remise a zero du registre
// PRECEDE le transfert, sans exception. L'invariant que cette garde
// tient : un encherisseur contrat qui reverte a la reception ne bloque
// ni la mise courante (R2, point (2) de l'entete) ni le tirage
// ulterieur d'un refund bien merite.
```


### L614-616

Ancre : `function settle() external {`

```
// -------------------------------------------------------------------------
// settle
// -------------------------------------------------------------------------
```


### L618-641

Ancre : `function settle() external {`

```
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
```


### L655-662

Ancre : `if (highBidder == address(0)) {`

```
// Le slot est vide, mais l'enchere COURANTE peut encore etre
// reglee si elle a un `highBidder` et designe bien le mandat
// suivant (`sellingEpoch == currentEpoch() + 1`). C'est le
// chemin qu'un `settle` externe prend quand il est appele
// directement apres les `placeBid`, sans attendre la reinit
// d'une nouvelle enchere : sans cette capture, `settle`
// reverterait `NoBidToSettle()` et la garde `ManagerAlreadySet`
// empecherait toute nomination par la suite.
```


### L672-685

Ancre : `function _settle(address manager) internal {`

```
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
```


### L692-698

Ancre : `uint256 burnAmount = pendingAmount * BURN_BPS / SPLIT_DEN;`

```
// Le partage 70 / 30. La regle du projet (build-auction.md E7) : la
// division ronde en faveur du pool, jamais en faveur de l'appelant.
// Le 30 % est brule par `mrn.burn`, qui exige `ERC20Burnable` (la
// migration a MRN.sol livree en parallele de ce contrat). Le 70 %
// restant est transfere au Pool qui le streamera aux LP via
// `notifyRent` (I.4 remplacera le stub I.3 par l'accumulateur
// reellement streame).
```


### L702-707

Ancre : `uint256 settleReward = lpAmount * SETTLE_REWARD_BPS / BPS_DEN;`

```
// Prime au caller de `settle()` : 0,1 % de lpAmount en MRN, preleve
// sur le flux qui va aux LP. C'est un PUSH (pas un credit/pull comme
// les `refunds`) : le caller est ici le bot qui nomme le gestionnaire,
// pas un enchérisseur, donc hors du vecteur d'attaque R2 que la note
// d'en-tete (point (2)) defend. Le reliquat `lpAmount - settleReward`
// part au Pool via `notifyRent`.
```


### L710-719

Ancre : `pool.notifyRent(lpAmount - settleReward);`

```
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
```


### L722-736

Ancre : `pool.setManager(pendingEpoch, manager);`

```
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
```


### L740-746

Ancre : `uint256 fee = pool.lastSetFeeEpoch() == pendingEpoch`

```
// Le tarif pose pour le mandat `pendingEpoch`. Le getter brut
// `feeInForce()` lit `currentEpoch()`, pas l'epoch `pendingEpoch`,
// donc on ne peut pas s'en servir directement. La lecture est
// explicite : si le gestionnaire avait pose un tarif pour CE
// mandat, `lastSetFeeEpoch == pendingEpoch` et `feeNum` est la
// bonne valeur ; sinon, c'est `NOMINAL_FEE_NUM` (reset paresseux,
// build-auction.md 4.2).
```


### L751-762

Ancre : `(uint256 r0, uint256 r1, uint256 r2) = pool.getReserves();`

```
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
```


### L766-772

Ancre : `pendingEpoch = 0;`

```
// Remise a zero. L'event est emis AVANT la remise a zero pour que
// l'event porte la valeur encore valide, pas le zero qui suit.
// Le slot pending est vide, ET l'etat d'enchere est reinitialise :
// `highBid` et `highBidder` a zero, `sellingEpoch` au mandat
// suivant. C'est necessaire pour que `test_SecondSettleRevertsNoBidToSettle`
// passe : un second `settle()` trouve `highBidder == address(0)` et
// revert `NoBidToSettle()`.
```


---

## `MRN.sol`

1 blocs, 7 lignes extraites.


### L7-13

Ancre : `contract MRN is ERC20, ERC20Burnable {`

```
// I.3 — MRN herite desormais ERC20Burnable. Le motif tient en une phrase
// (build-auction.md 4.5) : `mrn.burn(30 %)` est la moitie droite du partage
// des produits de l'enchere, et un ERC-20 sans `burn` ne peut pas le faire
// sans mentir, parce qu'un transfert vers 0x...dEaD ne reduit pas le
// `totalSupply`. La migration de bytecode change les adresses deterministes
// du deploiement MRN : le module Ignition `mrn.ts` continue de fonctionner,
// mais la nouvelle MRN n'herite d'aucune ancienne adresse.
```


---

## `MockWrappedBTC.sol`

0 blocs, 0 lignes extraites.


---

## `MrnFaucet.sol`

2 blocs, 24 lignes extraites.


### L8-25

Ancre : `contract MrnFaucet is Ownable {`

```
// V.0 — Faucet MRN pour la démo de soutenance et les consultants. Un seul
// trésor pré-alloué, pas de mint, pas d'inflation : la supply reste celle
// créditée au déployeur à la construction du MRN (« MRN has NO mint
// function » dans `merion.md`). Le motif vient des faucets BTC du début de
// la blockchain — un réservoir pré-financé, pas une création de monnaie.
//
// Fonctionnement :
//   1. Au déploiement, le déployeur (owner du pool) transfère 10 M MRN
//      depuis son solde vers ce contrat, via un script de seed.
//   2. N'importe qui appelle `drip()` et reçoit `dripAmount` MRN, sous
//      réserve du rate-limit `dripInterval` par adresse.
//   3. L'owner peut retirer le résiduel via `withdraw()` à la fin de la
//      soutenance ou pour re-financer ailleurs.
//
// Pas de `dripTo()` : il n'y a pas de liste blanche de jurés. Le rate-limit
// empêche un acteur unique de vider le faucet ; tous les autres y ont accès
// dans la même fenêtre. La pré-alimentation est calibrée pour la démo et
// les consultants, pas pour un usage production.
```


### L93-98

Ancre : `uint256 lastDrip = lastDripAt[msg.sender];`

```
// R2 — la lecture de `lastDripAt[msg.sender]` est mise en cache
// dans une locale, ce qui elimine une deuxieme SLOAD (la 1re
// est obligatoire, la 2e suivait immediatement pour le calcul
// de `nextAllowedAt`). Le `TooEarly` emporte la valeur
// recalculee (`lastDrip + dripInterval`), pas la locale, pour
// preserver l'ABI d'erreur exacte.
```
