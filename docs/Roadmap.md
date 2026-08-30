# Merion — Roadmap post-Phase 2

**Statut** : documentation Merion v1, arrêtée au 2026-08-30. Roadmap consolidée depuis le carnet de projet et le bilan de fin de phase. Les items listés ici sont **hors MVP** et **hors soutenance** (2026-09-02) : aucun n'est construit avant la défense. Chaque différé porte sa raison, ce qui en fait la défense à l'oral ; sans cette raison, la roadmap se lirait comme une liste d'oubliés, ce qu'elle n'est pas.

---

## 1. Périmètre

**Phase 1 close le 2026-08-16** : DEX à produit constant livré, suite TypeScript fonctionnelle, Foundry tests verts, vitrine `Merion-demo` en ligne, déploiement Base Sepolia vérifié. **Phase 2 close le 2026-08-30** : bandes de composition, pause, panier 1/1/1 sur cbBTC/LBTC/WBTC (tBTC sorti 2026-08-23), tarification nominale 5 bp, couche fuzz et 8 invariants Foundry, chantier perf R5 et chantier RPC R6 livrés (RPC R6 commité 2026-08-30 ~01h00, commit `9a26342` RPC Etape 5).

**Ce document couvre ce qui reste après la phase 2** : mécanisme (StableSwap, fee asymptotique, bornes indexées), intégration (hook v4, agrégateurs), gouvernance (multisig → timelock → token), token (airdrop, pool Aerodrome, staking), business (B2B, audits C1/C2/C4/C6). Chaque item dit ce qu'il débloque et pourquoi il attend.

---

## 2. Mécanisme

### 2.1 StableSwap Newton (R3) — bloqué par R2

**Quoi** : invariant Newton avec `A` comme dial, tarification 1:1:coefficient (la troisième jambe est LBTC productive, ne revert pas vers 1).

**Pourquoi pas avant** : bloqué sur la source du coefficient LBTC (R2). Trois candidats (oracle, taux codé en dur, enchère elle-même) échouent chacun dans un sens distinct :
- **Oracle** : casse le positionnement « sans oracle ».
- **Taux codé en dur** : honnête mais deviné, faux dans le mauvais sens si Babylon faiblit. Lombard publie un trailing 14-jours entre 0,5 % et 1 %/an ; un arrêt complet de Babylon pendant 6 mois décalerait LBTC de 0,25 % à 0,5 %, borné par la bande de composition LBTC.
- **Enchère comme source** : le pire des trois, le pool consommerait un prix qu'il a lui-même fabriqué, et le manager d'époque pourrait trader contre son propre taux depuis une seconde adresse.

**Ce que ça débloque** : profondeur à parité (positionnement), et un effet moins visible : un `A` élevé rapproche Merion du régime de turnover des pools concentrés plutôt que des spread pools. La décimalisation (R1) est l'unique moitié non bloquée ; fermée le 2026-08-23 par le passage à WBTC (les trois jambes portent 8 décimales sur Base).

**Question ouverte** : comportement si l'itération Newton n'a pas convergé dans sa borne — revert ou repli sur la dernière estimation. Question distincte : un `A` élevé ne résiste plus à l'imbalance, donc les bandes deviennent **plus** nécessaires après R3, pas moins (Balancer livre des breakers sur ses stable pools, pas sur ses volatiles).

### 2.2 Fee asymptotique hors-parité (R3 bis) — bloque le retrait des bandes

**Quoi** : fee qui croît continûment avec la distance à la parité et diverge à la borne, remplaçant la surtaxe binaire `×2` au-delà du deadband de 2 %.

**Pourquoi pas avant** : bloqué par R3, qui est bloqué par R2. StableSwap fournit la mesure gratuitement (`D` déjà calculé, déviation lisible `x_i / (D/n)`).

**Précédent** : TriBitcoin applique un smooth `×10` jusqu'à 50 bp — smooth, pas asymptotique. Personne ne livre une fee véritablement asymptotique sur courbe stable, donc pas de précédent de production à citer.

**Ce que ça débloque** : le **retrait des bandes**. Une fee capée à `MAX_FEE_NUM = 50` bp ne dissuade pas une dislocation de 30 %, donc les bandes survivent à la surtaxe MVP et à celle de TriBitcoin. Une fee divergente EST le mur, exprimée en prix plutôt qu'en revert. La bande devient un tarif, pas une suppression.

**Quatre pièges à reconnaître à l'oral** :
1. Asymptote sous cap 50 bp — deux adversaires, deux leviers : le cap protège du manager, l'asymptote de l'imbalance.
2. Manager écrit 0, asymptote incluse — forme `max(base, asymptote(state))`. `MIN_FEE_NUM = 1` ferme la moitié du piège, le manager peut encore diviser le tarif par cinq.
3. Une fee non capée produit toujours un revert via `ZeroOutput` — le mur change de langage (approche continue), il n'est pas retiré.
4. Le mur n'est pas en un point — il dépend du ticket, les petites corrections sont refusées avant les grandes près de la borne. Acceptation honnête, pas un fix.

### 2.3 Bornes et planchers indexés sur la TVL (R4) — renforce la grille

**Quoi** : bornes exprimées en fraction de la TVL plutôt qu'en valeurs fixes.

**Pourquoi pas avant** : sorti du MVP le 2026-08-19, mentionné dans le carnet, décidé plus tard.

**Argument à porter** : entre un pool en seed et un pool mature, les mêmes pourcentages ne décrivent pas le même risque, parce que la profondeur externe disponible ne bouge pas avec eux. Figures successives : 50 M → 1-5 M → 1-3 M → 300 k-2 M → 300 k-8,3 M → 300 k-58 M, mouvement lié à la fois aux mesures et à un changement de définition de « mobilisable » (2026-08-24). La plage s'élargit sur deux ordres et demi, ce qui rend l'indexation sur TVL la seule forme qui tient sur la bande que le projet revendique.

### 2.4 Mise à jour du couple 81,7/18,3 (R5) — dépend de R4

**Quoi** : recalibrer la clé de rareté relative WBTC+cbBTC / LBTC quand le marché bouge.

**Pourquoi pas avant** : dépend de la **nature** des bornes, tranchée à R4. Les bandes livrées en `constant` v1 (`floor=13`, `ceiling=53` hard-codés au déploiement) impliquent que le setter corridor+limites est lui-même roadmap ; R5 attend donc que les bandes deviennent mutables, ce qui est précisément R4.

### 2.5 Proceeds d'enchère payés en BTC, déposants LBTC surpondérés (R6)

**Quoi** : remplacer le paiement MVP en MRN par un paiement en BTC, avec surpondération aux déposants LBTC.

**Pourquoi pas avant** : exige des dépôts déséquilibrés et des positions LP non fongibles (type Uniswap v3 ou Curve), le seul chemin qui rende identifiable un déposant LBTC. Aujourd'hui `addLiquidity` tire les trois tokens au ratio réserve et le LP token est un ERC-20 fongible transférable, donc la composition du dépôt n'est enregistrée nulle part.

**Ce que ça débloque** : la tension de compensation entre les trois jambes, résolue plutôt que reportée. C'est la **conception cible** ; le paiement MVP en MRN est une simplification pour la version livrée, et les deux ne doivent jamais être confondus dans un document lu par un jury.

---

## 3. Intégration

### 3.1 Enchère : commit-reveal Vickrey avec cautionnement (R7)

**Quoi** : remplacer l'enchère ouverte ascendante par un commit-reveal scellé second-prix avec dépôt de garantie et condition de confiscation objective.

**Pourquoi pas avant** : la condition de confiscation est « la non-révélation » (lisible directement dans l'état du contrat, sans oracle et sans appréciation humaine). Une « vérification comportementale » n'est pas codable.

**Ce que ça débloque** : résistance au sniping et au copy-bidding dans le mempool public. **Ne pas défendre Vickrey par la strategy-proofness** : l'enchère truthful est dominante au second prix sous valeurs privées indépendantes, et une tenure est un bien à valeur commune, donc les bidders se protègent de la malédiction du gagnant. Les arguments qui tiennent sont on-chain : un commit émis longtemps avant le reveal est une option gratuite, plus le capital verrouillé entre les deux phases.

### 3.2 Hook Uniswap v4 plutôt que pool autonome (R8)

**Quoi** : redéployer Merion comme hook v4, pas comme pool standalone.

**Pourquoi pas avant** : chantier d'intégration complet, hors budget de certification.

**Ce que ça débloque** : routage v4 et **tous les agrégateurs qui lisent déjà v4**, sans paperwork d'intégration. C'est ce que Bunni v2 a fait avec son propre am-AMM. **Item à plus fort levier de la liste.**

### 3.3 Agrégateurs B2B (chemin long, si R8 reste roadmap)

Cibles : 1inch, 0x, Odos, KyberSwap, OpenOcean sur Base. Prérequis partagés, dans l'ordre :
- Contrat vérifié.
- Quote on-chain (`get_dy`, prévu à l'étape 8e).
- Factory ou registre pour rendre les pools énumérables sans adresse hardcodée.
- TVL réel de plusieurs centaines de milliers.
- Audit pour les plus gros.

Puis un formulaire partenaire ou une issue GitHub, puis quelqu'un écrit l'adapter.

---

## 4. Gouvernance

Progression en trois étapes, dans cet ordre :
1. **Multisig 3-sur-5 d'équipe avec signers publics** — la demo livre un Safe 1-de-1, et l'oral le dit.
2. **Timelock 24 à 48 heures devant le Safe** — ce qui protège l'utilisateur, ce n'est pas le nombre de signers, c'est le timelock.
3. **Gouvernance token** — pouvoirs transférés au token, ce qui donne enfin à MRN son usage de gouvernance.

---

## 5. Token et lancement

- **Allocation des 100 M MRN** : ouverte, différée à l'écriture du carnet. Rien n'est écrit nulle part aujourd'hui, et plusieurs propositions de lancement ci-dessous ne sont pas quantifiables sans elle. Ne bloque aucun code, donc attend, mais le carnet ne peut pas être fini sans.
- **Émission programmée depuis la réserve pré-mintée** : vesting d'un côté, incitations cold-start de l'autre. Vocabulaire : la supply est fixée à 100 M et le token n'a **pas de fonction mint**, donc c'est un calendrier de libération, jamais un mint. Cette absence est aussi la meilleure réponse possible à C4 sur « qui peut créer du MRN ».
- **Airdrop de lancement** : vers détenteurs LBTC, LPs Curve actifs, communauté Babylon. Frame : sème la **distribution et la communauté**, pas la demande d'enchère, ces populations étant des détenteurs et non des bots d'arbitrage.
- **Pool MRN/cbBTC sur Aerodrome avec incitations** : la vraie réponse à « où un bidder obtient-il du MRN », et qui retire le faucet, sans place au-delà du testnet. Exige une liquidité seed, d'où la question d'allocation.
- **Staking avec boost LP, 1.1× à 1.5× sur le revenu LP organique** : gardé hors MVP pour deux raisons tenues ensemble — ~2 semaines de travail pour un bénéfice non critique, et un risque réel de requalification juridique du token. Sa place est R2-R3, en relais quand les émissions de mining déclinent.
- **Burn-to-bid ou lock-to-bid, et un buyback floor**.

---

## 6. Audits et certification post-soutenance

**Trois chantiers de certification post-soutenance = C6, C8, C1** : livrables hors-soutenance à consolider dans une passe dédiée. (1) **C6** couche fuzz + 8 invariants Foundry Solidity, livrée fin août. (2) **C8** vérification des contrats sur Basescan (Base Sepolia), hors CI par principe. (3) **C1** README de spécification (cahier des charges + tableau des attaques connues) — la grille d'attaques existe en substance dans les gardes déjà livrés, mais n'a pas été rassemblée en tableau lisible, identifié comme manquant **après** la clôture de la phase 1. La matière existait depuis longtemps, le livrable non. **Erreur de méthode, pas de périmètre.**

**Trois prémisses du plan tombées en mesurant** : leçon pour les items futurs — vérifier la prémisse d'un item avant de le traiter. Un plan écrit il y a deux jours n'est pas une source de vérité sur le code d'aujourd'hui.

---

## 7. Items différés (avec raison)

| Item | Raison du différé |
|---|---|
| Vickrey commit-reveal + cautionnement (R7) | Condition de confiscation à concevoir hors MVP. |
| Hook Uniswap v4 (R8) | Chantier d'intégration complet, hors budget certification. |
| Exclusion premier bloc (`priorityBlock`) | Sorti au SEVENTH PASS 2026-08-25, oral answer seul conservé. |
| Rabais directionnel (rebate tiers 3) | Sorti au SEVENTH PASS 2026-08-25, motif = drift de composition ordinaire, jamais le depeg. |
| Surveillance post-soutenance | Hors phase 2, à programmer après 2026-09-02. |
| Redesign multi-chain | Suivi (exit 2 du modèle économique), pas rival de la thèse single-chain. |
| Réallocations 100 M MRN | Écrit nul part, attente carnet-writing time. |

---

## 8. Décisions verrouillées (ne pas re-légitiger)

- **Panier** : WBTC + cbBTC (non-productifs, ~1:1) + LBTC (productif, dérive), cibles **égales 1/1/1**. tBTC sorti 2026-08-23 (défaut de décimales silencieux, plus TVL plafond). `Pool.sol` indices 0=WBTC, 1=cbBTC, 2=LBTC.
- **Décimales** : 8 sur les trois jambes sur Base. Garde constructeur `IERC20Metadata(token).decimals() == 8` (Pool.sol:373-375).
- **Tarif nominal** : 5 bp (`NOMINAL_FEE_NUM = 5` sur `FEE_DEN = 10000`). Argument inversé 2026-08-23 sur données internes : la venue 5 bp (TriBitcoin) tourne 3,94 %/jour, la 2 bp (Aerodrome CL1) 0,74 %/jour, 5× plus vite à plus du double du prix. Le prix n'est pas ce qui capte le flux dans ce segment.
- **Cap fee** : `MAX_FEE_NUM = 50` (50 bp), floor `MIN_FEE_NUM = 1` (1 bp, raised off 0 le 2026-08-23). Manager cap = 25 bp dérivé (`MAX_FEE_NUM / UNBALANCE_FACTOR`).
- **Mandat** : 4 h (`EPOCH_DURATION = 14400`), fenêtre d'enchère 15 min (`AUCTION_WINDOW = 900`).
- **Fenêtre de priorité** : 240 s / 4 min (`PRIORITY_WINDOW = 240`), fenêtre de repricing du manager élu — 60× plus court que l'époque. Portée de 12 s à 4 min pour donner au manager le temps de poser sa surcharge malgré la variance du séquenceur.
- **Bandes** : `constant floor=13, ceiling=53` (Pool.sol:53, 56). Corridor + setter roadmap (R4). Bornées par construction : max sum floors = 39 (<100), min sum ceilings = 159 (>100), set d'états permis non-vide.
- **Bid token** : MRN, supply 100 M, **pas de fonction mint**, calendrier de libération depuis réserve pré-mintée. Mise minimale 10 MRN (`MIN_OPENING_BID = 10 × 10^18`, MRN cible 0,01 $).
- **TVL band** : 300 k$ à 58 M$ (cinq paliers, seul 300 k$ jamais asserted ; 1 M$ conditionné sur 7 détenteurs LBTC nommés, 8,3 M$ le LBTC libre d'engagement, 35,6 M$ ajout vault-pont Derive, 58 M$ le plafond arithmétique). **Nommer le palier qualifié avant de citer un chiffre.**
- **Positionnement** : « LBTC plus l'enchère, jamais l'enchère seule ». Ordre d'exposition : actifs d'abord, mécanisme ensuite. Mécanisme = **am-AMM** (Adams & Moallemi 2024, arXiv 2403.03367), déjà livré dans **Bunni v2**. Dire « récent, peu répandu », jamais « novateur ».
- **Lecture sans oracle** : le pool price par ses réserves et ne consomme jamais le prix révélé ; l'enchère recapture le LVR. **Ne jamais dire « l'enchère EST l'oracle ».**
- **Garde owner's power** : il pause swaps et dépôts, et c'est tout — il ne peut pas bouger le fee, toucher les réserves, bouger une bande, rediriger la part protocole (trésorerie immuable).
- **Pause** : `whenNotPaused` sur `swap` et `addLiquidity`, **rien sur `removeLiquidity`**. Les retraits proportionnels changent la TAILLE du pool, jamais sa COMPOSITION — les LPs restants ne sont pas lésés par ceux qui sortent. C'est ce qui rend « retraits toujours ouverts, même en pause » tenable.
- **Audit C6** : >80 % de couverture mesurée, déjà cleared à 98,44 % sur le périmètre contrats.

---

## 9. Indicateurs de succès et critères de priorité

**Indicateurs de succès post-soutenance** :
- **Cold start** : résoudre les quatre leviers (émission pondérée par jambe, allocation de lancement bornée, allocation négociée aux 7 détenteurs nommés, n'émettre rien) ; le carnet a choisi le dernier pour v1. Une époque sans manager ne banque rien pour la suivante — le fee nominal laisse passer tout arbitrageur, donc la drift fuit vers l'extérieur gratuitement. Une série d'époques sans bidder est le régime le plus coûteux du protocole.
- **Distribution** : hook v4 actif, OU intégration 1inch/0x/Odos/KyberSwap/OpenOcean effective (chemin long, conditionné à R8).
- **Tokenomics** : MRN a un **acheteur structurel qui perd de l'argent à ne pas le détenir** — définition interne de la valeur d'un token utility.
- **Gouvernance** : multisig 3/5 nommé, timelock 48 h en place, sans étape gouvernance token tant que MRN n'a pas de distribution suffisante.
- **Viabilité économique** : atteindre le premier barreau de l'échelle à 5 couches (autosuffisance à ~20 M$ TVL). La v1 est sous le premier barreau, **assumé** (exit 3 du 2026-08-24).

**Critères de priorité** (ordre d'exécution post-soutenance) :
1. **R2** : trancher la source du coefficient LBTC. Sans R2, R3 ne shippe pas, et R3 bis non plus.
2. **R3 + R3 bis** : StableSwap + fee asymptotique. Retire les bandes, débloque la profondeur à parité.
3. **R6** : payment BTC + LP non fongibles. Résout la compensation LBTC, ferme le tokenomics.
4. **R8** : hook Uniswap v4. Plus haut levier de distribution.
5. **R7** : Vickrey + cautionnement. Après R2-R3, quand le mécanisme est stable.
6. **R4 + R5** : bornes indexées TVL + clé de rareté dynamique. Renforcent la grille, dépendent des paliers mesurés.
7. **Gouvernance 3 étapes** : parallélisable avec tout le reste.
8. **Token launch** : airdrop, pool Aerodrome, staking. Dépend de l'allocation 100 M.

**Critères de revue** pour tout item futur :
- Un fait économique mérite un test, pas seulement une affirmation (3 rencontres : TOL_DEN, MIN_FEE_BPS, décimales).
- Pour toute constante économique, regarder ce que font les 3 plus gros protocoles avant de choisir.
- Un changement de panier doit rouvrir chaque script de vérification, pas seulement relancer les anciens.
- Vérifier la prémisse d'un item avant de le traiter ; trois prémisses sont tombées en mesurant.