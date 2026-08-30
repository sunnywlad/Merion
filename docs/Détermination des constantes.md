# Merion — Constantes et leurs arguments

**Statut** : documentation Merion v1, arrêtée au 2026-08-30. Tous les chiffres sont ceux du code livré. Les sources de vérité sont, par ordre de préséance : les contrats `Pool.sol` et `Auction.sol`, les modules Ignition `pool.ts` et `auction.ts`, puis le carnet de projet. Le code tranche ; le carnet argumente.

---

## 1. Contexte

Le Pool et l'Auction partagent une poignée de paramètres temps et MRN qui déterminent l'allocation du mandat, la fenêtre de repricing du fee, et le plancher d'enchère. Tous sont posés au constructeur, déclarés `immutable` côté contrat (ou capturés en lecture au déploiement pour `GENESIS` et `EPOCH_DURATION`), donc impossibles à bouger sans redéploiement complet. La justification économique vient de la partie tokenomics du carnet de projet ; la justification sécuritaire, en particulier pour les fenêtres, des audits F1, F2, F3, F7. Le présent fichier rassemble les deux angles et les fixe contre le code.

Trois nombres seulement sont arbitraires au sens fort : `EPOCH_DURATION`, `MIN_OPENING_BID` et la part brûlée `BURN_BPS = 3000`. Tous les autres s'en déduisent par cohérence (parité de la fenêtre de mise, plancher du fee, etc.) ou sont des rapports (`HIGH_BID_BPS = 11000` = +10 %, `LP_BPS = 7000` = 70 %).

---

## 2. Constantes principales

### 2.1 `EPOCH_DURATION = 14400` (4 heures)

**Source code**

`ignition/modules/pool.ts` ligne 7 :

```ts
const EPOCH_DURATION = 14400;
```

Passé au constructeur de `Pool` ligne 23, stocké en `immutable` dans `Pool.sol` ligne 110 :

```solidity
uint256 public immutable EPOCH_DURATION;
```

Utilisé par `currentEpoch()` (l. 433-435) — `(block.timestamp - GENESIS) / EPOCH_DURATION` — et par `Auction` qui en snapshot la valeur à son constructeur (l. 226-228) pour partager l'horloge avec le Pool sans drift possible.

**Argument du carnet**

Sur la durée d'époque : allonger amortit le coût fixe par enchère sur plus d'heures ; entre 4 h et une semaine, le gain mesuré est de 45 à 75 $ par an sur un produit plafonné à 10 544 $, soit 0,6 %. Raccourcir multiplie le nombre d'enchères, donc la rente LP quand l'enchère clôture au plancher : 15 330 MRN/an à 4 h contre 2 555 à 24 h.

L'audit F6 et l'analyse de la pause rappellent que `currentEpoch()` est une lecture pure sur `block.timestamp` et que l'horloge tourne pendant une pause — conséquence directe de l'immuabilité.

**Argument**

La durée est tirée vers le bas par un seul mécanisme : la borne haute est contraignante, la borne basse ne l'est pas. Côté borne haute, un gestionnaire hostile qui tarifie à `MAX_FEE_NUM / UNBALANCE_FACTOR = 25 bp` (cap du manager d'époque) ne capture aucun flux, les agrégateurs routant vers TriBitcoin à 5 bp ; le pool s'éteint pendant toute sa tenure, et la réintégration d'un adaptateur d'agrégateur qui rate ses quotes se négocie à la main — coût non linéaire, asymétrique. Côté borne basse, l'enchère de l'époque N+1 se tient pendant que N échange normalement : le ratio fenêtre/mandat n'impose aucun arrêt de service. Le gain marginal d'allonger (0,6 % du produit plafonné) est donc strictement inférieur au risque de borne haute, ce qui pousse vers le court sans optimum ferme.

Cohérence avec les autres fenêtres, toutes en secondes :

| Paramètre | Valeur | Part de l'époque |
|---|---|---|
| `EPOCH_DURATION` | 14 400 s (4 h) | 100 % |
| `AUCTION_WINDOW` | 900 s (15 min) | 6,25 % |
| `PRIORITY_WINDOW` | 240 s (4 min) | 1,67 % |
| `BID_SILENCE` | 60 s (1 min) | 0,42 % |

Le `PRIORITY_WINDOW = 240 s` (4 min) est 60 fois plus court que l'époque : il ouvre au manager élu une fenêtre confortable pour poser sa surcharge malgré la variance du séquenceur, puis le fee est figé pour les 14 160 s restantes. C'est un compromis assumé : la fenêtre est assez large pour qu'un `setFee` légitime atterrisse sans course, assez courte pour que le repricing reste borné au début du mandat. Le `BID_SILENCE = 60 s` est le délai visé pour l'appel à `settle()` par le bot hors chaîne ; il n'est PAS la garde elle-même — `placeBid` refuse tout bid passé `startOfEpoch(sellingEpoch - 1) + auctionWindow` et `settle` exige `block.timestamp >= closesAt` sur la même expression, donc bidding et settlement sont disjoints (parade F3).

**Conséquence sur le front**

`useFeeRouting` (frontend `hooks/useFeeRouting.ts`) utilise `scopeKey` keyed sur l'époque plus `staleTime: Infinity` pour ne relire `feeNum`, `lastSetFeeEpoch` et `manager()` qu'une fois par mandat, et non à chaque tick. À 15 s de polling de l'AuctionBar, 4 h = 960 lectures/mandat au maximum dans le pire cas d'un front mal configuré, contre 240 s de fenêtre de pricing côté contrat. La marge est suffisante pour absorber un round-trip RPC en cas de besoin sans jamais courir contre `PRIORITY_WINDOW`.

**Verdict** : 4 h est le bas d'un intervalle dont une seule extrémité est contraignante. Ce n'est pas un optimum, c'est l'extrémité dictée par le risque de borne haute.

---

### 2.2 `MIN_OPENING_BID = 10 MRN` (10 × 10^18 unités)

**Source code**

`ignition/modules/auction.ts` ligne 16 :

```ts
const MIN_OPENING_BID = 10_000_000_000_000_000_000n; // 10 MRN a 18 decimales
```

Passé au constructeur d'`Auction.sol` ligne 224, stocké en `immutable` ligne 65 :

```solidity
uint256 public immutable minOpeningBid;
```

Utilisé par `placeBid` (l. 316-318) :

```solidity
uint256 min = highBid * HIGH_BID_BPS / BPS_DEN;
if (min < minOpeningBid) min = minOpeningBid;
require(amount >= min, BidTooLow(min, amount));
```

**Argument du carnet**

Sur la mise minimale d'ouverture : baisser (1 MRN) relèverait de 0,43 $ à 4,33 $ le prix du MRN au-delà duquel plus personne n'enchérit, et allègerait le premier bid ; mais cela diviserait par dix la rente LP lorsque l'enchère clôture au plancher, ce qui est le cas nominal au volume mesuré. Augmenter (100 MRN) décuplerait cette rente mais abaisserait le plafond de prix à 0,043 $.

Le commentaire de la ligne 16 du module auction note `restated 2026-08-28, MRN target moved from $0.10 to $0.01` : la cible prix MRN a été revue à la baisse le 28/08. Avec `MIN_OPENING_BID` figé à 10 MRN, le plancher en dollars du bid vaut 10 MRN × 0,01 $/MRN = 0,10 $.

**Argument**

Trois rôles pour le plancher, à distinguer :

1. **Anti-spam ? Non.** Le bid est DÉPENSÉ (split 70/30, brûlé 30 %), pas immobilisé comme le loyer d'un hook Bunni. Un bid spammeur perd son MRN, il n'en immobilise pas. La fonction du plancher est ailleurs.
2. **Anti-clôture-à-vide.** Pour qu'une époque ne parte jamais pour rien quand il n'y a qu'un enchérisseur (argument du carnet). Si le plancher est à 0, un seul bidder peut poser `highBid = 0` et gagner le mandat à 0 MRN, brûlant 0, streamant 0 aux LPs. La rente LP s'effondre sans même qu'il y ait faute.
3. **Cohérence avec le plafond économique.** Le produit annuel de l'enchère plafonne à 10 544 $/an (relevé 22/08, volume BTC⇄BTC mesuré sur Base × part Merion à 5 bp × 90 % au manager). 4,33 $/mandat de 4 h. Si MRN cible 0,01 $, 10 MRN = 0,10 $, soit 2,3 % du plafond par mandat. Assez bas pour qu'un bidder rationnel puisse miser, assez haut pour qu'une époque vide ne se perde pas.

Trois nombres relatifs à comparer :

| Quantité | Valeur | Note |
|---|---|---|
| `MIN_OPENING_BID` | 10 MRN = 10^19 | plancher d'ouverture |
| `NOMINAL_FEE_NUM` | 5 bp | fee de base par défaut |
| `MAX_FEE_NUM` | 50 bp | cap absolu (surcharge incluse) |
| `BURN_BPS` / `LP_BPS` | 3 000 / 7 000 | split 30 % brûlé / 70 % LP (dont 0,07 % au bot settle, soit 69,93 % net) |

Rapport `MIN_OPENING_BID` × 11 / 10 = 11 MRN pour la surenchère minimale (`HIGH_BID_BPS = 11000`). Rapport `MIN_OPENING_BID` × 70 % ≈ 7 MRN streamés aux LPs par mandat plancher (69,93 % net de `SETTLE_REWARD_BPS`). À 2 190 époques/an, c'est de l'ordre de 15 330 MRN/an de rente minimale au plancher, contre 2 555 MRN/an si l'on passait à 24 h.

**Cible MRN revue 28/08**

La cible MRN est passée de 0,10 $/MRN à 0,01 $/MRN le 28/08 (cf. commentaire `auction.ts` l. 16). Avec `MIN_OPENING_BID` figé à 10 MRN, le plancher en dollars du bid est de 0,10 $ (10 MRN × 0,01 $/MRN). Le module ne dit pas pourquoi la cible a été revue, mais le carnet le précise : la cible prix MRN initialement ambitieuse (0,10 $) n'était pas défendable au regard de la TVL v1 (300 k$ au lancement, premier palier à 20 M$), et la ramener à 0,01 $ aligne la cible sur la capacité réelle du marché.

**Verdict** : 10 MRN est un choix d'unité tant que MRN n'a pas de prix, pas un arbitrage économique. Sa fonction est d'empêcher une clôture à zéro, pas de fixer un tarif de marché.

---

### 2.3 Paramètres dérivés (rappel)

| Constante | Valeur | Source code | Justification carnet |
|---|---|---|---|
| `PRIORITY_WINDOW` | 240 s (4 min) | `pool.ts` l. 8 | cahier des charges, §enchère |
| `NOMINAL_FEE_NUM` | 5 bp | `pool.ts` l. 10 | tokenomics, §split |
| `MIN_FEE_NUM` | 1 bp | `pool.ts` l. 9 | sécurité, §bande manager |
| `TREASURY` | `0xE280AD145C1ab859A05D7a4b1Ba2E6AC208A1a85` | `pool.ts` l. 11 | non argumenté dans le carnet |
| `PROTOCOL_FEE_BPS` | 1 000 (10 %) | `Pool.sol` l. 95 | tokenomics, §split |
| `AUCTION_WINDOW` | 900 s (15 min) | `auction.ts` l. 13 | cahier des charges, §enchère |
| `MAX_EXTENSION` | 0 | `auction.ts` l. 14 | sécurité, §A1 non livré |
| `BID_SILENCE` | 60 s (1 min) | `auction.ts` l. 15 | sécurité, §parade F3 |
| `HIGH_BID_BPS` | 11 000 (110 %) | `Auction.sol` l. 82 | cahier des charges, §+10 % |
| `BURN_BPS` / `LP_BPS` | 3 000 / 7 000 | `Auction.sol` l. 93 (LP_BPS) / 96 (BURN_BPS) | tokenomics, §part brûlée |
| `SETTLE_REWARD_BPS` | 10 (0,1 %) | `Auction.sol` l. 101 | sécurité, §récompense bot |

---

## 3. Tableau récapitulatif

| Constante | Valeur | Unité | Type Solidity | Argument-clé |
|---|---|---|---|---|
| `EPOCH_DURATION` | 14 400 | secondes (4 h) | `immutable` | Borne haute contraignante, gain marginal +0,6 % en allongeant |
| `PRIORITY_WINDOW` | 240 | secondes (4 min) | `immutable` | 1,67 % de l'époque, fenêtre de repricing du manager élu |
| `GENESIS` | `block.timestamp` au déploiement | unix | `immutable` | Lu par `currentEpoch()`, snapshot aussi côté Auction |
| `MIN_FEE_NUM` | 1 | bp | `immutable` | Borne basse de la bande manager |
| `NOMINAL_FEE_NUM` | 5 | bp | `immutable` | Fee de base par défaut, reset paresseux chaque époque |
| `MAX_FEE_NUM` | 50 | bp | `constant` | Cap absolu surcharge incluse |
| `PROTOCOL_FEE_BPS` | 1 000 | bp | `constant` | 10 % à la trésorerie (uniforme managé/non-managé) |
| `AUCTION_WINDOW` | 900 | secondes (15 min) | `immutable` | 6,25 % de l'époque, disjoint de la phase settle |
| `BID_SILENCE` | 60 | secondes | `immutable` | Délai visé pour le bot, PAS la garde (cf. F3) |
| `MAX_EXTENSION` | 0 | secondes | `immutable` | A1 soft-close non livré à I.3 |
| `MIN_OPENING_BID` | 10 × 10^18 | wei MRN (10 MRN) | `immutable` | Anti-clôture-à-vide, pas anti-spam |
| `HIGH_BID_BPS` | 11 000 | bp / 10 000 | `constant` | Surenchère +10 % |
| `BURN_BPS` | 3 000 | bp / 10 000 | `constant` | 30 % brûlés sur proceeds |
| `LP_BPS` | 7 000 | bp / 10 000 | `constant` | 70 % vers les LPs, 69,93 % net de la récompense settle |
| `SETTLE_REWARD_BPS` | 10 | bp / 10 000 | `constant` | 0,1 % de `lpAmount` au bot settle (0,07 % du proceeds) |
| `MINIMUM_LIQUIDITY` | 1 000 | parts | `constant` | Anti-inflation premier déposant, mort à `0x…dEaD` |

---

## 4. Changements récents et chantiers en cours

**Cible MRN revue 2026-08-28** : passage de 0,10 $/MRN à 0,01 $/MRN, documenté en commentaire de `auction.ts` ligne 16. Avec `MIN_OPENING_BID` figé à 10 MRN, le plancher en dollars du bid ouvert vaut 10 MRN × 0,01 $/MRN = 0,10 $. La partie tokenomics du carnet n'a pas encore été re-calibrée sur cette nouvelle cible ; les seuils à 1, 10 et 100 MRN restent défendables au titre du choix d'unité tant que MRN n'a pas de prix.

**Vickrey commit-reveal** (R7, voir `Roadmap.md`) : `Auction` est ouverte ascendante en MVP. Le passage en Vickrey est post-soutenance, retenu comme parade durable au frontrunning mempool. Aucun changement de constante à attendre en MVP.

**A1 soft-close** (`MAX_EXTENSION`) : posé à 0 à I.3, jamais activé. La parade F3 (`WindowStillOpen`) couvre l'intégrité du settlement sans avoir besoin d'extension.

**RPC Étape 5** (`useFeeRouting`) : `scopeKey` keyed sur l'époque + `staleTime: Infinity` pour passer d'une lecture par minute à une lecture par mandat. 960 lectures/mandat max au polling 15 s de l'AuctionBar, contre 240 s de `PRIORITY_WINDOW` côté contrat. La marge suffit à absorber un round-trip RPC supplémentaire au pire cas sans jamais courir contre la fenêtre de repricing.

**SafeERC20 + Math.ceilDiv** (G1, G2, 2026-08-26) : pas d'impact sur les constantes, mais huit call sites de transfert et deux divisions d'`addLiquidity` ont été refactorisés. Les valeurs des constantes restent celles déclarées au constructeur.

**Cap 21M des mocks** : tient `ReserveOverflow` hors de portée du panier actuel, mais ce n'est PAS un invariant du Pool, c'est une propriété du panier d'aujourd'hui — la garde `F8` a été rétablie sur la branche d'amorçage précisément pour fermer la dépendance implicite au plafond du mock (audit F8).

**Audit F7** (basse) : `lastSetFeeEpoch` seedé à `type(uint32).max` au constructeur pour ne pas collisionner avec l'époque 0 (sentinelle hors du domaine qu'elle garde).

**F6** (moyenne) : la voie d'amorçage `setManager` est bornée à `currentEpoch() + 1` (`OwnerEpochTooFar(maxEpoch)`). N'a pas touché les constantes.

---

## 5. Phrase à tenir à l'oral

> La durée d'époque de 4 h est le bas d'un intervalle dont une seule extrémité est contraignante — la borne haute, parce qu'un gestionnaire à 25 bp capture zéro flux et le pool s'éteint pendant sa tenure. La borne basse ne coûte rien, parce que l'enchère N+1 se tient pendant que N échange. La mise minimale d'ouverture de 10 MRN n'est pas un optimum non plus, c'est un choix d'unité tant que MRN n'a pas de prix, dont la fonction est d'empêcher une clôture à vide quand il n'y a qu'un seul bidder. Les deux nombres sont posés par argument, pas optimisés par calcul.

---

## 6. Sources

- `contracts/Pool.sol` — déclarations `EPOCH_DURATION`, `PRIORITY_WINDOW`, `NOMINAL_FEE_NUM`, `MIN_FEE_NUM`, `MAX_FEE_NUM`, `MINIMUM_LIQUIDITY`, et la constante `lastSetFeeEpoch` (sentinelle F7)
- `contracts/Auction.sol` — déclarations `minOpeningBid`, `auctionWindow`, `bidSilence`, `HIGH_BID_BPS`, `BURN_BPS`, `LP_BPS`, `SETTLE_REWARD_BPS`, et les gardes F1, F2, F3
- `ignition/modules/pool.ts` — `EPOCH_DURATION`, `PRIORITY_WINDOW`, `MIN_FEE_NUM`, `NOMINAL_FEE_NUM`, `TREASURY`
- `ignition/modules/auction.ts` — `AUCTION_WINDOW`, `MAX_EXTENSION`, `BID_SILENCE`, `MIN_OPENING_BID` (avec commentaire `restated 2026-08-28`)
- Carnet de projet Merion (RS6515) — arguments tokenomics, cahier des charges de l'enchère, audits de sécurité F1 à F8
- `frontend/src/hooks/useFeeRouting.ts` — `scopeKey` epoch + `staleTime: Infinity`