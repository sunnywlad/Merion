# User stories Merion — vérification contre la codebase

Source de vérité : `backend/contracts/` (`Pool.sol`, `Auction.sol`, `MRN.sol`,
`MrnFaucet.sol`, `MockWrappedBTC.sol`) + `hardhat.config.ts` + `test/README.md`.
Chaque story est marquée ✅ (confirmée par le code), ⚠️ (vraie mais imprécise),
ou ❌ (absente du code, à implémenter ou à réécrire).

---

## 1. Vérif par story

| # | Rôle | Énoncé | Statut | Preuve code / écart |
|---|------|--------|--------|---------------------|
| 1 | LP | Dépôt contre parts, retrait en brûlant | ⚠️ | `addLiquidity` (Pool.sol:630) + `removeLiquidity` (Pool.sol:701, `_burn`:712) existent. **Nuance** : on choisit 1 token « ancre » (`_anchorIndex`) mais les 3 tokens du panier sont prélevés (Pool.sol:678). Ce n'est **pas** un dépôt mono-token. |
| 2 | LP | Produit des enchères + frais (sans gestionnaire) en BTC enveloppé, part qui croît | ❌/⚠️ | Frais sans gestionnaire → 90 % restent dans les réserves en BTC (Pool.sol:753-782) ✅. **Mais** le « produit des enchères » revient aux LP en **MRN** (rente, `notifyRent` Auction.sol:464 → `claimRent` Pool.sol:954), pas en BTC. La part croît en MRN, pas en BTC. |
| 3 | Échangeur | Devis puis swap 1 BTC↔1 autre, slippage mini | ✅ | `get_dy` (Pool.sol:552) = devis ; `swap` avec garde `_minOut` (Pool.sol:774) + `BadSlippage`. |
| 4 | Arbitragiste | Lire réserves + échanger sans permission/compte | ✅ | `reserves(uint256)` publique (Pool.sol:395) ; `swap` permissionless (Pool.sol:740), aucun whitelist. |
| 5 | Arbitragiste | Miser sur le droit de gérer l'epoch suivante | ✅ | `placeBid` (Auction.sol:294), enchère montante +10 % (`HIGH_BID_BPS`, Auction.sol:82). |
| 6 | Gestionnaire élu | Fixer + percevoir le frais (bande) ; **seul à échanger au 1er bloc** | ⚠️/❌ | `setFee` (Pool.sol:569) : manager, fenêtre prioritaire, bande `[MIN_FEE_NUM, MAX_FEE_NUM/UNBALANCE_FACTOR]` (Pool.sol:574-578) ✅ ; `claimManagerFees` (Pool.sol:795) ✅. **Mais** « seul à échanger au premier bloc » est **absent** : `swap` n'a aucune exclusivité manager (Pool.sol:740). |
| 7 | Détenteur MRN | Usage on-chain indispensable | ⚠️ | MRN indispensable pour **enchérir** (`placeBid` tire le MRN, Auction.sol:325) et est **brûlé** à 30 % du règlement (Auction.sol:461). Pas requis pour swap/LP. À reformuler : rôle = enchère + burn sink. |
| 8 | Exploitant | Epoch sans enchérisseur → frais par défaut, pool jamais gelé | ✅ | `feeInForce` (Pool.sol:503) retombe sur `NOMINAL_FEE_NUM` ; sans manager `managerCut=0` et la branche expirée de `_settle` rend l'epoch non gérée au frais nominal (Auction.sol:448). |
| 9 | Exploitant | Pause dépôts+échanges, **plafonner dépôt par actif** | ⚠️/❌ | `pause()`/`unpause()` (Pool.sol:587-594) ferment `addLiquidity`+`swap` (sorties/claims restent ouverts, conforme). **Mais** aucun plafond de dépôt par actif en code** : `addLiquidity` ne vérifie que l'overflow uint72 (Pool.sol:667-669). Seul le bande de réserves 13/53 % (Pool.sol:53-56) borde indirectement la concentration. |
| 10 | Testeur | Mint BTC de test + cycle complet sur Base Sepolia | ✅ | `MockWrappedBTC.mint` permissionless (MockWrappedBTC.sol:34) ; `MrnFaucet.drip` permissionless (MrnFaucet.sol:74) ; réseau `baseSepolia` configuré (hardhat.config.ts:54, chainId 84532) + scripts `seed-faucet*`. |

---

## 2. Deux écarts à décider / implémenter

### A. Plafond de dépôt par actif (story 9) — ❌ manquant
Aucun `maxDepositPerAsset` n'existe. Piste d'implémentation dans `Pool.sol` :
```solidity
uint256[3] public maxDepositPerAsset;            // 0 = illimité
function setMaxDepositPerAsset(uint256[3] calldata caps) external onlyOwner;
// dans addLiquidity (branche else, après le calcul des amounts) :
require(cachedReserves[i] + amounts[i] <= maxDepositPerAsset[i] || maxDepositPerAsset[i] == 0, DepositCapExceeded(i));
```
À noter : le bande 13/53 % borne déjà un wrapper à ≤53 % du pool, mais ne limite pas un *dépôt* ponctuel avant qu'il n'atteigne la borne.

### B. Exclusivité du manager au premier bloc (story 6) — ❌ manquant
`swap` est ouvert à tous, y compris pendant la fenêtre prioritaire. Pour « corriger le premier écart », deux options :
- **Option 1 (alignée story)** : pendant la `PRIORITY_WINDOW` du début d'epoch, seul `managerOf[currentEpoch()]` peut appeler `swap`. Risque : contredit la story 4 (échange sans permission) pendant cette fenêtre — acceptable car temporaire.
- **Option 2 (plus sûre)** : supprimer la clause « seul à échanger au premier bloc » de la user story ; le droit acheté est déjà monétisé par `setFee` (fixer le frais) + `claimManagerFees` (percevoir). Le « correction du premier écart » devient une conséquence du frais fixé, pas d'une exclusion.

→ Recommandation : décider design avant d'écrire le code ; si exclusivité voulue, privilégier Option 1 bornée à la `PRIORITY_WINDOW`.

---

## 3. User stories corrigées / complétées

> Reformulations (en gras les corrections vs l'original).

**LP**
1. En tant que LP, je veux déposer des liquidités en désignant **un des trois BTC enveloppés comme ancre** (les trois tokens du panier sont prélevés proportionnellement) contre des parts MRNLP, et retirer ma liquidité en **brûlant** mes parts pour récupérer ma part proportionnelle des trois réserves.
2. En tant que LP, je veux que **les frais d'échange (hors quote) restent dans les réserves en BTC enveloppé quand aucun gestionnaire n'est élu** (90 % du frais de base, le reste allant au protocole), et que **le produit des enchères me revienne en MRN sous forme de rente** (`claimRent`), afin que la valeur de ma part croisse d'elle-même (en BTC via les réserves, en MRN via la rente).

**Échangeur**
3. En tant qu'échangeur, je veux consulter un devis via `get_dy` puis swapper un BTC enveloppé contre un autre avec une garde de slippage minimale (`_minOut`), afin de changer de wrapper en connaissant mon coût réel (frais de base + surcharge directionnelle si déséquilibré).

**Arbitragiste**
4. En tant qu'arbitragiste, je veux lire l'état des réserves (`reserves`) et échanger sans permission ni compte, afin de juger seul d'une opportunité et de l'exécuter aussitôt.
5. En tant qu'arbitragiste, je veux miser sur le droit de gérer l'epoch suivante en enchérissant en MRN (`placeBid`), afin de capturer la valeur d'arbitrage qu'il confère.

**Gestionnaire élu**
6. En tant que gestionnaire élu, je veux, dans la fenêtre prioritaire du début de mon epoch, **fixer** le frais de base dans la bande `[MIN_FEE_NUM, MAX_FEE_NUM/2]` via `setFee` et **percevoir** mes frais via `claimManagerFees`, afin de rentabiliser le droit acheté. *(Clause « seul à échanger au premier bloc » : voir décision §2-B — soit implémentée (Option 1), soit retirée.)*

**Détenteur du token natif (MRN)**
7. En tant que détenteur de MRN, je veux que le token ait un usage on-chain indispensable : **seul le MRN permet d'enchérir pour le droit de gestion** (`placeBid`) et **30 % de chaque règlement d'enchère est brûlé**, créant un puits de valeur incontournable.

**Exploitant**
8. En tant qu'exploitant, je veux qu'un epoch sans enchérisseur retombe sur le frais par défaut (`NOMINAL_FEE_NUM`) et reste non géré, afin que l'absence de demande ne gèle jamais le pool.
9. En tant qu'exploitant, je veux pouvoir mettre en pause dépôts et échanges (`pause`), **et plafonner le dépôt par actif** (à implémenter, §2-A), afin de contenir un incident et de borner la concentration sur un wrapper. *(Les retraits et claims restent ouverts même en pause, par conception.)*

**Testeur**
10. En tant que testeur, je veux minter des BTC de test (`MockWrappedBTC.mint`, permissionless) et du MRN (`MrnFaucet.drip`), puis parcourir le cycle complet (dépôt, swap, enchère, settle, claim) sur Base Sepolia (chainId 84532), afin de vérifier le protocole moi-même.

---

## 4. Synthèse

- **8/10 stories confirmées** (avec nuances pour 1, 2, 7).
- **2 écarts réels** :
  - Story 2 : le « produit des enchères » revient en **MRN**, pas en BTC — à corriger dans l'énoncé.
  - Story 6 : « seul à échanger au premier bloc » **non implémenté** — décision design requise.
  - Story 9 : **plafond de dépôt par actif manquant** — à implémenter (§2-A).
- **Nuances mineures** : dépôt multi-token (ancre + 2 autres) pour la story 1 ; MRN requis seulement pour l'enchère (story 7).
