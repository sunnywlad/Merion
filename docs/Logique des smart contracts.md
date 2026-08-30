# Logique contractuelle — Merion v1

Architecture générale et raisons des choix de conception, dérivées des
commentaires des cinq contrats et du carnet de projet.
**Distinct** de [Principes de l'enchère.md](<Principes de l'enchère.md>) (mécanisme
d'enchère seul) et de [Détermination des constantes.md](<Détermination des constantes.md>)
(chiffres et barèmes). Ici : le POURQUOI des choix, pas le COMMENT des chiffres.

---

## 1. Architecture générale

Cinq contrats Solidity, déployés sur Base Sepolia, couplés par deux mécanismes :
l'Auction appelle le Pool via `setManager`/`notifyRent` (wired), le MRN est
tiré en PULL sur l'approbation posée au constructeur.

**`Pool.sol`** — AMM à produit constant sur trois actifs, base de frais
modulable par epoch, plafond sur les réserves, loyer LP streamé en MRN. Cœur du
protocole.

**`Auction.sol`** — enchère ascendante ouverte en MRN sur la nomination du
gestionnaire du mandat suivant. Seul point d'entrée de `setManager` et de
`notifyRent` une fois déployé.

**`MRN.sol`** — ERC-20 natif, 100 M minted au constructeur, `ERC20Burnable`
depuis I.3 (sans `burn`, pas de destruction de la part 30 % de l'enchère).
Pas de mint post-construction : c'est la meilleure défense C4 à « qui peut
créer du MRN ».

**`MockWrappedBTC.sol` × 3** — WBTC, cbBTC, LBTC, 8 décimales chacun, capped
à 21 M (un plafond par mock, pas partagé, chaque wrapper étant une prétention
sur le même Bitcoin). Le plafond ferme la brèche de donation/inflation LP.

**`MrnFaucet.sol`** — réservoir pré-financé de 10 M MRN, `drip()` à cadence
limitée par adresse. Démo et consultants, pas production.

**Raison d'être :** Merion est un DEX BTC multi-wrappers sur Base. Le
différenciateur est un seul couple — LBTC plus l'enchère, jamais l'enchère
seule — parce qu'une enchère sur trois wrappers non-productifs n'a rien à
vendre (aucun drift, aucun droit d'arbitrage). L'enchère recouvre le LVR
qu'une courbe plate laisserait fuir, et c'est la combinaison qui crée un
objet économique.

---

## 2. Architecture par contrat

### 2.1 Pool

**Rôle :** AMM à produit constant, n=3, baskets homogènes. LP mintent des parts
ERC-20 en déposant les trois actifs à proportion ; swappent contre frais ;
brûlent des parts pour retirer à proportion. Le loyer LP arrive en MRN depuis
l'Auction.

**Choix structurants :**

- **Produit constant, pas StableSwap.** Le critère C1 à C8 tient sans
  StableSwap ; l'enchère passe avant (~5 j contre ~12 j). La cible du
  roadmap est `1:1:coefficient`, jamais `1:1:1` — une courbe plate
  mésestime un asset productif de façon permanente.

- **Cibles ÉGALES 1/1/1 depuis le 22/08.** Une asymétrie type 45/45/10 a
  été défaite en une transaction à 12,5 % du TVL. Le seed n'est pas un
  paramètre, c'est un point d'équilibre que le marché impose.

- **8 décimales hard-codées, asserted au déploiement.** Les trois wrappers
  portent 8 sur Base, les mocks aussi, le contrat exige l'égalité
  (`InvalidTokenDecimals`). Le défaut latent a été fermé gratuitement par
  le changement de panier du 23/08 (tBTC exclu, ses 18 décimales
  contredisaient le hard-code).

- **Bande unique `floor = 13`, `ceiling = 53`.** Pas six bornes par jambe
  (ruled out au SEVENTH PASS du 25/08). Le critère de non-vacuité est
  vérifié par construction : `3 × 13 = 39 < 100 < 159 = 3 × 53`. Les
  bornes sont `constant`, pas modifiables — corridor + setter est roadmap.

- **Frais : nominal 5 bp, cap 50 bp, surcharge directionnelle ×2 hors
  bande.** Le 5 bp n'est PAS un fallback, c'est le prix réel du protocole
  la plupart du temps (mandats sans acheteur). Séquence inversée le
  23/08 : 4 bp → 2 bp → 5 bp, après constat que la pool 5 bp tourne 5×
  plus vite que la 2 bp à 2,5× le prix.

- **`setFee` non pausable.** La pause sert à préparer la reprise ;
  bloquer le tarif forcerait `unpause → setFee → reprise` et laisserait
  une fenêtre au taux de crise. Le manager du mandat courant écrit
  `feeNum` dans la fenêtre de priorité de 240 secondes (4 min), une seule fois.

- **Pull-only partout.** `claimManagerFees`, `claimProtocolFees`,
  `claimRent` — le protocole ne pousse jamais. La trésorerie est
  immuable, l'argent ne suit jamais la propriété.

- **Packings critiques.** Réserves en un slot 32 octets (3 × 72 bits) :
  -14 200 gas sur le chemin swap. `feeNum + lastSetFeeEpoch` en un slot
  : 1 SSTORE au passage d'epoch au lieu de 2. Lecture de frais via
  reset paresseux, pas d'écriture d'epoch.

**Alternatives écartées :**

- StableSwap NG (triée par défaut, reportée phase 2) — bloque le
  séquencement, ne débloque aucun critère.
- Tarification dynamique deux-tiers (surcharge + rebate, ruling 24/08) :
  SEVENTH PASS du 25/08 a retiré le rebate ; reste la surcharge qui
  protège les LP. Rebate → roadmap R3 bis.
- Pause sur `removeLiquidity` : écartée pour préserver la sortie pendant
  un bank-run (proportionnel par construction, ratio-neutre).
- Bands modifiables par l'owner : écartée car « mutabilité qui n'existe
  pas dans le contrat ne peut pas être questionnée ».

### 2.2 Auction

**Rôle :** Enchère ascendante ouverte en MRN pour la nomination du
gestionnaire du mandat suivant. Période de 4 h, fenêtre d'enchère de 15
min (≤ 7 % du mandat). Le gagnant devient manager — il pose le tarif de
swap pour son epoch et perçoit la part manager (90 % de la base).

**Choix structurants :**

- **`placeBid` met à jour le tracking, `setManager` est appelé dans
  `_settle()`.** L'office est pris par le passage du temps ; la
  nomination est fixée par le DERNIER enchérisseur. Le design antérieur
  nommait le premier — un hostile posait la mise minimale et bloquait
  l'enchère. Le commentaire d'en-tête (point 3) tient la justification
  complète.

- **Refunds crédités, jamais poussés (R2).** Un enchérisseur contrat
  qui revert à la réception gèlerait toute mise supérieure : c'est
  l'attaque la moins chère sur le mécanisme. Pull-only via
  `withdrawRefund`, CEI strict.

- **Réinitialisation par comparaison à `currentEpoch() + 1`.** Capture
  le gagnant précédent dans `pendingEpoch` / `pendingAmount` /
  `pendingBidder` AVANT de remettre à zéro. Les refunds, eux, persistent
  (un ancien enchérisseur peut toujours tirer).

- **Pull MRN vers le Pool (M2).** L'Auction pré-approuve le Pool au
  constructeur ; le Pool tire dans `notifyRent`. Sans approbation,
  `safeTransferFrom` reverte et toute la transaction est annulée. C'est
  l'échec bruyant préférable à une sur-déclaration silencieuse.

- **`HIGH_BID_BPS = 11000`** (pas `1100` comme dans le brief I.3, qui
  était un typo). `11000 / 10000 = 1,10 = 110 %`, soit +10 % de hausse.
  Test 19 épingle cette valeur exactement.

- **SPLIT : 69,93 / 30 / 0,07.** `SettleRewardBps = 10` débite 0,1 %
  de la part LP au caller de `settle()`. Pas de part trésorerie sur le
  produit de l'enchère (R6 explicite) — `BURN_BPS = 3000` sur `SPLIT_DEN
  = 10000`.

**Alternatives écartées :**

- Soft close A1 : `maxExtension = 0` à I.3, champ réservé non utilisé (aucune
  logique de soft-close implémentée dans `placeBid`). A1 = substitution, pas réécriture.
- Gate A4 (silence sur `bidSilence`) : `bidSilence` reste un signal
  d'ordonnancement pour le bot, pas une garde on-chain. La fenêtre
  d'enchère n'est pas fermée à `closesAt() - bidSilence` à I.3.
- Commit-reveal Vickrey : cible roadmap. MVP = ascending ouvert pour
  tenir le délai.

### 2.3 MRN

**Rôle :** Token natif obligatoire (spec projet final). Currency de bid,
d'enchère, et de paiement du loyer LP. Burn-only post-construction.

**Choix structurants :**

- **100 M minted au constructeur.** Pas de mint post-déploiement :
  c'est la réponse C4 la plus simple à « qui peut créer du MRN ».
  L'émission est un release schedule depuis la réserve pré-mintée, pas
  une inflation.
- **`ERC20Burnable` depuis I.3.** Sans `burn`, pas de destruction de
  la part 30 % — un transfert vers 0x...dEaD ne réduit pas le
  `totalSupply`. Migration acceptée : nouvelles adresses
  déterministes, le module Ignition `mrn.ts` reste fonctionnel.
- **18 décimales (standard ERC-20).** Cohérent avec les paramètres
  d'enchère (`MIN_OPENING_BID = 10e18`, etc.).

### 2.4 MockWrappedBTC (× 3)

**Rôle :** WBTC, cbBTC, LBTC en environnement de test. 8 décimales,
`ERC20Capped` à 21 M par mock. `mint`, `transfer`,
`transferFrom` classiques (pas de `burn`).

**Choix structurants :**

- **Cap à 21 M par mock, pas partagé.** Une registry entre trois
  contrats indépendants serait un couplage supplémentaire pour aucun
  gain. Chaque wrapper est une prétention sur le même Bitcoin, et un
  plafond partagé demanderait une coordination off-chain.
- **Le cap ferme la donation attack.** Sans plafond, un mock mint
  librement contredit ce que tout jury sait du Bitcoin ; avec le cap,
  l'invariant « trois mocks à 21 M = 2,1e15 ≪ uint72.max = 4,7e21 »
  transforme les gardes `ReserveOverflow` d'un chemin live en invariant
  prouvé.

### 2.5 MrnFaucet

**Rôle :** Réservoir pré-financé pour la démo de soutenance et les
consultants. Pas de mint, pas d'inflation.

**Choix structurants :**

- **Pré-alloué au déploiement, pas `mint()`.** L'owner transfère 10 M
  MRN depuis son solde via un script de seed. La supply reste celle
  créditée au déployeur de MRN. Motif : les faucets BTC du début de la
  blockchain — un réservoir pré-financé, pas une création de monnaie.
- **Pas de `dripTo()`.** Pas de liste blanche de jurés. Le rate-limit
  par adresse empêche un acteur unique de vider le faucet.
- **Calibré pour la démo.** Pas pour production.

---

## 3. Choix cross-cutting

### 3.1 Décimales

8 décimales hard-codées, asserts au déploiement. Le défaut latent (tBTC
à 18) a été fermé gratuitement par l'exclusion de tBTC. Les mocks
matchent, la suite ne peut pas attraper une divergence silencieuse.

### 3.2 Frais

- **Nominal 5 bp** : 3,94 % turnover/jour sur le comparable TriBitcoin
  (StableSwap, 5 bp, 680 k$) — référence mesurée deux fois
  (19/08, 23/08).
- **Cap 50 bp** : taker max. Manager base = `MAX_FEE_NUM /
  UNBALANCE_FACTOR = 25`.
- **Floor 1 bp** : posé le 23/08, pas 0. Argument : un manager à 0
  retire son propre rempart (il tarifie 0 sur son propre arbitrage). La
  borne est sur la plage descendante du manager, pas un anti-routage
  gratuit.
- **Surcharge ×2** hors bande en direction aggravante. Va dans les
  reserves, jamais au manager (sinon il profite du déséquilibre qu'il
  tarifie).
- **10 % protocole** sur les deux régimes (manager nommé OU pas). Ferme
  le trou qu'ouvrirait un split 100 % manager (la trésorerie ne serait
  financée que les epochs où le mécanisme échoue). Grid : Aave v3
  10-35 %, Curve 50 %, Balancer v2 50 %, Uniswap 16,7 %.

### 3.3 Bandes (réserves)

- **Single pair `floor = 13`, `ceiling = 53`.** Ratio strict : `r * 100
  < ceiling * sum` et `r * 100 > floor * sum`. Boucle déroulée sur 3
  indices × 2 sens (6 `require`), pattern fixe sans risque de drift.
- **Pas modifiables.** Bands ship as `constant`. Corridor + setter
  ruled roadmap au SEVENTH PASS du 25/08.
- **Justification par construction :** `3 × 13 = 39 < 100` (ensemble
  non-vide), `3 × 53 = 159 > 100` (cible atteignable). Pas de check
  runtime.

### 3.4 Mandat

- **4 h tenure** : compromis entre « combien de temps un hostile tient
  le tarif » (plafond) et « fenêtre d'enchère ≤ 7 % du mandat » (plancher
  opérationnel à 15 min). Ni 2 h ni 8 h ne tient les deux côtés.
- **Fenêtre d'enchère 15 min.** L'argument est bilateral : depuis le
  haut, borne la tenure ; depuis le bas, a son propre floor opérationnel
  et ne rétrécit pas avec la tenure.
- **Fenêtre de priorité 240 s (4 min)** pour `setFee`. Exclusive à `setFee` —
  pas d'exclusivité de swap.

### 3.5 Auction proceeds

- **30 % brûlés, 70 % LP** (`BURN_BPS = 3000`), soit 69,93 % nets une fois
  la récompense settle prélevée. Pas de part trésorerie sur le produit
  (R6 explicite).
- **Settle reward 0,1 %** (`SETTLE_REWARD_BPS = 10`) au caller de
  `settle()`, prélevés sur la part LP (0,07 % du produit total). Ferme
  l'incitation faible sans laquelle le mandat pourrait rester en suspens.

### 3.6 Loyer LP

- **La part LP (69,93 % du produit, 70 % moins la récompense settle)**
  arrive au Pool via `notifyRent`. Le Pool streame linéairement sur
  `EPOCH_DURATION` à partir de chaque notify, via `accPerShare` (échelle
  1e18, dette par adresse, mise à jour paresseuse).
- **Cas `supply == MINIMUM_LIQUIDITY`** (premier mandat, parts mortes
  seules) : la rent s'empile dans `rentLeftOver`, distribuée au
  premier LP vivant. Jamais recouvrable par un admin. Valeur différée,
  pas perdue.

### 3.7 AMM protects LPs

Règle centrale : les LPs ne sont JAMAIS ponctionnés pour payer un
mécanisme de l'am-AMM. La surcharge directionnelle va aux reserves, le
manager ne touche pas la surcharge, le rebate (ruling 24/08) a été
retiré au SEVENTH PASS. Les bands sont des circuit breakers (fee = taxe,
pas limite), délibérément — un fee capé à 50 bp ne peut pas dissuader
une dislocation de 30 %, donc les bandes restent ce qu'elles sont.

---

## 4. Invariants et sécurité

**Huit invariants Foundry : sept sur le Pool, un sur l'Auction, dont deux
gardes de vacuité. Prouvés par handler + tests cibles + tests de mutation.**

### 4.1 Les huit invariants

Numérotation et noms alignés sur [Tests.md](Tests.md).

1. **`reservesNeverExceedBalances`** : le solde ERC-20 du pool couvre toujours la réserve déclarée.
2. **`reservesTrackBalancesExactly`** : forme forte, `reserves[i] + protocolFeesOwed[i] + Σ feesOwed[m][i] == balanceOf(pool, i)`.
3. **`shareValueNeverDecreases`** : la valeur unitaire d'une part LP ne baisse jamais.
4. **`addLiquidityDeliversAllThreeLegs`** : chaque réserve grossit d'au moins une unité à chaque dépôt (`Math.ceilDiv`).
5. **`bandsAlwaysRespected`** : pour toute jambe, `floor × sum < reserve_i × 100 < ceiling × sum`, soit un ratio strictement entre 13 % et 53 %.
6. **`campaignDidSomething`** : garde de vacuité par appel (100 appels → pool amorcé).
7. **`managerPathWasExercised`** : garde de vacuité par chemin (au moins un swap sous manager).
8. **`mrnCoversObligations`** (Auction) : `mrn.balanceOf(auction) == Σ refunds + pendingAmount + highBid + deadMrn` à tout instant. Handler sur `placeBid` / `settle` / `withdrawRefund` / `warp`, six tests cibles, doublé par test de mutation (garde retirée → l'invariant tombe, et lui seul).

### 4.2 Garanties complémentaires (hors campagne invariant)

Prouvées par gardes constructeur, tests ciblés et fuzz, pas par le handler :

- **Conservation des frais** : `Σ feesOwed + Σ protocolFeesOwed` tient l'égalité face au `Σ amountIn` prélevé par swap ; chaque tirage remet à zéro AVANT le transfert (CEI strict). Vérifiée dans `Pool.feeSplit.t.sol`.
- **Décimales des tokens** : `decimals(token) == 8`, garde en FIN de constructeur (3 × `require InvalidTokenDecimals`), après les gardes d'adresse nulle (`InvalidTokenAddress`), de doublon (`DuplicateToken`) et de MRN (`InvalidMrn`).
- **`feeNum` borné** : `MIN_FEE_NUM <= feeNum <= MAX_FEE_NUM / UNBALANCE_FACTOR`, garde `FeeOutOfBand` à `setFee`, gardes constructeur `FeeTooHigh` / `EmptyFeeBand`.
- **Pas d'overflow réserve** : `reserves[i] <= uint72.max` à toute écriture ; le cap des mocks (2,1e15 ≪ uint72.max 4,7e21) rend la garde runtime inatteignable dans le panier actuel.
- **Pull-only** : aucun `transfer` sortant non sollicité, CEI strict sur tous les tirages ; la vue `claimable` rend au wei près ce que `claimRent` transfère.

### 4.3 Surface de défense C4

- **Donation / inflation LP** : cap 21 M par mock + boucle de bandes.
- **Reentrance sur swap/withdraw** : `ReentrancyGuard` OZ, le chemin
  add-liquidity est verrouillé par l'AUDIT F4 (test séparé
  `Pool.reentrancy.test.ts`).
- **Manipulation d'enchère** : push vers un contrat qui revert fermé
  par R2 (refunds crédités, jamais poussés — un destinataire hostile
  gèlerait sinon toute mise supérieure) ; flash-loan single-block bloqué
  par la mécanique même (le bid est en MRN, pas en BTC, le prêt flash n'a
  rien à préter).
- **Déformation du loyer** : notification en PULL (l'Auction pré-approuve,
  le Pool tire), CEI strict.
- **Cascade de dépeg réelle** : les bands et le breaker protègent ;
  l'enchère ne répare pas, l'AMM non plus (le pool drainerait vers le
  wrapper mort sans oracle pour le stopper).
- **Centralisation** : l'owner ne fait que `pause`/`unpause`. Il ne
  peut pas bouger le fee, toucher les reserves, bouger une bande,
  rediriger la part protocole (trésorerie immuable). L'enchère est
  wired one-shot (`setAuction` accepte une adresse non-nulle et refuse
  toute seconde) ; un mauvais cablage dégrade en nominal fee, jamais
  en catastrophe.

---

## 5. Choix différés (roadmap)

- **Newton D/y solver (StableSwap).** Une courbe plate mésestime LBTC
  de façon permanente ; Newton ramène `amountOut` à `reserveOut` par
  un arrondi différent — d'où les gardes `InsufficientReserve` qui
  sont inatteignables en constant product mais vivantes en StableSwap.
  Source du coefficient : un oracle tue le positionnement, un taux
  hardcodé est guessé et faux dans la direction dangereuse si Babylon
  fléchit, l'enchère elle-même est la pire source (le pool consommant
  un prix qu'il fabrique). **Le bid ne peut JAMAIS être le taux** :
  bids en MRN, mesure de fee revenue attendue, pas du ratio LBTC/BTC.

- **Hook Uniswap v4.** La distribution réelle est un hook, pas un
  pool standalone — c'est ce qu'a fait Bunni v2. Honest oral line.

- **Commit-reveal Vickrey.** Cible roadmap pour remplacer l'ascending
  ouvert. Bond-slash condition encore à designer (objective, lisible
  depuis le pool state, « vérification comportementale » non codable).

- **Settlement BTC au lieu de MRN.** Cible design : LPs payés en BTC,
  LBTC depositors surpondérés. MVP payout en MRN retarde la question
  du rôle du token (qui paie la yield ?) plutôt qu'il n'y répond.
  Principe de résolution : la demande doit venir d'acheteurs forcés
  et motivés par le profit (côté enchère), d'où burn-to-bid ou
  lock-to-bid plus buyback floor financé en BTC.

- **Corridor + setter des bandes.** Le levier qui maintient « les
  cibles suivent le marché » vrai passé le déploiement. Bands restent
  `constant` tant que le corridor n'est pas livré.

- **Dynamic fee rebate (R3 bis).** Retirée du MVP au SEVENTH PASS du
  25/08. Motif : « rebate's motive is ordinary composition drift,
  never the depeg ». La moitié qui protégeait les LP (surcharge ×2
  hors bande) reste ; la moitié qui récompensait une contrepartie
  (rebate) sort.

- **Soft close (A1) + gate silence (A4).** `maxExtension = 0` à I.3 (champ
  réservé non utilisé), `bidSilence = 60 s` à I.3 mais sans garde on-chain
  (c'est un signal d'ordonnancement bot).

- **Exclusivité de swap du manager.** Retirée le 25/08 (priorityBlock
  supprimé). Reste la réponse orale pour « pourquoi pas seulement un
  dynamic fee ». Roadmap.

- **Cold start.** Quatre leviers sous le cap 21 M, tous roadmap :
  émission pondérée par jambe, allocation de lancement bornée (numéro
  + date de fin, sinon le piège du bribe), allocation négociée aux
  sept LBTC holders nommés, rien (choix v1). L'argument-bridge est
  rétrogradé : la vraie question est « peut-on surenchérir sur ce que
  le LBTC déjà sur Base est en train de faire », pas « peut-on faire
  bridger qui que ce soit ».

- **Peg manipulation (C4).** Défenses = mouvement partiel vers le
  clearing price, size caps per-round, deviation cap cumulative,
  breaker sur deviation cumulée. Test : manipuler doit toujours coûter
  plus que ce que ça débloque.

- **Depeg-DOWN (Babylon fails).** Bandes + breaker, jamais l'enchère.

---

*Fin. Sources : commentaires des cinq contrats, carnet de projet Merion. Voir aussi [Principes de l'enchère.md](<Principes de l'enchère.md>), [Détermination des constantes.md](<Détermination des constantes.md>), [Tests.md](Tests.md).*