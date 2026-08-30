# Mécanique d'enchère — Merion v1

Cycle d'enchère ascendante ouverte sur la nomination du gestionnaire de chaque
mandat. Dérivé de `ignition/modules/auction.ts`, `contracts/Auction.sol` et du
carnet de projet.
**Distinct** de [Détermination des constantes.md](<Détermination des constantes.md>)
(chiffres et barèmes) et de [Logique des smart contracts.md](<Logique des smart contracts.md>)
(architecture globale). Ici : la mécanique seule, pas les nombres ni les
raisons transverses.

---

## 1. Pourquoi une enchère, pas un fee statique

Le protocole vend chaque mandat de 4 h au plus offrant, payé upfront en MRN,
plutôt que de figer un fee administré. Trois conséquences :

- **Tarification dynamique par mandat.** Le fee effectivement facturé n'est
  pas choisi en gouvernance, il émerge de la valeur qu'un gestionnaire
  actif prête à payer pour le droit de le fixer. Six fois par jour sur
  cible.
- **Transfert de risque LP → gestionnaire.** Le flux stochastique de frais
  devient un paiement certain reçu ex ante. Les LPs cèdent le fee stream et
  reçoivent 70 % de l'enchère streamée sur leur mandat (R6, voir [Roadmap.md](Roadmap.md)).
- **Compensation productive.** Le seul couple qui justifie une enchère sur
  ce panier (LBTC + Auction) est précisément ce que TriBitcoin ne réplique
  pas ; le 30 % brûlé fait du rent la demande nette du token.

`setFee` (le repricing du gestionnaire) vit dans `Pool.sol`, pas dans
`Auction.sol`. Les erreurs `OutsidePriorityWindow` et `FeeAlreadySetThisEpoch`
sont pool-side. L'Auction n'enchante que la nomination et le loyer ; elle
ne touche pas au fee effectif après l'élection.

---

## 2. Cycle de mandat

Une époque Pool dure `EPOCH_DURATION = 14 400 s` (4 h, snapshot côté
Auction au constructeur). L'enchère pour l'époque N+1 s'ouvre pendant
l'époque N et se referme avant son rollover. Quatre phases par mandat.

| Phase | Fenêtre | Mécanisme |
|---|---|---|
| **Enchère ouverte** | `startOfEpoch(N) → startOfEpoch(N) + AUCTION_WINDOW` (15 min, soit les 6,25 % **initiaux** — premiers 900 s — de l'époque N) | `placeBid` accepte des bids ascendants avec surenchère +10 % (`HIGH_BID_BPS = 11000`). |
| **Silence pré-settle** | les ~60 s avant rollover (valeur livrée `BID_SILENCE = 60`) | `placeBid` rejette avec `WindowClosed`, `settle` accepte. |
| **Settle** | la frontière d'époque | `settle()` capture la dernière enchère dans le slot pending, brûle 30 %, prélève 0,1 % de la part LP pour le bot, route le solde (~69,93 % du produit) au pool comme loyer LP, nomme `pendingBidder`. |
| **Mandat** | l'époque N+1 entière | Le gestionnaire peut appeler `setFee` côté Pool pendant `PRIORITY_WINDOW` (240 s, 4 min), puis trade au fee qu'il a écrit ou au défaut nominal. |

La fenêtre d'enchère (15 min) ne peut pas rétrécir avec le mandat : si elle
descendait à 5 min, le bot doit avoir vu l'ouverture et landed une tx, ce qui
compte en minutes et pas en secondes. C'est un plancher opérationnel propre à
la fenêtre, pas une fraction du mandat.

`BID_SILENCE` n'est PAS la garde temporelle : c'est un indice de cadencement
pour le bot off-chain. La garde réelle est l'expression stricte `<` dans
`placeBid` et `>=` dans `settle`, identiques des deux côtés (parade F3).
Sortir `BID_SILENCE` du contrat ne rétrécit ni n'élargit aucune fenêtre.

La fenêtre de `settle` réelle s'étend de la fermeture de l'enchère
(`startOfEpoch(N) + 900 s`) jusqu'au rollover (`startOfEpoch(N) + 14400 s`) :
`settle` est permissionless et peut être appelé à **n'importe quel moment**
dans cet intervalle, pas uniquement dans les ~60 s précédant le rollover.
Les ~60 s (`BID_SILENCE`) ne sont qu'un conseil de cadencement pour le bot.

---

## 3. Opérations

### 3.1 `placeBid(uint256 amount)`

- **Effet** : met à jour `highBid` / `highBidder` / `sellingEpoch`, crédite
  le perdant précédent dans `refunds[highBidder]` (pull-only).
- **Garde temporelle** : `block.timestamp < startOfEpoch(sellingEpoch - 1) + auctionWindow` (strict). Au-delà : revert `WindowClosed`.
- **Garde de montant** : `amount >= max(minOpeningBid, highBid * 11000 / 10000)`. Sinon revert `BidTooLow(min, provided)`. La mise plancher est de 10 MRN.
- **Transition d'époque** : si `sellingEpoch != currentEpoch() + 1`, le slot est rouvert à zéro ; si une enchère précédente était en vol, ses trois champs (`pendingEpoch`, `pendingAmount`, `pendingBidder`) sont capturés ensemble pour traitement par `settle`. Parade F2 : sans capture conjointe, `settle` nommait `highBidder` (l'enchère COURANTE) pour le mandat QUI ARRIVAIT.
- **CEI strict** : crédit du refund, `safeTransferFrom` depuis l'appelant, mise à jour de `highBid`/`highBidder`, émission de `BidPlaced`.
- **Pas de `setFee` ici.** L'idée que `placeBid` activerait une fenêtre de priorité est fausse côté Auction ; `setFee` est un concept Pool. Le manager élu hérite d'une priorité côté Pool, pas côté Auction.

### 3.2 `settle()`

- **Premier cas** : aucun pending, mais une enchère en vol. Capture dans le slot pending (`pendingEpoch = sellingEpoch`, `pendingAmount = highBid`, `pendingBidder = highBidder`), puis purge le live auction (`highBid = 0`, `highBidder = address(0)`). Exige `block.timestamp >= closesAt`, sinon revert `WindowStillOpen(closesAt)`. Parade F3.
- **Second cas** : pending existe déjà (capturé par un `placeBid` reset). `settle` ne re-vérifie pas la fenêtre : le slot doit rester drainable à tout moment, sinon F1 (brick éternel sur `Pool.EpochAlreadyStarted`) revient par la grande porte.
- **Aucun des deux** : revert `NoBidToSettle`.
- **Idempotence** : la purge du live auction à la capture rend le second appel consécutif non productif. Laisser le live en place aurait permis d'accumuler des refunds en re-capturant la même enchère (parade documentée l. 377-389).
- **Branche `_settle`** :
  - Si `pendingEpoch <= currentEpoch()` ou si le pool a déjà un manager pour cette époque : **pas de burn, pas de loyer, pas de nomination**, refund intégral au `pendingBidder` (le gagnant capturé par le précédent `placeBid` reset, dont la tenure n'existe plus), `SettlementExpired`. C'est la branche F1 + un cas F6 (bootstrap owner qui nomme `currentEpoch + 1` avant que l'Auction soit branchée). Refund plutôt que re-mise aux enchères : le bidder a payé un mandat qui n'existe plus.
  - Sinon : `burnAmount = pendingAmount * 3000 / 10000`, `lpAmount = pendingAmount - burnAmount`, `settleReward = lpAmount * 10 / 10000` au bot, `pool.notifyRent(lpAmount - settleReward)`, `pool.setManager(pendingEpoch, manager)`, émission de `Settled` avec les trois réserves snapshot, purge des trois pending + deux live + avancée de `sellingEpoch = currentEpoch() + 1`.

### 3.3 `withdrawRefund()`

- Pull-only, CEI strict : `owed = refunds[msg.sender]`, revert `NoBidToRefund` si 0, remise à 0 AVANT le `safeTransfer`.
- Émet `RefundWithdrawn`. Pas de batch : un retrait par adresse à la fois.
- **En idle mandat** : pendant qu'un mandat est en cours (sans enchère pour N+2), un perdant peut retirer son refund. Le contrat n'oblige pas au retrait avant la prochaine enchère ; le refund reste dans `refunds` indéfiniment.

### 3.4 `setFee` (côté Pool, pas Auction)

- **N'est PAS une fonction de l'Auction.** Documenter ici pour ne pas
  laisser le lecteur chercher : `setFee` vit dans `Pool.sol`, gated par
  `OutsidePriorityWindow` et `FeeAlreadySetThisEpoch`, plage
  `[MIN_FEE_NUM, MAX_FEE_NUM / UNBALANCE_FACTOR]` = `[1, 25]` bp.
- L'Auction fournit le `manager` (élu via `placeBid` + `settle`) ; le Pool
  vérifie ensuite que `setFee` est appelé par ce `manager` dans
  `PRIORITY_WINDOW` (240 s, 4 min) au début du mandat.
- Si le manager manque la fenêtre, le mandat court au nominal (`NOMINAL_FEE_NUM = 5` bp). Le bid payé upfront n'est pas restitué.

---

## 4. Garde F1/F2/F3 sur les transitions d'état

L'invariant de solvabilité tient sur **chaque** transition :

```
IERC20(mrn).balanceOf(this) == sum(refunds[*]) + pendingAmount + highBid
```

- **F1** : un `pendingEpoch` périmé faisait reverter `_settle` pour toujours ; le MRN du gagnant était piégé. Solution : branche expired de `_settle` qui purge le slot et crédite le perdant.
- **F2** : `settle` passait `highBidder` (le meneur de l'enchère COURANTE) à `_settle`, qui nommait donc le mauvais gagnant pour `pendingEpoch`. Solution : trois champs pending écrits ensemble (`pendingEpoch`, `pendingAmount`, `pendingBidder`).
- **F3** : n'importe qui pouvait poser `minOpeningBid` puis `settle` dans la même tx et rafler le mandat au plancher. Solution : garde `WindowStillOpen` dans la branche capture de `settle`, expression stricte identique à celle de `placeBid` (la phase d'enchère et la phase de settle sont disjointes).

---

## 5. Avantages et inconvénients

### Avantages

- **Tarification dynamique par mandat.** Le fee effectif n'est plus administré, il émerge six fois par jour d'un mini-marché. Le protocole capture la valeur que des acteurs sophistiqués attribuent à la position de gestionnaire, plutôt que la valeur qu'un owner governance devine.
- **Anti-spam par cautionnement.** Chaque bid est dépensé, pas immobilisé. La surenchère +10 % force un attaquant à payer le gaz + le bond, sinon son bid est perdu. Pas de wei-by-wei gas war (parade Bunni, source de la garde `HIGH_BID_BPS`).
- **Anti-squatting par fenêtre de priorité.** Le manager a 240 s (4 min) pour repricer le fee après `settle`, sans concurrence. Un squatteur qui paierait pour ne rien faire perd le bid entier ; un gestionnaire actif fixe son prix tôt et personne ne peut le repricer contre une tx déjà en mempool. Ferme la surface D2 du papier am-AMM.
- **Compensation LP par split 70/30.** 70 % du rent streamé sur les 4 h du mandat couvre les LPs ex ante (le flux stochastique devient certain). Les 30 % brûlés font du bid la demande nette du MRN.
- **Risk transfer honnête.** Le pool vend un VARIABLE (le fee stream, stochastique) pour un CERTAIN (le rent upfront). C'est le produit, et c'est ce qu'il faut nommer à l'oral.
- **Pull-only refunds.** Le perdant retire, on ne push jamais. Économise du gaz et bloque aucune adresse. Parade de Bunni v2.

### Inconvénients

- **Complexité accrue.** Le cycle de 4 h (enchère → silence → settle → mandat) remplace un fee statique. Six transitions d'état par jour au lieu d'une. Les auditeurs doivent suivre trois slots (`sellingEpoch`/`pendingEpoch`/`currentEpoch`) et l'invariant de solvabilité.
- **Course sur la fenêtre de priorité (240 s).** Environ 120 blocs Base. Un hiccup du séquenceur et le manager manque la fenêtre, court au nominal, a payé pour rien. Ce risque est pricé dans chaque bid et revient en clearing price plus bas. La fenêtre a été portée de 12 s à 4 min précisément pour acheter cette assurance d'arrivée ; le prix payé est une fenêtre de repricing plus large au début du mandat.
- **Plafond du setFee à 50 bp effectif.** Le manager peut écrire jusqu'à 25 bp en base (la surcharge `×2` atteint `MAX_FEE_NUM = 50`). Rien n'est borné aujourd'hui sous la courbe plate : un gestionnaire hostile à 25 bp pendant 4 h rend l'arbitrage de rééquilibrage non rentable sur une bande large de composition, et le pool reste cassé jusqu'à la fin du mandat. La parade `SymmetricFee`, non livrée, est en roadmap (voir [Roadmap.md](Roadmap.md)).
- **Pas de Vickrey.** Format ascendant ouvert, pas commit-reveal. Pour un bien à valeur commune (la tenure), truthful bidding n'est PAS dominant (linkage principle ≠ strategy-proofness). Le bond dépensé et la fenêtre courte ferment la surface d'option, mais un sealed-bid Vickrey reste sur la roadmap (R7, voir [Roadmap.md](Roadmap.md)).
- **Ticket minuscule.** Au comparable (680 k$ TVL, 3.94 %/day, 5 bp), un mandat de 4 h vaut 2.23 $. Personne n'écrit, audite et opère un bot pour quelques dollars par an. Le bracket de 4 h est désormais défendu sur l'otage seul, pas sur la viabilité économique. Longueur tenure = premier item roadmap si pas d'acheteur.

### Note MRN (28/08)

Cible prix MRN revue de 0,10 $/MRN à 0,01 $/MRN (commentaire `auction.ts` l. 16, cf. [Détermination des constantes.md](<Détermination des constantes.md>) §2.2). Le plancher en dollars reste à 0,10 $ ; seul le nombre de MRN par dollar change. Le choix de 10 MRN comme mise plancher demeure défendable au titre du choix d'unité tant que MRN n'a pas de prix, et sa fonction (anti-clôture-à-vide, pas anti-spam) reste intacte à la nouvelle cible.

---

## 6. Choix différés (roadmap)

Détail et raisons de différé dans [Roadmap.md](Roadmap.md).

- **Vickrey sealed-bid (R7).** Commit-reveal différé : enlève la shading du bidder mais introduit un free option entre commit et reveal. La fenêtre courte actuelle est l'argument-pas qui maintient le format ascendant.
- **Soft-close A1.** `MAX_EXTENSION = 0` côté Auction, prêt à être activé : un dernier bid en fin de fenêtre l'allongerait de `MAX_EXTENSION` (180 s cible). Aucune ligne de Pool touchée. Attend la soutenance.
- **Multi-fee, multi-leg, multi-manager.** Hors MVP. Le slot pending supporte déjà un capture-and-park, mais le multi-mandat demanderait un refactor de l'invariant de solvabilité.
- **`SymmetricFee`.** La seule parade écrite contre le manager hostile à 25 bp sous courbe plate. Le rebate directionnel (retiré au SEVENTH PASS du 25/08) couvrait la moitié du trou, pas tout. À rouvrir après soutenance.
- **Longueur de mandat.** Le bracket de 4 h est désormais explicite (otage > viabilité). Premier candidat à l'allongement si la mévente des mandats devient mesurable.
- **Hook Uniswap v4 (R8).** Remplacement des splits constants par un hook v4 dynamique. Demande un refactor de `notifyRent` et la perte de la simplicité Solidity.

---

## 7. Résumé opérationnel

| Question | Réponse |
|---|---|
| Qui pose un bid ? | N'importe qui, `placeBid(uint256)` avec approval MRN préalable. |
| Combien faut-il surenchérir ? | +10 % sur `highBid`, minimum 10 MRN au premier coup. |
| Quand l'enchère se ferme-t-elle ? | `startOfEpoch(N) + 900 s`, soit 900 s après le début de N (~3 h 45 avant la fin de N). |
| Qui nomme le manager ? | `settle()` permissionless, le caller paie `settleReward` (0.1 % du LP share). |
| Que se passe-t-il si personne ne settle ? | `settle` reste ouvert indéfiniment ; `_settle` expire le pending au rollover et rembourse. |
| Combien touche le bot settle ? | `lpAmount * 10 / 10000` = 0.1 % des 70 % LP. À 2.23 $ de mandat, ça ne paie pas le gaz. |
| Que se passe-t-il si le manager rate la fenêtre de priorité ? | Le mandat court à `NOMINAL_FEE_NUM = 5` bp. Le bid n'est PAS restitué. |
| Combien le manager peut-il écrire comme fee ? | `[1, 25]` bp en base ; surcharge `×2` porte l'effectif à 50 bp max. |
| Qui encaisse le bid ? | ~69,93 % streamés aux LPs sur 4 h (`pool.notifyRent`, soit 70 % moins la récompense settle), 30 % brûlés (`ERC20Burnable.burn`). |
| Le perdant récupère-t-il son MRN ? | Oui, via `withdrawRefund()`, pull-only, après chaque surenchère ou expiration. |