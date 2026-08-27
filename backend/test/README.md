# Tests

## Pourquoi du TypeScript/viem plutot que du Solidity, ici

Le projet a deux couches de tests, et elles ne repondent pas a la meme question.

Les tests Solidity (`contracts/*.t.sol`, `forge-std`) tournent dans l'EVM et
verifient qu'une fonction, isolee, respecte sa specification pour n'importe
quelle entree : c'est le terrain naturel du fuzzing et des invariants.

Les tests de ce dossier verifient autre chose : que le contrat se comporte
correctement quand on l'appelle **exactement comme le fait le front**, a
travers l'ABI generee, avec de vrais comptes et de vrais transferts. Sur
`addLiquidity`, c'est concretement de l'orchestration multi-contrats : trois
ERC-20 differents (WBTC, cbBTC, LBTC) doivent chacun recevoir un `approve` du
deposant avant l'appel, et le contrat effectue trois `transferFrom` dans la
meme transaction. Un test Solidity peut appeler `addLiquidity` directement
depuis le contrat de test (qui est lui-meme le `msg.sender` et le token
holder) ; un test TypeScript reproduit le parcours reel d'un utilisateur : un
compte qui possede les tokens, qui les approuve, puis qui envoie la
transaction. C'est cette difference qui fait de TypeScript/viem le bon outil
ici, pas un choix de gout.

Sur `removeLiquidity`, le parcours est plus court : aucun `approve` n'est
requis, puisque le pool transfere VERS l'utilisateur (pas de `transferFrom`
entrant a autoriser) et que le porteur de parts LP brule ses propres parts
(le token LP, c'est `Pool` lui-meme, et `_burn` ne verifie qu'un solde, pas
une allowance). Ca reste de l'orchestration multi-contrats a travers l'ABI :
trois ERC-20 sortants dans la meme transaction, plus le token LP, avec de
vrais comptes.

Sur `swap`, le parcours est le plus court des trois : un seul `approve`, sur le
seul token d'entree, puisque `swap` ne fait qu'un `transferFrom` entrant. Ca
reste de l'orchestration a travers l'ABI, avec deux ERC-20 differents qui
bougent dans le meme appel et de vrais comptes de part et d'autre. C'est aussi
la fonction ou la distinction compte le plus : le front sait deja refuser un
montant nul ou un pool vide, mais un protocole DeFi qui composerait avec le
pool ne le sait pas, et c'est le contrat que ces tests interrogent.

Sur `pause` et `unpause`, le parcours change de nature : il n'y a ni token a
approuver ni montant a transferer, seulement un appelant et un droit. Ce que la
suite verifie est donc un controle d'acces exerce a travers l'ABI, avec deux
comptes distincts (l'owner du deploiement et un tiers), puis l'effet de l'etat
mis en pause sur les trois fonctions d'entree, appelees comme le front les
appelle. C'est aussi la seule promesse du contrat qui se formule comme une
phrase et non comme une formule, "en pause on n'entre plus et on sort
toujours", ce qui justifie un fichier a elle plutot que des sections ajoutees
aux trois autres : eclatee en trois, cette promesse devient invisible.

Sur le constructeur, ce qui est interroge n'est plus une fonction mais le
DEPLOIEMENT lui-meme : la transaction que l'equipe enverra en production, avec
ses sept arguments passes a travers l'ABI generee, puis relus un a un par les
memes getters publics que le front appelle. Un test Solidity ne peut pas
vraiment poser cette question : `PoolTestBase.sol` fige ses arguments une fois
pour toutes, et les deux chemins de revert du constructeur sont derriere lui
des qu'il a compile. C'est aussi la seule surface de la suite ou une erreur ne
coute pas une transaction ratee mais un contrat immuable deploye de travers.

Sur `currentEpoch`, ce qui est interroge n'est ni une valeur figee ni un
mouvement de fonds mais une HORLOGE, lue par un tiers. Le front, et plus tard
le bot d'enchere, appelleront `currentEpoch()` par `eth_call` a travers l'ABI
generee, sans envoyer de transaction, seulement pour savoir quel mandat court.
Ce que la suite TypeScript verifie est donc que cette lecture-la rend le bon
numero a chaque instant du temps simule, `networkHelpers.time` posant chaque
frontiere a la seconde. Un test Solidity poserait la meme question par
`vm.warp` depuis l'interieur de l'EVM, ce qui verifie la formule mais pas le
parcours de lecture.

Sur `feeInForce`, la reponse s'inverse, et c'est le point le plus interessant
du dossier. La question du LECTEUR EXTERNE se pose comme pour `currentEpoch` —
le front et le bot d'enchere liront le frais en vigueur par `eth_call` — mais
la couche TypeScript ne peut pas, a elle seule, prouver que la fonction fait
quoi que ce soit. En l'etat du contrat, `feeInForce()` est INDISTINGUABLE d'un
`return NOMINAL_FEE_NUM` a travers l'ABI, DANS CE FICHIER, qui n'appelle jamais
`setFee` : `lastSetFeeEpoch` (`Pool.sol:33`) vaut `0` au deploiement et seul
`setFee` l'ecrit, et pendant l'epoch `0`, la seule ou la comparaison du ternaire
puisse alors etre vraie, `feeNum` vaut exactement `NOMINAL_FEE_NUM`, pose par le
constructeur. La branche "mandat courant" du ternaire n'y est donc jamais prise
avec une valeur qui la distingue de l'autre branche. Depuis que `setFee` est
passe au gestionnaire du mandat courant, une route ABI legitime existe
(`setManager`, puis `setFee` dans la fenetre de priorite) ; elle appartient a la
suite de `setFee`, pas a celle-ci.

`test/Pool.feeInForce.test.ts` couvre donc ce qu'il peut couvrir honnetement —
la fonction est exposee et lisible sans transaction, elle suit le nominal du
POOL INTERROGE (deux pools a nominaux differents), le passage d'epoch ne
demande aucun appel, la lecture ne deplace rien, meme en pause — et l'annonce
noir sur blanc dans son entete : la preuve n'est pas la. Elle est dans
`test/Pool.feeInForce.t.sol`, qui forge le slot partage par `vm.store` pour
exhiber le seul etat ou les deux branches rendent des valeurs differentes. La
regle habituelle de ce dossier ("TypeScript pour le parcours, Solidity pour la
formule") tient toujours ; ce qui est nouveau ici, c'est qu'un fichier
TypeScript vert ne vaut rien sans son jumeau Solidity, et qu'il vaut mieux
l'ecrire dans le fichier que le laisser deviner.

Sur `setFee`, la reponse redevient franche, et les deux couches se partagent le
travail proprement. La fonction n'a ni token a approuver ni montant a
transferer : elle a un APPELANT, un INSTANT et un ARGUMENT, et ses quatre
gardes (`Pool.sol:153-170`) portent exactement sur ces trois choses. Le bot
d'enchere enverra cette transaction depuis un compte reel, quelques secondes
apres le basculement d'epoch, et le front relira `feeInForce()` par `eth_call`
juste apres : c'est ce parcours que `test/Pool.setFee.test.ts` interroge, avec
ses quatre roles distincts (l'owner du deploiement, le gestionnaire du mandat,
le gestionnaire d'un AUTRE mandat, un tiers quelconque) et son horloge posee a
la seconde par `setNextBlockTimestamp`. La fenetre de priorite vaut douze
secondes : un `time.increase` relatif y deriverait de la seconde consommee par
le `setManager` qui precede, et c'est le piege numero un de cette suite.

Ce que la couche TypeScript ne peut pas faire sur `setFee`, c'est balayer un
domaine — chaque tirage y couterait une transaction et un aller-retour RPC.
`test/Pool.setFee.t.sol` le fait, sur les cinq axes de la fonction, et il porte
en particulier la seule formulation honnete de la fenetre : une EQUIVALENCE,
ou le meme tirage decide de la branche attendue. Deux tests unilateraux
seraient satisfaits par une fenetre placee ailleurs.

`setFee` est aussi la fonction qui a rendu vivante la suite de `feeInForce` :
c'est le seul organe qui ecrive `lastSetFeeEpoch`, donc le seul par qui une
route ABI legitime mene a la branche "mandat courant" du ternaire. La suite de
`setFee` s'en sert comme OBSERVABLE — `feeInForce()` est la seule lecture qui
dise ce que le protocole facture — sans la re-tester : elle a son propre
fichier, et sa propre preuve par `vm.store`.

La couche Solidity (fuzz, invariants, forge d'etat par `vm.store`, tenue des
bandes face a une decote) est une question distincte, traitee dans sa propre
section plus bas.

## Perimetre couvert

Cette suite couvre `Pool.sol` seul. Les dependances OpenZeppelin (`ERC20`,
`Ownable`, `Pausable`, `SafeERC20`, `Math`) sont hors perimetre : on suppose
leur comportement correct, on ne teste que ce que `Pool.sol` fait avec elles
(les montants qu'il transfere, les montants qu'il mint, les erreurs qu'il
declenche). La seule exception assumee est `SafeERC20`, dont la promesse
elle-meme est verifiee sur les quatre sites d'appel du pool : voir la section
qui lui est consacree plus bas, et la raison qui l'y met.

Le panier est fige a trois wrappers de BTC a cibles EGALES, un tiers chacun :
WBTC en indice 0, cbBTC en indice 1, LBTC en indice 2. Il n'y a plus ni
quatrieme jeton ni poids cibles differencies.

La suite compte 370 tests verts : 262 en TypeScript (11 fichiers `test/*.test.ts`)
et 108 en Solidity (10 fichiers `test/*.t.sol`, 5 fichiers `contracts/*.t.sol`),
plus 3 tests marques "skipped" (la migration FEE_DEN documentee en IV de
`Pool.feeSplit.t.sol` : la constante `FEE_DEN` ne peut pas etre modifiee
sans toucher `Pool.sol`, hors perimetre de cette tache ; le test BID_SILENCE
de `Auction.test.ts` : `BID_SILENCE == 0` est la valeur livree a I.3, le gate
A4 est roadmap).

## Structure de la suite

`Pool.constructor.test.ts` :

```
Pool.constructor
  I] Valeurs figees a la construction
    A) Immuables relus par leur getter
    B) Valeurs prises sur le bloc de deploiement
    C) Etat mutable de depart
    D) Le panier de jetons
  II] Les deux gardes de la bande de frais
    A) FeeTooHigh, la borne de _nominalFeeNum
    B) EmptyFeeBand, la borne de _minFeeNum
    C) Chaque garde sort SON erreur
  III] Les deux gardes de l'horloge d'enchere
    A) ZeroEpochDuration, la borne de _epochDuration
    B) PriorityWindowTooLong, la borne de _priorityWindow
    C) Chaque garde sort SON erreur, plusieurs arguments fautifs a la fois
  IV] Cas limites
    A) Frais nuls, acceptes deliberement
    B) treasury et owner sont deux roles distincts
```

`Pool.currentEpoch.test.ts` :

```
Pool.currentEpoch
  I] L'epoque de depart
    A) Au deploiement
  II] La frontiere du premier basculement
    A) La derniere seconde de l'epoque 0 et la premiere de l'epoque 1
    B) Les frontieres suivantes sont espacees d'exactement EPOCH_DURATION
    C) Une epoque quelconque, loin du premier basculement
  III] Proprietes de l'horloge
    A) La lecture est monotone
    B) L'horloge ne s'arrete pas quand le pool est en pause
    C) La lecture n'a aucun effet de bord
```

`Pool.feeInForce.test.ts` :

```
Pool.feeInForce
  I] La valeur rendue au deploiement
    A) Le nominal passe au constructeur, sur deux pools distincts
    B) Accord avec le getter brut feeNum()
    C) lastSetFeeEpoch est lisible par l'ABI
  II] Le repli sur le nominal quand l'epoch a tourne
    A) L'epoch 1
    B) Une epoch lointaine
  III] Proprietes de la lecture
    A) La lecture n'a aucun effet de bord
    B) La pause ne change pas la valeur rendue
```

`Pool.addLiquidity.test.ts` :

```
Pool.addLiquidity
  I] addLiquidity sur pool vide
    A) Cas nominal
    B) Reverts
    C) Cas limites
  II] addLiquidity sur pool amorce
    A) Cas nominal
    B) Reverts
    C) Cas limites
    D) Pool desequilibre
      1) Composition et parts, independamment de la formule interne
      2) Consequence observable du choix de l'ancre (calcul a la main)
      3) Evenement avec des montants distincts
      4) Arrondi (ceilDiv, G2) : la jambe non ancree grossit toujours au
         moins de la valeur tronquee, jamais moins
```

`Pool.removeLiquidity.test.ts` :

```
Pool.removeLiquidity
  I] removeLiquidity sur pool vierge
    A) Reverts
  II] removeLiquidity sur pool amorce
    A) Cas nominal
    B) Reverts
    C) Cas limites
      1) _burnedShares == 0
      2) Arrondi entier, toujours en faveur du pool
      3) Retrait total et propriete des parts
      4) Retraits successifs
    D) Pool desequilibre
      1) Composition et proportionnalite
      2) Consequence chiffree du desequilibre (calcul a la main)
      3) Evenement avec des montants distincts
  III] Proprietes de conservation
    A) Aller-retour addLiquidity puis removeLiquidity
    B) Les frais reviennent aux LP
```

`Pool.swap.test.ts` :

```
Pool.swap
  I] Gardes structurelles
    A) Pool vierge (aucun addLiquidity, les trois reserves a zero)
    B) InsufficientReserve (aucun `it` : garde inatteignable par l'ABI,
       documentee en commentaire et renvoyee a la couche Solidity)
  II] swap sur pool amorce, feeNum = 5
    A) Cas nominal
    B) Balayage des six paires (indexIn, indexOut) distinctes
    C) Reverts
    D) Cas limites
    E) Pool desequilibre
    F) Bandes par actif (plancher/plafond)
  III] Proprietes de conservation
    A) Aucune valeur creee ex nihilo
    B) Comptabilite LP intacte
```

`Pool.pause.test.ts` :

```
Pool.pause
  I] pause et unpause
    A) Controle d'acces
    B) Cablage sur l'etat OZ
  II] Effet sur les points d'entree, pool en pause
    A) addLiquidity refuse
    B) swap refuse
    C) removeLiquidity accepte
    D) setFee reste appelable
  III] Retour a l'etat normal apres unpause
```

`Pool.manager.test.ts` :

```
Pool.manager
  I] Lecture du mandat courant
    A) Epoch 0, personne nomme
    B) Epoch 0, managerOf[0] et manager() coincident
    C) Epoch 1, managerOf[1] vide : manager() rend 0x0
    D) Epoch 7, managerOf[7] sette
  II] setAuction
    A) onlyOwner
    B) Premier set a une adresse non-nulle
    C) Deuxieme set, quelle que soit l'adresse
    D) Premier set a address(0) : no-op silencieux, voie bootstrap
  III] setManager - appelant
    A) auction non-nulle, msg.sender == auction : succes
    B) auction non-nulle, msg.sender autre : revert NotAuctionOrOwner
    C) auction nulle, msg.sender == owner : succes (voie bootstrap)
    D) auction nulle, msg.sender autre : revert NotAuctionOrOwner
    E) auction == msg.sender == owner : succes (cas degenere)
  IV] setManager - gardes de fond
    A) _who == address(0) : revert ZeroManager
    B) _epoch <= currentEpoch() : revert EpochAlreadyStarted
    C) _epoch == currentEpoch() + 1 : succes
    D) Double nomination, memes epoch ou epochs distinctes
  V] Evenement ManagerSet
    A) Succes de setManager
    B) Revert de setManager
```

`Pool.setFee.test.ts` :

```
Pool.setFee
  I] Le chemin nominal
    A) Le tarif pose par le gestionnaire du mandat courant
    B) L'evenement FeeSet
  II] Les quatre gardes
    A) NotManager - l'appelant n'est pas le gestionnaire du mandat courant
    B) OutsidePriorityWindow - la fenetre est fermee
    C) FeeAlreadySetThisEpoch - une seule ecriture par mandat
    D) FeeOutOfBand - la bande du gestionnaire est
       [MIN_FEE_NUM, MAX_FEE_NUM / UNBALANCE_FACTOR]
  III] L'ordre des gardes
    A) L'acces passe avant la fenetre
    B) La fenetre passe avant l'unicite
    C) L'unicite passe avant la bande
  IV] Le mandat 0
    A) La nomination y est impossible
    B) Le tarif y est donc ferme a tout le monde
  V] Le mandat suivant retombe au nominal
    A) Sans reelection
    B) Avec reelection
  VI] La pause ne bloque pas setFee
```

`Auction.test.ts` (I.3, etape 8b du plan) :

```
Auction
  I] placeBid — la fenetre et le seuil
    A) Premiere mise sous MIN_OPENING_BID revert BidTooLow (test 18)
    B) Hausse sous +10 % revert, exactement +10 % passe (test 19)
    C) Mise en dehors de la fenetre revert WindowClosed (test 20)
    D) Mise pendant BID_SILENCE revert (test 21, skip : BID_SILENCE == 0 a I.3)
  II] refunds — credit et tirage
    A) L'encherisseur depasse est credite, pas transfere (test 22)
    B) Un contrat qui revert a la reception peut etre depasse (test 23)
    C) Le meilleur encherisseur est manager-designate (test 24)
  III] settle — brule, transfere, appelle notifyRent, emet l'evenement
    A) settle brule 30 %, envoie 70 % au pool, second settle est un no-op (test 25)
    B) settle par une adresse aleatoire passe (test 26)
    C) Mandat sans encherisseur : settle revert et pool reste tradable (test 27)
  IV] withdrawRefund — CEI et pull-only
    A) Un ancien encherisseur tire son refund
    B) Un appel sans refund disponible revert NoBidToRefund
    C) Un autre encherisseur ne peut pas tirer le refund du premier
  V] Reinitialisation par comparaison (build-auction.md 4.5)
  VI] windowOpen et closesAt — vues
```

`contracts/Auction.t.sol` (couche Solidity d'I.3) :

```
AuctionEpochResetTest            reinit par comparaison, refunds preserves
AuctionManagerCouplingTest       couplage Auction ↔ Pool, ManagerAlreadySet
AuctionSettleInvariantTest       partage 70/30, idempotence, evenement Settled
AuctionWithdrawRefundCEITest     CEI de withdrawRefund
```

Trois points d'I.3, documente la ou il faut les chercher.

1. `HIGH_BID_BPS` est fixe a `11000` dans `Auction.sol`, pas `1100` comme
   ecrit dans le brief I.3. `1100 / 10000 = 0.11 = 11 %` de highBid, ce
   qui n'est PAS une hausse de +10 %, c'est un effondrement. La regle
   annoncee ("+10 % raise") exige `1.10 * highBid`, soit `11000 / 10000`
   ou `1100 / 1000`. La combinaison `1100` + `10000` du brief est un
   typo ; la valeur corrigee `11000` donne la regle que le test 19
   epingle, et la constante est documentee en commentaire au-dessus de
   sa declaration.

2. `setManager` est appele UNE SEULE FOIS par auction, au moment du
   `settle()`, avec le `highBidder` du moment — c'est-a-dire le DERNIER
   enchérisseur de l'enchere au moment ou elle bascule. La garde
   `managerOf[epoch] != address(0)` de Pool.setManager (I.1) tient : un
   second appel reverterait `ManagerAlreadySet`, et l'Auction ne le
   tente jamais. `placeBid` ne touche pas a `pool.setManager` : pendant
   toute la duree de l'enchere, `pool.managerOf(epoch) == address(0)`,
   et le front lit `auction.highBidder()` pour afficher le meneur
   courant. Le design anterieur nommait le PREMIER enchérisseur (un
   acteur hostile pouvait poser la mise minimale et devenir manager
   avant qu'un meilleur enchérisseur ne le depasse) ; le design
   corrige tient la regle R3 (l'office est pris par le passage du
   temps) et fixe la nomination au DERNIER enchérisseur, qui est
   forcement le meilleur. Le commentaire d'entete d'`Auction.sol`
   (point 3) tient la justification complete ; test 24 verifie ce
   timing en deux temps — `managerOf(epoch) == address(0)` apres un
   `placeBid`, et `managerOf(epoch) == B` apres `placeBid(A)` +
   `placeBid(B)` + `settle()`.

3. Le stub `notifyRent(uint256)` ajoute a `Pool.sol` a I.3 est
   intentionnellement vide : il accepte tout appelant et ne fait rien,
   pour ne pas casser le `settle()` de l'Auction (qui appelle
   `pool.notifyRent(lpAmount)`). I.4 remplacera ce corps par
   l'accumulateur streame lineairement de la rent LP
   (build-auction.md 5.4). Le stub est documente en commentaire et le
   FIXME preserve pour le grep.

La couche Solidity, elle, se lit par fichier plutot que par arborescence :

```
test/Pool.addLiquidity.t.sol     fuzz des deux branches (pool vide, pool amorce)
test/Pool.removeLiquidity.t.sol  fuzz du pool vierge et du pool amorce
test/Pool.swap.t.sol             fuzz, domaine partage par MAX_IN_BAND_AMOUNT
test/Pool.safeERC20.t.sol        les quatre sites d'appel de SafeERC20
test/Pool.forgedState.t.sol      proprietes atteintes par forge d'etat (vm.store)
test/Pool.feeInForce.t.sol       packing du slot + lecture paresseuse, par vm.store
test/Pool.setFee.t.sol           fuzz des cinq axes de setFee (bande, appelant, instant, epoch)
test/Pool.depeg.t.sol            les bandes face a une decote reelle d'un wrapper
test/Pool.invariant.t.sol        handler + quatre invariants + un test cible
test/Pool.feeSplit.t.sol         bornes croisees + invariant I1 de conservation des frais (I.2)
contracts/Pool.gas.t.sol         mesures de gaz (rapport dans GAS.md)
contracts/Pool.t.sol             decimals()
contracts/MockWrappedBTC.t.sol   le mock ERC20Capped du panier
contracts/MRN.t.sol              le jeton natif MRN (migre a ERC20Burnable a I.3)
contracts/Auction.t.sol          Auction, couche Solidity I.3
```

L'amorcage est ecrit en dur, et a montants EGAUX. Sur pool vide,
`addLiquidity` ignore entierement `_anchorIndex` et pose
`amounts[0] = amounts[1] = amounts[2] = _amount` (`Pool.sol:93`). Un premier
depot de `_amount` donne donc des reserves `[_amount, _amount, _amount]`,
`mintedShares = 3 * _amount - MINIMUM_LIQUIDITY` (`Pool.sol:91`) et
`totalSupply = 3 * _amount`, les `MINIMUM_LIQUIDITY` manquantes etant frappees
vers l'adresse morte (`Pool.sol:98`). Il n'existe plus de `targetOf` ni de
poids cibles differencies : les trois cibles sont egales, un tiers chacune.
Toute la suite `I]` (pool vide) est ecrite sur cette base, et les fixtures
amorcees des quatre fichiers TypeScript en decoulent : `SEED_AMOUNT = 100e8`
donne des reserves `[1e10, 1e10, 1e10]`, `29 999 999 000` parts au deposant et
un `totalSupply` de `30 000 000 000`.

La section `II.D` merite un mot. Elle ne recalcule pas la formule interne du
contrat sur pool amorce (`Math.ceilDiv(_amount * reserves[i],
reserves[_anchorIndex])`, `Pool.sol:108`) en JavaScript pour la comparer au
resultat on-chain : un test qui reimplemente la ligne qu'il teste ne prouve
rien, il verifie que le code fait ce que le code fait. La sous-section `1)`
verifie a la place des proprietes qui se deduisent de ce que doit etre un AMM,
independamment de l'implementation : un depot ne change pas la composition du
pool (le rapport entre deux reserves est identique avant et apres, verifie en
comparant directement les reserves attendues — chaque reserve doit croitre de
la meme fraction que le depot represente sur son ancre — a celles lues
on-chain), et les parts emises sont proportionnelles a la fraction du pool
apportee. Cette propriete de composition est testee une fois par ancre (trois
`it` distincts, une fonction d'aide nommee factorise le scenario) : chaque
ancre est une transaction differente, donc un comportement a verifier
separement, une seule assertion par test. La sous-section `2)` documente, avec
des montants poses en dur et un calcul a la main en commentaire, la
consequence observable du choix de l'ancre : a montant nominal identique,
ancrer sur l'actif le plus rare mint plus de parts et preleve plus sur les
autres tokens qu'ancrer sur l'actif le plus abondant.

Le desequilibre ne vient plus de poids cibles inegaux — il n'y en a plus —
mais du seul swap prealable de la fixture. `deployImbalancedPoolFixture`
amorce a `1000e8` par jambe (donc `[1000e8, 1000e8, 1000e8]`), puis echange
`250e8` de token0 vers token2 a `feeNum = 0`, ce qui rend `200e8` : les
reserves deviennent `[1250e8, 1000e8, 800e8]`. C'est donc token0 (WBTC), qui a
RECU le swap, le plus abondant, et token2 (LBTC), qui en est sorti, le plus
rare ; token1 (cbBTC) reste au milieu, intouche. Rien la-dedans ne tient a
l'identite des jetons, tout tient au sens du swap. La fixture reste dans les
bandes (`sum = 3050e8`, soit `40,98 %` / `32,79 %` / `26,23 %`, tous entre 13
et 53).

La sous-section `3)` verifie que l'evenement `AddedLiquidity` porte bien trois
`amountsIn` distincts sur ce pool desequilibre — `[10 000 000 000,
8 000 000 000, 6 400 000 000]` pour un depot de `100e8` ancre sur token0 —
ce que la verification sur pool vide (`I.A`) ne peut structurellement pas
montrer, l'amorcage a montants egaux y donnant trois jambes identiques. La
sous-section `4)`, ajoutee avec le passage de la division entiere a
`Math.ceilDiv` (`Pool.sol:108`), epingle l'arrondi : un depot de `333` ancre
sur token1 fait croitre les reserves de `[417, 333, 267]`, la ou une
troncature aurait donne `[416, 333, 266]`. Le test lit AUSSI ce que le
deposant a reellement paye, et constate que c'est le meme triplet : l'arrondi
va au pool, jamais a l'appelant, exactement comme la troncature de
`removeLiquidity` et celle d'`amountOut` dans `swap`.

Un test fait exception a la regle "une assertion par `it`" au sens strict du
decompte de transactions : "sur un pool fraichement amorce, `mintedShares` est
identique quel que soit l'ancre" (`II.A`) execute trois depots, un par ancre,
et conclut par une unique assertion sur leur egalite. La propriete decoule
directement de l'amorcage a montants egaux : les trois reserves valent
`1e10` juste apres le premier depot, donc `supply * _amount /
reserves[_anchorIndex]` (`Pool.sol:103`) ne depend plus du tout de l'ancre.
C'est une egalite a TROIS termes, et une egalite ne se decompose pas en tests
independants sans perdre ce qu'elle affirme : un `it` isole par ancre
prouverait une valeur, jamais l'egalite de trois valeurs. C'est different du
cas de composition ci-dessus, ou chaque ancre est une transaction et un
comportement distincts.

La section `II.C` de `Pool.removeLiquidity.test.ts` merite le meme genre de
mot que `II.D` d'`addLiquidity`. Sa sous-section `2)` (arrondi entier) fixe un
cas ou la division entiere de Solidity tronque le montant a verser : bruler
une seule part sur un pool amorce a 100 (8 decimales) sur chaque reserve rend
zero token, la fraction perdue restant acquise aux autres detenteurs de parts.
C'est une regle de conception assumee (le pool ne perd jamais au benefice
d'un seul retrait), et le test la verifie par une valeur posee en dur avec le
calcul en commentaire, plutot que par un recalcul de la formule interne — le
recalcul ne prouverait que la coherence du code avec lui-meme. Sa sous-section
`3)` va plus loin : un retrait de la totalite du solde "libre" d'un
deposant (tout sauf les parts perdues sur l'adresse morte) laisse un residu
non nul dans chaque reserve — `334` unites sur chacune des trois, l'amorcage
etant a montants egaux (calcul a la main en commentaire : `1e10 *
29 999 999 000 / 3e10 = 9 999 999 666`, soit `334` de reste). C'est la meme
protection anti-inflation que `MINIMUM_LIQUIDITY` en amorcage,
mais observee de l'autre cote : le pool ne peut structurellement pas se vider
sous le seuil que sa premiere part brulee garantit. Sa sous-section `4)`
verifie que la fonction se comporte de la meme facon au deuxieme passage
qu'au premier : deux retraits successifs de la meme quantite de parts
rendent exactement les memes montants, parce que c'est le rapport
`reserves[i] / totalSupply` qui reste invariant sous un retrait (les deux
baissent de la meme fraction), pas les reserves en valeur absolue.

La section `III` change de registre : elle ne teste plus une valeur
particuliere mais des proprietes qui doivent tenir quelle que soit
l'implementation exacte de la formule. `III.A` verifie qu'un aller-retour
depot puis retrait ne cree jamais de valeur ex nihilo (on ne recupere jamais
plus qu'on a depose), sur les trois tokens independamment via une fonction
d'aide nommee, dans le meme esprit que `assertCompositionPreservedWhenAnchoredOn`
d'`addLiquidity`. `III.B` verifie la contrepartie economique du modele a
frais : un tiers qui fait un aller-retour de swaps laisse une partie de son
montant en frais dans les reserves (`Pool.sol:139`), et l'unique LP du
pool en profite au retrait, en recuperant strictement plus que son depot
initial.

`Pool.swap.test.ts` appelle six remarques.

La section `I` teste les deux gardes ajoutees le 2026-08-15, et l'une des deux
n'est pas testable. `ZeroOutput` l'est : sur un pool vierge, la reserve de
sortie est nulle, donc `amountOut` l'est aussi, et l'appel est refuse au lieu
d'encaisser le `transferFrom` entrant sans rien rendre. `InsufficientReserve`
ne l'est pas : elle ne peut se declencher que si la reserve d'ENTREE est nulle
(des que `reserves[_indexIn] > 0`, `amountOut` est strictement inferieur a
`reserves[_indexOut]` par construction de la formule), or cet etat n'est plus
atteignable par l'ABI une fois `ZeroOutput` en place — `addLiquidity` garnit
les trois reserves ensemble, `removeLiquidity` laisse toujours un residu, et
`swap` ne peut plus vider une reserve. La garde protege donc un invariant, pas
un chemin courant, et elle prend son sens en Phase 2, ou le solveur de Newton
pourra ramener `amountOut` a `reserves[_indexOut]` par un arrondi different.
Elle est documentee en commentaire dans la suite et renvoyee a la couche Solidity, seule capable de
forger l'etat par `vm.store` : c'est desormais chose faite, dans
`test_InsufficientReserveReachedViaForgedState` (`test/Pool.invariant.t.sol`).
C'est le meme genre de branche que le `totalSupply() == 0` de
`removeLiquidity` : reelle, mais inatteignable depuis l'exterieur.

La section `II.B` balaie les six paires `(indexIn, indexOut)` distinctes, une
par `it`. Sur `deploySeededPoolFixture`, l'amorcage a montants egaux donne
`[1e10, 1e10, 1e10]` : les six paires rendent donc exactement le meme montant,
`904 956 798` pour une entree de `1e9` a `feeNum = 5`, et une seule constante
`NOMINAL_SWAP_AMOUNT_OUT` suffit, calculee a la main. Chaque paire reste
neanmoins testee individuellement, et non via une boucle englobee dans un
`it` : chacune est une transaction differente au niveau de l'ABI, donc un
comportement a verifier separement, dans l'esprit du "une ancre = un `it`"
d'`addLiquidity`.

La section `II.D` documente un choix de conception assume : `_indexIn ==
_indexOut` n'est PAS garde. L'appel reussit, le swapper paie `_amount` et
recupere `amountOut` du meme token, donc il perd les frais et le slippage. Deux
`it` le verifient par des lectures on-chain, et la conclusion est celle qui
justifie l'absence de garde : rien n'est draine du pool, la reserve monte
exactement de ce que l'appelant perd. C'est le seul des trois cas degeneres de
`swap` a ne pas avoir recu de `require`, et la raison en est la : les deux
autres faisaient perdre de l'argent a un integrateur qui ne pouvait pas savoir,
celui-ci ne fait perdre de l'argent qu'a qui le demande explicitement.

Toujours en `II.D`, un cas a change de nature : l'ancien "`amountOut` reste
strictement sous `reserves[_indexOut]`, meme sur une entree tres superieure
aux reserves" attendait `amountOut < reserveOut`. La propriete elle-meme tient
toujours de la seule formule du produit constant, mais elle n'est plus
atteignable par l'ABI : la boucle de bandes (`Pool.sol:151-154`) revert
desormais bien avant. Sur `deploySeededPoolFixture` (`[1e10, 1e10, 1e10]`,
`feeNum = 5`), une entree de `2e10` porterait la jambe entrante a `69,21 %` de
la somme, tres au-dessus du plafond de `53 %`, d'ou `CeilingTouched(0)` — et
c'est bien l'indice `0` qui interrompt l'appel, la boucle balayant les indices
dans l'ordre. Le test verifie maintenant ce revert, avec un commentaire qui
explique le changement plutot que de faire disparaitre la trace de l'ancienne
propriete.

Un seul test de la suite a besoin de DEUX pools vivants en meme temps, la
comparaison `feeNum = 0` contre `feeNum = 5` (le `feeNum` est fixe a la
construction, et `setFee` n'est ouvert qu'au gestionnaire du mandat courant,
dans sa fenetre de priorite). Les deux `loadFixture` y sont appeles avant toute
ecriture, et ce n'est pas cosmetique :
`loadFixture` restaure un instantane de la chaine, ce qui detruit tout ce qui a
ete deploye apres sa prise. Charger la seconde fixture apres avoir mint sur la
premiere effacerait ce mint, et charger la plus ancienne des deux en second
effacerait les contrats de l'autre. Corollaire utilise ailleurs dans le
fichier : deux `loadFixture` de la MEME fixture ne donnent jamais deux pools
independants, seulement deux fois le meme, donc la comparaison "le plus rare
contre l'intermediaire" (`II.E`) se fait par deux `simulate` (qui n'ecrivent
rien) sur un unique pool. Les labels tiennent au swap prealable de
`deployImbalancedPoolFixture` et non a l'identite des jetons : reserves
`[1250e8, 1000e8, 800e8]`, donc token0 (WBTC) le plus abondant, token2 (LBTC)
le plus rare, token1 (cbBTC) l'intermediaire (voir la remarque equivalente sur
`Pool.addLiquidity.test.ts` plus haut). Depuis token0, les deux destinations
possibles sont donc token1 (l'intermediaire, `7 407 407 407` rendus) et token2
(le plus rare, `5 925 925 925`), a entree identique de `1e10` et `feeNum = 0`.

Enfin, la section `II.F` couvre la boucle de bandes, placee apres le calcul
d'`amountOut` et ses gardes existantes, avant `BadSlippage`
(`Pool.sol:151-154`). Les bandes ne sont pas differenciees par actif malgre le
nom de la section, herite d'un dessin anterieur : `Pool.sol` porte deux
constantes SCALAIRES, `floor = 13` et `ceiling = 53` (`Pool.sol:20-21`), et la
boucle les applique aux trois indices identiquement. La condition est
exprimee en ratios, jamais en valeurs absolues, et par inegalites strictes :

```solidity
require(afterSwapReserves[i] * 100 < ceiling * sum, CeilingTouched(i));
require(afterSwapReserves[i] * 100 > floor  * sum, FloorTouched(i));
```

Elle porte sur l'etat d'ARRIVEE du swap, jamais sur l'etat de depart ni sur le
sens de l'echange. Quatre cas sont testes. Les trois premiers sur
`deployImbalancedPoolFixture` (`[1250e8, 1000e8, 800e8]`, `feeNum = 0`) : un
`0 -> 2` de `800e8` qui pousse la jambe ENTRANTE a `57,94 %`, au-dessus de son
plafond (`CeilingTouched(0)`) ; un `1 -> 2` de `800e8` qui pousse la jambe
SORTANTE a `12,71 %`, sous son plancher (`FloorTouched(2)`) ; et un `0 -> 2`
de `100e8`, nominal, qui laisse les trois jambes a `43,68 %` / `32,35 %` /
`23,96 %`, verifie sur les reserves resultantes et non sur la seule absence de
revert.

Le quatrieme est le plus important des quatre, puisqu'il justifie a lui seul
que la boucle parcoure les TROIS indices et pas seulement
`_indexIn`/`_indexOut` : un swap qui dilue la jambe NON impliquee hors de sa
bande, alors que les deux jambes actives restent chacune dans la leur. Il
tourne sur `deployZeroFeeSeededPoolFixture` (`[100e8, 100e8, 100e8]`,
`feeNum = 0`) et demande deux preparations, un `1 -> 0` de `50e8` puis un
`2 -> 0` de `47e8`, qui garent token0 a `13,247 %`, juste au-dessus de son
plancher, sans faire sortir personne de sa bande. Le `1 -> 2` de `35e8` qui
suit laisse token1 a `52,93 %` et token2 a `34,10 %`, tous deux conformes, et
fait pourtant tomber token0 a `12,97 %` sans qu'un seul satoshi de sa reserve
ne bouge : c'est le denominateur, la somme des trois, qui l'a sorti de sa
bande. `FloorTouched(0)`. Une seule preparation ne suffit pas : la dilution
requise ferait alors franchir a token1 son propre plafond en premier.

`Pool.pause.test.ts` appelle trois remarques.

La premiere fixe la frontiere du perimetre, plus finement que le "les
dependances OZ sont hors perimetre" du paragraphe d'ouverture. La regle est :
on teste ce que `Pool.sol` DECIDE, jamais ce qu'OpenZeppelin EXECUTE. Repauser
une pool deja en pause revele avec `EnforcedPause()`, mais c'est le modifieur
d'OZ qui le fait, pas une ligne de `Pool.sol` ; de meme pour l'emission de
`Paused` et `Unpaused`. Ces cas ne sont pas testes. En revanche "l'owner
appelle `pause()`, puis `paused()` vaut `true`" l'est, parce que c'est la seule
assertion qui prouve que la fonction externe est effectivement branchee sur
`_pause()` : sans elle, une fonction au corps vide passerait toute la suite.
Meme raison pour `onlyOwner` sur les deux leviers, qui est un choix de
`Pool.sol` et non d'OZ, et meme raison pour toute la section `II`, qui ne
verifie pas le fonctionnement du modifieur mais le choix des fonctions sur
lesquelles il est pose.

La deuxieme porte sur l'ordre des gardes, que cette suite documente comme les
trois autres, mais avec une conclusion plus courte. Un modifieur n'est pas un
`require` place avant la fonction : c'est un corps dans lequel le compilateur
inline le corps de la fonction decoree, a l'emplacement du `_;`. Tout ce qui
precede le `_;` s'execute donc en premier, et `whenNotPaused` preempte
integralement les gardes du corps, `BadSlippage`, `ZeroOutput`, les erreurs
ERC-20 et jusqu'aux panics d'index hors bornes. Un seul `it` etablit cette
preemption, la ou les autres fichiers consacrent un test a chaque paire de
gardes.

La troisieme porte sur `II.C` et sur ce qu'une assertion doit affirmer. Un test
qui se contente de constater l'absence de revert sur `removeLiquidity` passe
aussi si la fonction ne fait rien : il faut assertion sur les montants
reellement sortis et sur les reserves apres coup. C'est la promesse centrale de
la pause, elle merite mieux qu'une double negation.

`Pool.manager.test.ts` appelle trois remarques.

La premiere tient a la specificite de la troisieme surface du contrat. Le
panneau `managerOf`/`setAuction`/`setManager` n'a pas d'analogue parmi les
cinq autres fonctions TypeScript : `manager()` est un observateur pur sur
`managerOf[currentEpoch()]`, `setAuction` est un single-shot, et `setManager`
est la seule fonction du contrat a prendre une epoch en argument plutot qu'un
montant. Eclatee entre la suite de pause et celle de swap, la frontiere
entre bootstrap et regime nominal disparaissait : on aurait vu "owner peut"
et "tiers ne peut pas" sans voir le moment ou le droit bascule du premier au
second. Le fichier est donc recentre sur la disjonction de `Pool.sol:116` :
`msg.sender == auction || (auction == 0x0 && msg.sender == owner)`, dont les
deux branches n'ont pas la meme duree de vie.

La deuxieme tient a ce que les cas impossibles par l'ABI revelent du code
plutot que du test. La section I.B tient, non pas "managerOf[0] sette,
manager() le rend", mais la portion atteignable de l'enonce : que `manager()`
et la lecture directe de `managerOf[0]` par son getter public renvoient la
meme valeur, condition strictement plus faible mais qui suffit a epingler un
eventuel detournement d'indice. Meme demarche en I.C : `managerOf[0]` n'est
pas settable par `setManager` (la garde `_epoch > currentEpoch()` de
`Pool.sol:117` est stricte), donc le test tient la portion verifiable
"managerOf[1] vide a l'epoch 1". Le commentaire le dit, pour que le lecteur
sache que l'enonce du prompt etait plus ambitieux que le test ne l'est.

La troisieme tient au no-op silencieux de `setAuction(0x0)` (section II.D),
qui est un choix delibere, pas un oubli. La garde `Pool.sol:111` ne verifie
que `auction == address(0)` : passer zero en argument satisfait la garde et
fait `auction = 0x0`, identique a l'etat de depart. C'est ce qui maintient la
voie bootstrap ouverte apres chaque `setAuction(0x0)`, donc ce qui permet a
l'owner de nommer des gestionnaires epoch par epoch jusqu'a l'arrivee de
l'encherisseur. Le test verifie les deux faces du no-op (pas de revert,
`auction()` reste a `0x0`) puis la consequence : un `setManager` ulterieur
par l'owner, sur une epoch future valide, reussit. La mention "no-op
silencieux, voie bootstrap" dans le titre est ce qui empeche un lecteur
ulterieur de prendre la section pour un test a supprimer au motif que la
transaction n'ecrit rien.

`Pool.constructor.test.ts` appelle trois remarques.

La premiere porte sur la frontiere que testent ses deux gardes de frais, et elle n'est
pas celle qu'on lit au premier coup d'oeil. Les deux `require` du constructeur
(`Pool.sol:70-71`) ne bornent pas la base du frais mais le frais EFFECTIF :
la surcharge de desequilibre multiplie la base par `UNBALANCE_FACTOR`, d'ou
`base * UNBALANCE_FACTOR <= MAX_FEE_NUM`. Avec `MAX_FEE_NUM = 50` et
`UNBALANCE_FACTOR = 2`, la borne des deux arguments tombe donc sur `25`, pas
sur `50` : `25 * 2 = 50` passe, `26 * 2 = 52` reverte. C'est la meme inegalite
ecrite deux fois, sur `_nominalFeeNum` puis sur `_minFeeNum`, et c'est
precisement ce qui rend la section `II.C` necessaire. Rien dans le code ne
garantit, a la lecture seule, que l'erreur rendue nomme le bon argument : une
interversion de `FeeTooHigh` et d'`EmptyFeeBand` compilerait, passerait des
tests qui n'exigeraient qu'un revert, et enverrait l'operateur corriger le
mauvais parametre au deploiement. Les trois cas de `II.C` ferment cette
confusion, dont celui ou les deux arguments sont fautifs : `FeeTooHigh` sort
en premier, `_nominalFeeNum` etant verifie avant `_minFeeNum`.

La deuxieme porte sur les deux gardes d'horloge ajoutees a la section `III`
(`Pool.sol:72-73`), et sur ce qui les distingue des deux precedentes. Elles ne
bornent aucune valeur economique mais la coherence du decoupage du temps que
`currentEpoch()` derivera ensuite, et les deux echecs qu'elles ferment ne sont
pas de meme nature. `_epochDuration = 0` donne un contrat MORT :
`EPOCH_DURATION` etant le denominateur de `currentEpoch()`, toute lecture
reverterait en panic `0x12`, et le defaut ne se revelerait qu'au premier appel,
sur un immuable qu'aucune fonction ne peut plus corriger.
`_priorityWindow > _epochDuration` donne un contrat INCOHERENT plutot que mort :
la fenetre de priorite du gestionnaire sortant couvrirait plus que le mandat
lui-meme, donc la priorite ne s'eteindrait jamais et l'enchere ne changerait
jamais de main. Les frontieres sont asymetriques et il faut les lire comme
telles : `_epochDuration` est bornee par un `>` STRICT et par en bas seulement
(zero refuse, `1` accepte, aucune borne haute), tandis que `_priorityWindow`
est bornee par un `<=` (une fenetre egale a l'epoque entiere passe, une
fenetre nulle aussi). La section `III.C` ne reprend pas les cas a un seul
argument fautif, deja tenus par `III.A` et `III.B` qui decodent le nom de
l'erreur ; elle ferme ce que ceux-la ne peuvent pas voir, le cas ou plusieurs
arguments sont hors borne en meme temps. Deux cas y suffisent : les deux
arguments d'horloge fautifs sortent `ZeroEpochDuration` (`Pool.sol:72` avant
`73`), et une bande de frais fautive AVEC une horloge fautive sort
`FeeTooHigh`, la paire des frais precedant celle de l'horloge dans le corps du
constructeur (`Pool.sol:70-71` avant `72-73`). Ce second cas est le seul de
tout le fichier a etablir l'ordre ENTRE les deux familles de gardes, et non
entre deux gardes voisines.

La troisieme est un detail d'outillage qui pique, du meme genre que le
`vm.expectRevert` de `Pool.safeERC20.t.sol`. `viem.assertions.revertWithCustomError`
ne fonctionne pas sur un DEPLOIEMENT : ce matcher lit un
`ContractFunctionRevertedError`, que viem ne construit que pour un appel de
fonction. Un deploiement qui reverte remonte en `TransactionExecutionError`,
et la donnee de revert n'y est jamais decodee ; le selecteur brut vit plus bas
dans la chaine `cause`, sur l'erreur que le simulateur Hardhat y greffe. Le
fichier remonte donc cette chaine jusqu'a la premiere donnee hexadecimale,
puis la decode avec `decodeErrorResult` contre l'ABI reelle du contrat, lue
depuis l'artefact de compilation (`artifacts.readArtifact("Pool")`) et non
depuis un pool valide qu'il faudrait deployer pour ca seul. La route ecartee
est la meme qu'a la section sur les panics : chercher le nom de l'erreur dans
le TEXTE du message. Elle passerait, et pour la mauvaise raison.

`Pool.currentEpoch.test.ts` appelle trois remarques.

La premiere porte sur l'outil qui fait avancer le temps. Le fichier n'utilise
pas `networkHelpers.time.increase(delta)` mais
`time.setNextBlockTimestamp(cible)` suivi d'un `mine()`, encapsules dans un
helper `warpTo`. La raison est la frontiere : elle se joue a la SECONDE, et un
delta relatif deriverait de la seconde consommee par chaque transaction
precedente du test (un `mint`, un `approve`, un `pause`). Une cible absolue,
posee depuis `GENESIS` lu sur la chaine, fait porter l'assertion sur
exactement la valeur que le commentaire annonce. `GENESIS` lui-meme n'est
jamais recalcule depuis l'horloge du test : le recalculer reviendrait a
reimplementer la ligne testee, exactement ce que le fichier `addLiquidity`
refuse de faire sur `Math.ceilDiv`.

La deuxieme porte sur la section `II`, qui est le coeur du fichier et pas une
section parmi d'autres. Partout ailleurs dans une epoque, une division entiere
par une constante ne peut se tromper que si elle est grossierement fausse, et
le premier test venu le verrait. C'est a la seconde du basculement qu'une
erreur d'un cran devient visible, et nulle part ailleurs : d'ou trois paires
de cas plutot qu'une, autour du premier basculement (`GENESIS + 14399` vaut
encore `0`, `GENESIS + 14400` vaut `1`), autour du deuxieme (`28799` -> `1`,
`28800` -> `2`), puis huit epoques plus loin. Les deux `it` d'une paire se
lisent ensemble : chacun seul prouve une valeur, la paire situe la frontiere.

La troisieme est un risque assume du protocole, que la section `III.B` fige
plutot qu'elle ne le signale. `currentEpoch()` ne lit que `block.timestamp`,
`GENESIS` et `EPOCH_DURATION` (`Pool.sol:92-94`) : aucun des trois ne connait
`Pausable`, donc l'horloge d'enchere continue de defiler pendant une pause. Un
gestionnaire qui a remporte l'enchere voit son mandat s'ecouler sans pouvoir
agir si l'owner met la pool en pause, et il ne recupere pas le temps perdu.
Le choix inverse couterait plus qu'il ne rapporte : geler le compteur
exigerait de stocker le cumul de temps pause, donc une ecriture a chaque
bascule, et `currentEpoch()` cesserait d'etre derivable hors chaine par un
simple calcul sur `GENESIS`. La section le verifie sous deux angles, parce
qu'un seul ne suffit pas : que le compteur AVANCE en pause (trois epoques
passees, il vaut `3`), et qu'il avance AUX MEMES INSTANTS (a
`GENESIS + EPOCH_DURATION - 1` il vaut encore `0`, comme hors pause). Un
contrat qui aurait tente de compenser la pause, meme partiellement,
decalerait cette frontiere-la sans que la seule assertion "le compteur a
bouge" ne le voie.

### Duplication des fixtures entre les fichiers de test

`Pool.removeLiquidity.test.ts`, `Pool.swap.test.ts`, `Pool.pause.test.ts`,
`Pool.manager.test.ts`, `Pool.setFee.test.ts`, `Pool.constructor.test.ts` et
`Pool.currentEpoch.test.ts`
redefinissent chacun leurs propres fixtures et helpers
(`deployTokensAndPool`, `mintAndApprove`, `readReserves`, `readBalances`,
`assertPanic`, `deploySeededPoolFixture`, `deployImbalancedPoolFixture`...),
identiques a ceux d'`addLiquidity`, plutot que de les importer d'un module
partage. C'est delibere. Chaque fichier de test ouvre sa propre connexion
reseau via son propre appel a `network.create()` (voir la skill `hardhat`) :
c'est cette connexion qui porte l'etat de la blockchain simulee et le cache
de `networkHelpers.loadFixture`. Un module de fixtures partage entre les trois
fichiers devrait soit se lier a une connexion choisie arbitrairement (couplant
des fichiers senses etre independants les uns des autres), soit reconstruire ses
fixtures depuis la connexion du fichier appelant a chaque import (perdant
l'interet du partage). Dans les deux cas, un fichier qui echoue ou se
modifie peut casser l'autre sans lien logique evident. La duplication a un
cout (un second lieu a maintenir si `Pool.sol` change), mais elle est plus
sure qu'un couplage implicite entre deux suites qui doivent pouvoir tourner,
echouer et evoluer separement.

### Panics Solidity : comment ils sont attrapes

Plusieurs cas de la suite, repartis sur les trois fichiers, attendent un panic
Solidity (`Panic(uint256)`) plutot qu'une erreur nommee : `0x11` pour un
depassement ou un sous-flow arithmetique (les deux produisent le meme code,
Solidity ne distingue pas "trop grand" de "trop petit" dans son panic),
`0x12` pour une division par zero, `0x32` pour un acces hors bornes d'un
tableau. Un panic est une erreur ABI comme une autre : viem la decode
et expose son `errorName` (`"Panic"`) et son argument (le code numerique,
en `bigint`) sur un `ContractFunctionRevertedError`, quelque part dans la
chaine `cause` de l'erreur levee par l'appel `write`. Le helper `assertPanic`
remonte cette chaine jusqu'a le trouver, puis compare `errorName` et `args[0]`
au code attendu.

Route explicitement ecartee : chercher le code hexadecimal (`"0x11"`) par
expression reguliere dans le message d'erreur. Ce motif peut apparaitre
n'importe ou ailleurs dans le meme message (une adresse, un hash, un autre
montant hexadecimal) — un test ainsi ecrit peut passer pour la mauvaise
raison, sans avoir verifie la structure reelle de l'erreur. Verifier
`errorName` et l'argument decode sur l'erreur ABI, plutot que le texte du
message, est ce qui rend le test fiable.

## Cas limites couverts, par fonction

### `constructor`

**Valeurs figees a la construction**

- `EPOCH_DURATION`, `PRIORITY_WINDOW`, `MIN_FEE_NUM`, `NOMINAL_FEE_NUM`,
  `treasury` et `owner()` relus un a un par leur getter, une assertion par
  valeur. Les deux paires d'arguments consecutifs de meme type (`14400` /
  `12`, puis `1` / `5`) portent des valeurs volontairement tres differentes :
  une interversion fait echouer les deux tests de la paire, pas un seul
- `owner()` n'est pas pose par une ligne de `Pool.sol` mais par
  `Ownable(_owner)` dans l'entete du constructeur (`Pool.sol:66`). Ce qui est
  teste n'est donc pas OZ, hors perimetre, mais le cablage : que c'est bien le
  SEPTIEME argument qui y arrive, et pas `msg.sender` par defaut
- `GENESIS` vaut le timestamp du BLOC de deploiement (`Pool.sol:67`), lu sur
  la chaine et jamais recalcule depuis l'horloge du test — sous automine une
  transaction fait un bloc, donc le bloc `latest` lu juste apres le
  deploiement est celui du deploiement. Une seconde assertion, redondante
  avec la premiere, exige `GENESIS > 0` : elle seule survit a l'hypothese ou
  la lecture du bloc rendrait zero, cas ou l'egalite passerait sur un
  constructeur qui n'affecterait rien
- `feeNum` vaut `_nominalFeeNum` au deploiement (`Pool.sol:77`) : le pool
  demarre au tarif nominal sans qu'aucun argument dedie ne le dise. Verifie
  deux fois, contre la valeur attendue puis contre `NOMINAL_FEE_NUM()`, cette
  seconde forme affirmant l'egalite de depart independamment de la valeur
- `token0` / `token1` / `token2` reprennent `_tokens` dans l'ordre, en une
  seule assertion sur les trois : ce qui est affirme est un ORDRE (indice 0 =
  WBTC, 1 = cbBTC, 2 = LBTC), et un ordre ne se decompose pas en trois tests
  independants sans perdre ce qu'il affirme
- NON teste, hors perimetre : `OwnableInvalidOwner` sur `_owner == address(0)`
  (decide par OZ, pas par `Pool.sol`) et les noms ERC-20 `"MerionLP"` /
  `"MRNLP"`, poses en dur dans l'entete du constructeur et sans argument a
  verifier

**Reverts**

- `_nominalFeeNum = 25` passe (`25 * 2 = 50`, exactement `MAX_FEE_NUM`), et le
  test relit `NOMINAL_FEE_NUM` plutot que de constater l'absence de revert :
  un constructeur qui ecreterait silencieusement la valeur passerait sinon
- `_nominalFeeNum = 26` reverte (`26 * 2 = 52 > 50`) : `FeeTooHigh`
- `_minFeeNum = 25` passe, `_minFeeNum = 26` reverte : `EmptyFeeBand`. Meme
  frontiere que pour `_nominalFeeNum`, les deux `require` etant litteralement
  la meme inegalite
- chaque garde sort SON erreur, et pas celle de l'autre argument : le nom est
  decode depuis les quatre octets rendus, pas cherche dans le texte du message
- ordre des gardes : les deux arguments hors borne echouent par `FeeTooHigh`,
  `_nominalFeeNum` etant verifie en premier (`Pool.sol:70` avant `71`)
- `_epochDuration = 0` reverte : `ZeroEpochDuration` (`Pool.sol:72`). Sans
  cette garde le deploiement passerait, et `currentEpoch()` reverterait en
  panic `0x12` a la premiere lecture, sur un immuable non corrigeable
- `_epochDuration = 1` passe : la garde est un `>` strict sans borne haute,
  elle ne dit rien de la pertinence de la duree. Le test relit
  `EPOCH_DURATION` plutot que de constater l'absence de revert, un ecretage
  silencieux passerait sinon
- `_priorityWindow == _epochDuration` passe : le `require` est un `<=`
  (`Pool.sol:73`), la fenetre peut couvrir l'epoque entiere
- `_priorityWindow = _epochDuration + 1` reverte : `PriorityWindowTooLong`.
  Au-dela de cette borne la priorite du gestionnaire sortant ne s'eteindrait
  jamais, et l'enchere ne changerait jamais de main
- `_priorityWindow = 0` passe : aucune borne basse. C'est le deploiement ou le
  gestionnaire sortant n'a aucune priorite, l'enchere etant ouverte a tous des
  la premiere seconde de chaque epoque
- ordre des gardes, deux cas : `_epochDuration = 0` avec un `_priorityWindow`
  non nul rend les deux gardes d'horloge fautives et echoue par
  `ZeroEpochDuration` (`Pool.sol:72` avant `73`) ; une bande de frais fautive
  AVEC une horloge fautive echoue par `FeeTooHigh`, la paire des frais
  precedant celle de l'horloge (`Pool.sol:70-71` avant `72-73`)

**Cas limites**

- `_nominalFeeNum = 0` et `_minFeeNum = 0` deploient sans revert : aucune des
  deux gardes n'a de borne basse (`0 * 2 = 0 <= 50`). Ce n'est pas un oubli.
  Trois des cinq fichiers TypeScript deploient a frais nul
  (`deployZeroFeeTokensAndPoolFixture`) pour isoler l'arithmetique du produit
  constant du bruit du frais : sans ce zero, toutes leurs valeurs posees a la
  main devraient absorber une troncature supplementaire. La bande `[0, 5]` est
  donc un etat legitime du contrat
- `treasury` et `owner()` sont deux roles distincts dans la fixture, et
  `treasury()` n'est aucun des trois autres comptes (`deployer`, `depositor`,
  `other`). Sur un deploiement ou `treasury == owner`, une affectation croisee
  entre les deux passerait inapercue et le test de cablage ne prouverait plus
  rien

### `currentEpoch`

**L'epoque de depart**

- `currentEpoch()` vaut `0` sur le bloc de deploiement : `(GENESIS - GENESIS) /
  EPOCH_DURATION = 0`. L'epoque du deploiement est la `0`, la numerotation ne
  commence pas a `1`, et tout le reste du fichier compte des basculements
  depuis cette origine
- `currentEpoch()` vaut encore `0` a `GENESIS + 1` : sans ce cas, un contrat
  qui rendrait `block.timestamp - GENESIS` sans diviser passerait le
  precedent (`0 - 0 = 0`) et n'echouerait que beaucoup plus loin

**La frontiere**

- a `GENESIS + EPOCH_DURATION - 1` le compteur vaut encore `0`
  (`14399 / 14400 = 0`), a `GENESIS + EPOCH_DURATION` il vaut `1`
  (`14400 / 14400 = 1`). La paire est le coeur du fichier : la borne est
  inclusive cote epoque suivante, une epoque dure `EPOCH_DURATION` secondes
  pleines, de son premier instant inclus au premier instant de la suivante
  exclu
- meme paire au deuxieme basculement (`28799` -> `1`, `28800` -> `2`) : ce
  n'est pas `GENESIS` qui est un cas particulier, c'est la formule qui est
  uniforme
- au milieu de l'epoque `7` (`108000 / 14400 = 7,5` -> `7`) et a sa derniere
  seconde (`115199 / 14400 = 7`) : la division tient au-dela du premier tour
  de compteur, et l'ecart entre deux basculements ne derive pas

**Proprietes de l'horloge**

- la lecture est monotone : quatre lectures separees par des sauts INEGAUX
  (une demi-epoque, une seconde, trois epoques) ne decroissent jamais.
  `block.timestamp` ne recule pas et `GENESIS` est immuable, donc la division
  entiere par une constante positive preserve l'ordre
- deux lectures dans le MEME bloc rendent la meme valeur : un front peut lire
  `currentEpoch()` plusieurs fois pour composer un affichage sans melanger
  deux mandats
- l'horloge ne s'arrete pas en pause, et c'est DELIBERE (voir la remarque
  dediee plus haut) : sur un pool amorce puis mis en pause, le compteur vaut
  `3` apres trois epoques passees, et la frontiere reste a la meme seconde
  qu'hors pause
- la lecture n'a aucun effet de bord : sur un pool amorce, les quatre valeurs
  mutables du contrat (`reserves`, `feeNum`, `lastSetFeeEpoch`, `totalSupply`)
  sont identiques avant et apres plusieurs appels. `currentEpoch()` est
  `view`, donc l'appel part en `eth_call` et ne coute rien — sans quoi le bot
  d'enchere paierait du gas pour lire l'heure
- le compteur n'est pas stocke : cinq epoques plus tard, `GENESIS` et
  `EPOCH_DURATION` sont inchanges, et ce sont les deux seuls termes de la
  formule qui ne soient pas `block.timestamp`. C'est ce qui rend l'epoque
  recalculable hors chaine sans jamais interroger le contrat, et ce qui
  garantit qu'aucune epoque ne peut etre "sautee" faute d'appelant

### `feeInForce`

**Ce que la couche TypeScript peut dire (`Pool.feeInForce.test.ts`)**

- au deploiement, la vue rend le `_nominalFeeNum` passe au constructeur, sur
  deux pools deployes a `5` et a `20` : la valeur suit l'argument du pool
  interroge, elle n'est pas gravee dans l'ABI ni partagee entre deploiements.
  Assertion faible et assumee comme telle, `NOMINAL_FEE_NUM` etant lui-meme un
  immuable du constructeur : un `return NOMINAL_FEE_NUM` la passerait aussi
- a l'epoch `0`, `feeInForce()` et le getter brut `feeNum()` s'accordent. Les
  deux branches du ternaire coincident a cet instant, donc l'accord ne dit PAS
  quelle branche a ete prise ; ce qu'il fige, c'est qu'un front lisant l'un ou
  l'autre getter pendant la premiere epoch affiche le meme chiffre
- `lastSetFeeEpoch()` est bien expose en public et vaut `0` au deploiement, le
  constructeur ne l'ecrivant pas
- a l'epoch `1` puis au milieu de l'epoch `42`, la vue rend toujours
  `NOMINAL_FEE_NUM`, et le seul bloc mine entre le deploiement et la lecture
  est VIDE : personne n'a paye de `SSTORE` de remise a zero
- la lecture n'a aucun effet de bord : sur un pool amorce puis mis en pause,
  `reserves`, `feeNum`, `lastSetFeeEpoch` et `totalSupply` sont identiques
  avant et apres plusieurs appels separes par un saut de cinq epochs
- la pause ne change pas la valeur rendue. `feeInForce()` ne porte pas
  `whenNotPaused`, et c'est DELIBERE : la pause arrete ce qui deplace de la
  valeur, elle n'a pas a aveugler un front ou un bot qui veut afficher le frais
  pendant l'incident, exactement comme l'horloge continue de defiler en pause

**Ce que seule la couche Solidity peut dire (`Pool.feeInForce.t.sol`)**

- le packing est reel : une ecriture d'UN SEUL mot de 32 octets deplace
  `feeNum` ET `lastSetFeeEpoch` ensemble ; au deploiement le mot brut vaut
  exactement `NOMINAL_FEE_NUM`, ce qui fixe l'ordre des bits (`feeNum` en
  poids faibles, `lastSetFeeEpoch` decale de `16`) et montre que rien d'autre
  ne partage ce slot ; le mot relu par `vm.load` est bit pour bit celui qui a
  ete ecrit
- la branche "mandat courant" rend bien `feeNum` : a l'epoch `3`, slot forge a
  `(feeNum = 21, lastSetFeeEpoch = 3)`, la vue rend `21` et non le nominal `5`.
  C'est LE test du dossier, le seul qu'un `return NOMINAL_FEE_NUM` echoue
- le rollover est gratuit : une `EPOCH_DURATION` plus tard, sans le moindre
  appel — `vm.warp` est un cheatcode, pas une transaction — la vue rebascule
  seule sur le nominal alors que `feeNum` brut vaut toujours `21`,
  `lastSetFeeEpoch` toujours `3`, et que le SLOT ENTIER est identique bit pour
  bit. Zero `SSTORE` : c'est la formulation exacte de la gratuite
- la frontiere se joue a la seconde : a `GENESIS + 4 * EPOCH_DURATION - 1` le
  mandat de l'epoch `3` est encore en vigueur, a
  `GENESIS + 4 * EPOCH_DURATION` il est perime. Borne inclusive cote epoch
  suivante, comme celle de `currentEpoch()`
- fuzz des deux moities : hors de son epoch un mandat ne vaut rien quel que
  soit son contenu (`feeNum` borne par `MAX_FEE_NUM`, epoch forgee bornee par
  `type(uint32).max` et differente de l'epoch courante) ; dans son epoch il
  s'impose, quel que soit son contenu
- bornes du typage : `lastSetFeeEpoch` forge a `type(uint32).max` laisse la vue
  sur le nominal tant que `currentEpoch()` est en dessous, et rend bien le
  `feeNum` du mandat quand `vm.warp` amene `currentEpoch()` exactement sur ce
  plafond. Le cas ou `currentEpoch()` DEPASSE `type(uint32).max` est laisse en
  commentaire dans le fichier plutot qu'en test : il demanderait environ
  `1,96` million d'annees de `block.timestamp`, et il ne changerait rien — la
  comparaison promeut le `uint32` en `uint256`, donc au-dela du plafond
  `lastSetFeeEpoch` ne peut plus jamais egaler `currentEpoch()`, la vue se fige
  sur `NOMINAL_FEE_NUM`, sans repli ni collision d'epochs

### `addLiquidity` — pool vide

- amorcage a montants egaux : `amounts[0] = amounts[1] = amounts[2] = _amount`
  (`Pool.sol:93`), sans lecture d'aucune cible ni d'aucune ancre ;
  `mintedShares = 3 * _amount - MINIMUM_LIQUIDITY` (`Pool.sol:91`)
- depot minimal : `3 * _amount < MINIMUM_LIQUIDITY` sous-flow en panic
  arithmetique (`0x11`), pas une erreur nommee. Le seuil est donc `334` :
  `3 * 333 = 999 < 1000`
- `_amount > type(uint72).max` sur pool vide : AUCUNE garde `ReserveOverflow`.
  La branche d'amorcage (`Pool.sol:90-99`) n'en porte pas, contrairement a la
  branche `supply != 0` (`Pool.sol:109`) et a `swap` (`Pool.sol:144`) ; le
  cast `uint72(amounts[i])` (`Pool.sol:96`) tronquerait silencieusement. Le
  cas n'est pas exploitable, les mocks etant plafonnes a `21 000 000e8` par
  `ERC20Capped`, tres sous `uint72.max` (~`4,7e21`) : sans mint ni approve, le
  premier echec reel est l'allowance manquante au `safeTransferFrom`
  (`Pool.sol:115`), documente comme tel
- `_minShares` strictement superieur aux parts mintees : `BadSlippage`
- `_minShares` exactement egal aux parts mintees : accepte, pas de revert
- ordre des gardes : sur la branche d'amorcage, `BadSlippage` (`Pool.sol:92`)
  est le tout premier controle, avant la moindre ecriture et le moindre
  transfert — un `_minShares` insatisfaisable revert sans qu'aucun `approve`
  ne soit necessaire, ce qui prouve cet ordre
- `_anchorIndex` hors bornes (99) sur un pool vide : aucun revert, le depot
  reussit et mint exactement ce qu'il aurait minte avec `anchor = 0`. Sur la
  branche `supply == 0`, `_anchorIndex` n'apparait dans aucune expression : il
  n'a litteralement rien a heurter

### `addLiquidity` — pool amorce

- deuxieme deposant : parts proportionnelles au premier
- sur un pool fraichement amorce, `mintedShares` est identique pour les trois
  ancres, les trois reserves y etant egales
- approbation insuffisante sur un seul des trois tokens : revert ERC-20
  (`ERC20InsufficientAllowance`)
- `_amount == 0` : `ZeroOutput`. Jusqu'au 2026-08-15 c'etait une transaction
  sans effet (aucune part mintee, aucun transfert) qui emettait quand meme un
  `AddedLiquidity` fantome, et quatre cas limites le documentaient ici. La
  garde `mintedShares > 0` (`Pool.sol:104`) les remplace par un unique revert,
  et le cas a change de section : ce n'est plus une limite toleree, c'est un
  refus. La garde ne vit que dans la branche `supply != 0` ; sur la branche
  d'amorcage `3 * _amount - MINIMUM_LIQUIDITY` ne peut pas valoir zero (il
  sous-flow avant, cf. ci-dessus), un `require` y serait du code mort
- `_anchorIndex` hors bornes sur un pool amorce : panic `0x32`, acces hors
  bornes d'un tableau memoire (a la difference du pool vide, ou le meme index
  n'est simplement jamais lu)
- arrondi au plafond entier (`Math.ceilDiv`, `Pool.sol:108`) : chaque jambe
  non ancree tire au moins la valeur tronquee, et une unite de plus des que le
  reste est non nul. C'est le deposant qui paie l'arrondi, pas le pool
- pool desequilibre par un `swap` prealable : composition preservee et parts
  proportionnelles quel que soit l'anchorIndex ; consequence chiffree du
  choix de l'ancre (le plus rare des trois vs le plus abondant)

### `removeLiquidity`

**Pool vierge**

- `totalSupply() == 0` : `NotBootstrapped`, garde placee avant la division
  par `totalSupply()` — branche inatteignable une fois le pool amorce
  (`MINIMUM_LIQUIDITY` n'est jamais brulee), mais bien reelle sur un contrat
  tout juste deploye

**Reverts**

- `_burnedShares` superieur au solde LP du retirant, ou retirant sans aucune
  part : `ERC20InsufficientBalance` (l'erreur vient de `Pool` lui-meme, qui
  est le token LP)
- `_minOut[i]` strictement superieur au montant sortant, sur chacun des trois
  indices : `BadSlippage`
- ordre des gardes : un retrait a la fois trop grand (`> solde LP`) et trop
  exigeant en `_minOut` echoue par `BadSlippage`, jamais
  `ERC20InsufficientBalance` (la boucle de slippage s'execute avant le
  `_burn`, `Pool.sol:124-129`)
- `_burnedShares` superieur au `totalSupply()` lui-meme (pas seulement au
  solde du retirant) : panic arithmetique (`0x11`), pas
  `ERC20InsufficientBalance` — le decrement des reserves (`Pool.sol:127`)
  sous-flow avant que le `_burn` (`Pool.sol:129`) n'ait la moindre chance de
  s'executer

**Cas limites**

- `_minOut` exactement egal aux montants sortants : accepte, pas de revert
- `_burnedShares == 0` : transaction sans effet (aucun transfert, reserves et
  `totalSupply` inchanges), mais l'evenement est quand meme emis
- arrondi entier toujours en faveur du pool (une part brulee isolement peut
  ne rendre aucun token, la part est quand meme retiree du `totalSupply`)
- retrait total du solde "libre" d'un deposant : laisse un residu non nul
  dans chaque reserve (`334` unites sur chacune des trois sur la fixture
  amorcee, garanti par `MINIMUM_LIQUIDITY`, jamais brulee)
- personne ne peut bruler les parts detenues par l'adresse morte (aucun
  compte ne detient a lui seul `totalSupply()`)
- un porteur ayant recu ses parts par simple `transfer` ERC-20 (sans jamais
  avoir depose) peut retirer : `removeLiquidity` n'a aucun controle d'acces
- deux retraits successifs de la meme quantite de parts rendent exactement
  les memes montants (le rapport `reserves[i] / totalSupply` est invariant
  sous un retrait, la valeur d'une part ne bouge pas)

**Pool desequilibre**

- retrait de 10% du `totalSupply` : rend 10% de chaque reserve, composition
  du pool inchangee
- retrait rend strictement plus de l'actif abondant que de l'actif rare
- montant qui ne divise pas proprement le `totalSupply` : les trois
  `amountsOut` sont tronques independamment, verifie par des valeurs posees
  en dur
- l'evenement `RemovedLiquidity` porte trois montants distincts (la
  verification sur pool equilibre ne peut montrer que trois montants egaux)

**Proprietes de conservation**

- aller-retour addLiquidity puis removeLiquidity : ne rend jamais plus que ce
  qui a ete depose, sur chacun des trois tokens
- un tiers qui fait un aller-retour de swaps laisse des frais dans les
  reserves ; l'unique LP du pool en profite au retrait

### `swap`

**Gardes structurelles**

- pool vierge, `_amount > 0` : `ZeroOutput` (`Pool.sol:142`) — sans cette
  garde, le `transferFrom` entrant s'executait et le swapper payait pour ne
  rien recevoir
- pool vierge, `_amount == 0` : panic `0x12`, le denominateur
  `amountAfterFee + reserves[_indexIn]` (`Pool.sol:140`) vaut `0 + 0` et la
  division precede tous les `require`
- `InsufficientReserve` (`Pool.sol:143`) : inatteignable par l'ABI, documente
  en commentaire et renvoye a la couche Solidity (voir la discussion plus
  haut)

**Reverts**

- `_minOut` strictement superieur a `amountOut` : `BadSlippage`
- `_amount == 0` sur pool amorce : `ZeroOutput` (fin de l'evenement `Swapped`
  fantome, que le front lit comme source de donnees)
- `_amount == 1` avec `feeNum = 5` : `amountAfterFee` tronque a 0, donc
  `ZeroOutput` — avant la garde, l'unite etait encaissee par la reserve
- allowance ou solde insuffisant sur le token d'entree : erreurs ERC-20, levees
  par le token et decodees avec son ABI, pas celle du pool
- `_indexIn` ou `_indexOut` hors bornes : panic `0x32`, sur le tableau MEMOIRE
  `cachedReserves`, avant tout transfert (donc aucun `approve` n'est requis
  pour l'atteindre)
- `reserves[_indexIn] + _amount > type(uint72).max` : `ReserveOverflow`
- ordre des gardes, deux cas : un montant poussiere avec un `_minOut`
  inatteignable echoue par `ZeroOutput`, et un montant qui deborde `uint72`
  avec le meme `_minOut` echoue par `ReserveOverflow` — jamais `BadSlippage`,
  qui est verifie en dernier (`Pool.sol:156`), apres la boucle de bandes
  (`Pool.sol:151-154`).
  C'est l'ordre inverse d'`addLiquidity`, ou le slippage passe en premier
  pour ne pas lancer la boucle de rebalancement pour rien ; dans `swap` il
  n'y a pas de boucle a economiser, l'ordre suit donc l'information rendue a
  l'appelant

**Cas limites**

- `_minOut` exactement egal a `amountOut` : accepte
- `_indexIn == _indexOut` : accepte, deliberement non garde (voir plus haut)
- a entree identique, un pool a `feeNum = 0` rend strictement plus qu'un pool
  a `feeNum = 5`
- une entree tres superieure aux reserves (`2e10` sur des reserves de `1e10`
  chacune) echoue desormais par `CeilingTouched(0)` sur la jambe entrante,
  portee a `69,21 %` de la somme — voir la remarque dediee plus haut sur ce
  changement de nature
- impact de prix : deux swaps identiques successifs, le second rend
  strictement moins que le premier

**Pool desequilibre**

- depuis token0 (le plus abondant apres le swap prealable de la fixture),
  acheter le plus rare des deux autres (token2, `5 925 925 925`) rend
  strictement moins qu'acheter l'intermediaire (token1, `7 407 407 407`), a
  entree identique de `1e10` (montants poses en dur, calcul a la main) ;
  l'evenement `Swapped` porte bien ces montants

**Bandes (plancher `floor = 13`, plafond `ceiling = 53`)**

- un `0 -> 2` de `800e8` pousse la jambe ENTRANTE a `57,94 %`, au-dessus du
  plafond : `CeilingTouched(0)`
- un `1 -> 2` de `800e8` pousse la jambe SORTANTE a `12,71 %`, sous le
  plancher : `FloorTouched(2)`. Les indices `0` et `1` passent leurs deux
  controles avant que la boucle n'atteigne l'indice en defaut
- un `0 -> 2` de `100e8`, nominal, laisse les trois jambes en bande
  (`43,68 %` / `32,35 %` / `23,96 %`) : cas de non-regression, verifie sur les
  reserves resultantes et non sur la seule absence de revert
- un swap qui dilue UNIQUEMENT la jambe non impliquee hors de sa bande, les
  deux jambes actives restant chacune dans la leur : sur un pool amorce a
  egalite et sans frais, deux preparations (`1 -> 0` de `50e8`, `2 -> 0` de
  `47e8`) garent token0 a `13,247 %`, puis un `1 -> 2` de `35e8` le fait
  tomber a `12,97 %` sans qu'un satoshi de sa reserve ne bouge —
  `FloorTouched(0)`

**Proprietes de conservation**

- aller-retour `0 -> 1 -> 0` a `feeNum = 5` : le swapper recupere strictement
  moins qu'il n'a mis ; a `feeNum = 0`, jamais plus (seule la troncature
  entiere joue encore, d'ou un `<=` et non un `<`)
- le produit `reserves[_indexIn] * reserves[_indexOut]` ne diminue jamais
- le solde LP du swapper reste nul : `swap` ne touche jamais au token LP

### `pause` / `unpause`

**Controle d'acces**

- un tiers appelle `pause()` : `OwnableUnauthorizedAccount`
- un tiers appelle `unpause()` : `OwnableUnauthorizedAccount`

**Cablage**

- l'owner appelle `pause()` : `paused()` vaut `true`. Seule assertion qui
  distingue une fonction branchee d'une fonction au corps vide
- l'owner appelle `unpause()` : `paused()` revient a `false`
- NON testes, hors perimetre : repauser une pool deja en pause
  (`EnforcedPause()`), depauser une pool qui ne l'est pas (`ExpectedPause()`),
  et l'emission de `Paused` / `Unpaused`. Trois comportements executes par OZ,
  aucun decide par `Pool.sol`

**Pool en pause**

- `addLiquidity` : `EnforcedPause()`, sur pool vierge comme sur pool amorce
- `swap` : `EnforcedPause()`
- `removeLiquidity` : accepte, verifie sur les montants sortis et sur les
  reserves apres coup, jamais sur la seule absence de revert
- ordre des gardes : un `swap` en pause avec un `_minOut` inatteignable echoue
  par `EnforcedPause()`, jamais `BadSlippage`. Le modifieur s'execute avant le
  corps, et un seul cas suffit a etablir la preemption
- `setFee` reste appelable en pause. Choix delibere : la pause sert a preparer
  la reprise, et le bloquer forcerait a depauser d'abord puis fixer le taux
  ensuite, laissant une fenetre ou la pool rouvre au taux que la crise a rendu
  inadapte. L'appelant n'est plus l'owner mais le gestionnaire du mandat
  courant : le test designe donc un gestionnaire pour l'epoch `1`, se pose sur
  la premiere seconde de ce mandat par `setNextBlockTimestamp` (la fenetre vaut
  douze secondes, un delta relatif deriverait), puis appelle. Contrepartie a
  connaitre : le droit d'ecrire le tarif est consommable une fois par epoch, et
  il l'est aussi pendant la pause

**Retour a l'etat normal**

- apres `unpause()`, `addLiquidity` et `swap` repassent et rendent les memes
  montants qu'avant la pause : la pause ne laisse aucune trace dans l'etat

### `manager()` / `setAuction` / `setManager`

**Lecture du mandat courant (`manager`)**

- epoch 0, personne nomme : `manager()` rend `0x0`
- epoch 0, `managerOf[0]` et `manager()` coincident (les deux lectures passent
  par le meme slot, et la portion "managerOf[0] sette" de l'enonce n'est pas
  atteignable par `setManager` du fait de la garde `_epoch > currentEpoch()`)
- epoch 1, `managerOf[1]` vide : `manager()` rend `0x0` (un mandat pour
  l'epoch 0 ne survit pas au basculement a l'epoch 1, par construction de
  `managerOf[currentEpoch()]`)
- epoch 7, `managerOf[7]` sette : `manager()` rend cette adresse

**`setAuction`**

- un tiers appelle `setAuction` : `OwnableUnauthorizedAccount`
- l'owner appelle `setAuction(X)` sur un pool frais : succes, `auction()` rend `X`
- l'owner appelle `setAuction(Y)` apres un premier set : `AuctionAlreadySet`,
  quelle que soit `Y` (y compris l'adresse nulle, qui aurait sinon pour effet
  de bord de reouvrir la voie bootstrap)
- l'owner appelle `setAuction(0x0)` sur un pool frais : no-op silencieux,
  `auction()` reste a `0x0`. C'est la voie bootstrap, deliberee

**`setManager` — appelant**

- `auction` non-nulle, `msg.sender == auction` : succes
- `auction` non-nulle, `msg.sender` autre : `NotAuctionOrOwner`
- `auction` nulle, `msg.sender == owner` : succes (voie bootstrap)
- `auction` nulle, `msg.sender` autre : `NotAuctionOrOwner`
- `auction == msg.sender == owner` (owner s'auto-set comme auction) :
  succes sur la branche `msg.sender == auction`, la voie bootstrap n'etant
  plus empruntable

**`setManager` — gardes de fond**

- `_who == 0x0` : `ZeroManager`, garde posee avant celle sur `_epoch`
- `_epoch == 0` au deploiement (`currentEpoch() == 0`) :
  `EpochAlreadyStarted`, strict
- `_epoch == 0` apres warp en epoch 1 : `EpochAlreadyStarted`, epoque passee
- `_epoch == 1` au deploiement : succes, frontiere inclusive cote futur
- `setManager(1, X)` puis `setManager(1, Y)` : la seconde reverte
  `ManagerAlreadySet`, la premiere nomination tient
- `setManager(1, X)` puis `setManager(2, Y)` : les deux reussissent, epoques
  distinctes

**Evenement `ManagerSet`**

- succes de `setManager` : exactement un `ManagerSet(epoch, who)` emis, les
  deux args indexes
- revert de `setManager` : aucun `ManagerSet` emis, `managerOf[epoch]` reste
  a sa valeur d'avant l'appel

### `setFee`

**Chemin nominal (`Pool.setFee.test.ts`)**

- le gestionnaire de l'epoch `1`, nomme par l'owner, appelle a l'offset `0` de
  son mandat : `feeNum` prend la valeur, `lastSetFeeEpoch` prend `1`, et
  `feeInForce()` rend la nouvelle base. Trois lectures distinctes du meme
  effet, et aucune ne remplace les deux autres — un `setFee` qui ecrirait
  `feeNum` sans estampiller `lastSetFeeEpoch` passerait la premiere et
  rendrait le tarif invisible pour `feeInForce()`
- `FeeSet(epoch, manager, oldFee, newFee)` : les deux premiers arguments
  indexes, verifies avec leurs quatre valeurs

**Le troisieme argument de `FeeSet` est le champ BRUT, pas le frais en vigueur**

- au second mandat, le pool facture `NOMINAL_FEE_NUM` — le tarif de l'epoch
  precedente est perime — mais `feeNum` brut porte encore `20`, aucune
  ecriture ne l'ayant remis a zero au passage d'epoch. `FeeSet` emet ce champ
  brut (`Pool.sol:172`) : son `oldFee` vaut donc `20` alors que le protocole
  facturait `5` a la seconde precedente. Un indexeur qui reconstruirait
  l'historique des frais a partir de cet argument se tromperait. La suite fige
  le comportement REEL, l'ecart est signale, pas corrige

**Les quatre gardes, une par une**

- `NotManager` : l'owner du pool, un tiers quelconque, et le gestionnaire d'un
  AUTRE mandat (nomme pour l'epoch `2`, appelant pendant l'epoch `1`) sont
  tous refuses. Le troisieme cas est celui qui distingue "gestionnaire" de
  "gestionnaire DU MANDAT COURANT" : la garde compare a `manager()`,
  c'est-a-dire `managerOf[currentEpoch()]`, pas a "figure quelque part dans le
  mapping". `setFee` n'est PLUS un pouvoir de l'owner
- `OutsidePriorityWindow` : la frontiere est epinglee a la seconde. A l'offset
  `PRIORITY_WINDOW - 1` (soit `11`) l'appel passe et pose le tarif, a l'offset
  `PRIORITY_WINDOW` (soit `12`) il reverte. Borne exclusive, douze secondes
  ouvertes de l'offset `0` a l'offset `11`. Le cas grossier — le milieu de
  l'epoch — est teste aussi
- `FeeAlreadySetThisEpoch` : deux appels dans la meme fenetre, offsets `0` et
  `1` poses explicitement, le second reverte et le premier tarif tient. Le
  droit est CONSOMMABLE, pas corrigeable. Contrepartie : le MEME gestionnaire,
  reelu pour l'epoch `2`, rappelle `setFee` dans la fenetre de ce nouveau
  mandat — la garde borne le droit a un mandat, pas a une adresse
- `FeeOutOfBand` : `MIN_FEE_NUM - 1` (soit `0`) et
  `MAX_FEE_NUM / UNBALANCE_FACTOR + 1` (soit `26`) revertent avec les DEUX
  arguments de l'erreur verifies ; les bornes `1` et `25` passent, inclusives
  des deux cotes
- `MAX_FEE_NUM` lui-meme (soit `50`) reverte. C'est le point de soutenance de
  la section : deux plafonds coexistent et ne disent pas la meme chose.
  `MAX_FEE_NUM` borne ce qu'un PRENEUR peut payer et sert au constructeur a
  valider `_nominalFeeNum` et `_minFeeNum` ; `MAX_FEE_NUM / UNBALANCE_FACTOR`
  borne ce qu'un GESTIONNAIRE peut ecrire. Un `setFee` qui aurait borne sur le
  premier passerait tous les autres tests du fichier

**L'ordre des gardes est celui qui est ecrit**

- l'owner appelle HORS fenetre : `NotManager`, et non `OutsidePriorityWindow`.
  Le cas de soutenance : c'est parce que la garde d'acces est evaluee en
  PREMIER que la garde d'unicite est correcte au mandat `0`, ou
  `lastSetFeeEpoch` et `currentEpoch()` valent tous deux `0` et ou la
  comparaison serait donc fausse d'emblee
- le gestionnaire rappelle `setFee` hors fenetre apres avoir deja tarife :
  `OutsidePriorityWindow`, et non `FeeAlreadySetThisEpoch`
- le gestionnaire rappelle `setFee` DANS la fenetre avec une valeur hors
  bande : `FeeAlreadySetThisEpoch`, et non `FeeOutOfBand`

**Le mandat `0` n'a pas de tarif, et ne peut pas en avoir**

- consequence STRUCTURELLE de `setManager`, pas d'une garde de `setFee` : la
  nomination exige `_epoch > currentEpoch()` (`Pool.sol:129`), un strict, et
  `currentEpoch()` vaut deja `0` au bloc de deploiement. La chaine est etablie
  par les faits, maillon par maillon : `setManager(0, X)` reverte
  `EpochAlreadyStarted`, `manager()` rend `0x0` pendant l'epoch `0`, et
  `setFee` y reverte `NotManager` depuis l'owner comme depuis un tiers
- le pool traverse donc sa premiere epoch au tarif nominal du constructeur, et
  c'est irrattrapable par conception. A cet instant la fenetre est GRANDE
  OUVERTE et la garde d'unicite est fausse : seule la garde d'acces ferme le
  passage

**Un tarif ne se reporte jamais au mandat suivant (regle `E1`)**

- un gestionnaire tarife l'epoch `1` a `20` ; a l'epoch `2`, atteinte par un
  bloc VIDE, `feeInForce()` rend `NOMINAL_FEE_NUM` alors que `feeNum` brut
  vaut toujours `20`. Les deux faces sont testees separement : c'est leur
  conjonction qui decrit le reset paresseux — la vue retombe, le champ brut
  reste, et personne ne paie de `SSTORE`
- la reelection n'y change rien : le meme compte, gestionnaire des epochs `1`
  et `2`, trouve le pool au nominal au debut de son second mandat tant qu'il
  n'a pas rappele `setFee`. Gagner deux mandats d'affilee n'evite pas d'envoyer
  deux transactions

**Pause**

- `setFee` reste appelable sur un pool en pause : pas de `whenNotPaused`,
  delibere (`Pool.sol:150-151`). Un seul `it` ici, qui verifie que la garde n'a
  pas ete ajoutee depuis ; la promesse elle-meme, avec son argument complet,
  est portee par `Pool.pause.test.ts` II.D et n'est pas dupliquee

**Ce que seule la couche Solidity peut dire (`Pool.setFee.t.sol`)**

- toute valeur de la bande `[MIN_FEE_NUM, MAX_FEE_NUM / UNBALANCE_FACTOR]` est
  ecrite telle quelle ET estampille l'epoch courante
- toute valeur strictement au-dessus du plafond du gestionnaire reverte
  `FeeOutOfBand`, jusqu'a `type(uint256).max`, et ne laisse aucune trace dans
  `feeNum`. Sous `MIN_FEE_NUM` le domaine ne contient qu'UNE valeur, `0`, donc
  ce cas est ecrit SANS fuzz : un `bound(x, 0, MIN_FEE_NUM - 1)` y serait un
  fuzz de facade, et il produirait un intervalle VIDE sur une fixture ou
  `MIN_FEE_NUM` vaudrait `0`
- toute adresse autre que le gestionnaire du mandat courant reverte
  `NotManager`, l'owner et le contrat de test inclus ; et toute adresse tiree
  qui recoit un vrai mandat pour l'epoch SUIVANTE est refusee pendant celle-ci
- la fenetre laisse passer si et SEULEMENT si l'offset est strictement sous
  `PRIORITY_WINDOW`, exprime comme une equivalence sur `[0, 2 * PRIORITY_WINDOW]`
  — domaine etroit et delibere, voir la section du fichier plus bas — puis
  balaye unilateralement sur tout le reste de l'epoch
- la fenetre se mesure depuis le debut de l'EPOCH, pas depuis `GENESIS` : a
  n'importe quelle epoch tiree entre `1` et `1000`, l'offset
  `PRIORITY_WINDOW - 1` passe. Une garde ecrite sans modulo n'ouvrirait la
  fenetre qu'une fois dans la vie du contrat
- le mecanisme ne tient a aucune epoch particuliere : a une epoch quelconque,
  un tarif de la bande different du nominal s'impose pendant son mandat,
  disparait de `feeInForce()` a l'epoch suivante, et survit dans `feeNum` brut

## Etape I.2 — sortie des frais hors des reserves

L'etape I.2 du worklist (journal de nuit 2026-08-27) introduit trois
constantes (`UNBALANCE_TOL_BPS`, `PROTOCOL_FEE_BPS`, `SPLIT_DEN`), deux
registres (`feesOwed[manager]`, `protocolFeesOwed`), deux vues
(`effectiveFeeNum`, `get_dy`) et deux fonctions de tirage
(`claimManagerFees`, `claimProtocolFees`). La migration a une
consequence observable sur trois tests existants, qui ont ete mis a
jour avec des commentaires "I.2 — decision X — voir journal de nuit
2026-08-27" :

- `Pool.swap.test.ts` : trois tests corriges. Le delta de
  `reserves[0]` apres un swap n'est plus `_amount` mais
  `_amount - protocolCut - managerCut` ; la difference entre le delta
  de solde ERC-20 du pool et le delta de reserve sur le token
  d'entree vaut exactement `protocolCut + managerCut` ; et le swap
  `i == j` preleve desormais un frais (la defense orale devient "le
  swap i==j est un appel legitime qui paie le frais comme tout
  autre swap, et le manager n'en profite pas plus qu'il ne profite
  des autres"). Le reste du fichier est inchange.
- `Pool.safeERC20.t.sol` : un test corrige (`test_Swap_IndexInTransferFromReturningNothing_Succeeds`).
  L'`expectedOut` utilise `effectiveFeeNum` et non `feeNum`, et
  `reserves[0]` recoit `_amount - protocolCut - managerCut`.
- `Pool.swap.t.sol` : `expectedAmountOut` utilise `effectiveFeeNum` au
  lieu de `feeNum`, et la formule d'`amountAfterFee` reproduit
  exactement celle du contrat (`amount - amount * effective / FEE_DEN`,
  pas `amount * (FEE_DEN - feeNum) / FEE_DEN`). Le fix aligne la
  troncature du test sur celle du contrat, et elimine un off-by-one
  au pire d'une unite sur les tres petits montants.
- `Pool.invariant.t.sol` : `expectedSwapAmountOut` aligne de la meme
  maniere, pour que le handler du fuzzer ne desaccorde pas avec
  `swap()` apres la migration I.2.

Les deux nouveaux fichiers, qui couvrent ce qu'aucun des precedents
ne pouvait dire, sont :

```
test/Pool.feeSplit.test.ts   surface I.2 cote TypeScript
test/Pool.feeSplit.t.sol     surface I.2 cote Solidity (bornes + invariant I1)
```

`Pool.feeSplit.test.ts` couvre `effectiveFeeNum` (six paires in
band, six paires skew, et la frontiere stricte `>` a 2.00 %),
`get_dy` (coherence simule / execute sur pool equilibre, vue pure),
et le partage du frais (registres avec et sans gestionnaire,
surcharge, et les deux fonctions de tirage avec leurs messages
d'erreur `ZeroFeesOwed`). `Pool.feeSplit.t.sol` porte les bornes
croisees-multipliees (5.2.4 et 10d de la fiche), l'invariant I1
(`balanceOf(pool, token) >= reserves[token] + protocolFeesOwed[token]
+ sum(feesOwed[m][token])` sur plusieurs sequences), et la
conservation stricte I2. Les sections II et IV sur la migration
`FEE_DEN` sont documentees en FIXME et marquees `vm.skip(true)` :
`FEE_DEN` est une constante, et le perimetre I.2 n'inclut pas sa
parameterisation.

## Couche Solidity : fuzz, invariants, forge d'etat

Les fichiers ci-dessous portent ce que la couche TypeScript ne peut pas
atteindre : un domaine d'entrees, un enchainement d'appels, une valeur de
retour ERC-20 non conforme, ou un etat qu'aucune sequence legitime ne produit —
des reserves impossibles, ou un mandat de frais que rien n'ecrit encore.

### `Pool.swap.t.sol` : un domaine fuzze partage, pas filtre

La fixture amorce a `1000e8` par jambe. La boucle de bandes plafonne alors le
montant echangeable bien en dessous de la plage historique de cette suite
(`20 000 000e8`) : le dernier montant accepte vaut exactement
`76 716 541 675`, soit environ `767,17` BTC. Les trois reserves etant egales,
ce seuil est le meme pour les six paires `(indexIn, indexOut)`.

Ce domaine est PARTAGE explicitement plutot que filtre par `vm.assume`. Sur
`[1000, 20 000 000e8]`, `0,0038 %` seulement des tirages restent en bande : un
`vm.assume` y rejetterait `99,996 %` des cas et viderait le fuzz de sa
substance tout en le laissant vert. Il aurait de surcroit fallu reimplementer
la formule du contrat dans le filtre, donc partager ses erreurs avec l'oracle
qu'il sert. Les deux moities du domaine sont couvertes : les trois tests
nominaux sous le seuil, `test_FuzzSwapAboveBandsRevertsWithBandError` au-dessus
(qui n'exige pas un indice precis, la jambe fautive changeant avec le montant,
mais exige une erreur de BANDE, jamais `ZeroOutput`, `InsufficientReserve`,
`ReserveOverflow` ou un panic). `test_MaxInBandAmountIsExactlyTheBoundary`
epingle la frontiere au satoshi pres : `MAX_IN_BAND_AMOUNT + 1` doit revert
par `CeilingTouched(0)`, `MAX_IN_BAND_AMOUNT` doit passer.

### `Pool.safeERC20.t.sol` : la promesse de `SafeERC20`, sur quatre sites

`Pool.sol` declare `using SafeERC20 for IERC20` (`Pool.sol:7`) et l'exerce sur
quatre sites d'appel : un `safeTransferFrom` dans la boucle d'`addLiquidity`
(`Pool.sol:115`), un `safeTransfer` dans celle de `removeLiquidity`
(`Pool.sol:131`), puis un de chaque dans `swap` (`Pool.sol:161-162`).

Ce que `SafeERC20` promet n'est pas "tout jeton bizarre revert", c'est une
DISTINCTION : un jeton dont l'appel reussit mais renvoie explicitement `false`
doit faire revert (`SafeERC20FailedOperation`), tandis qu'un jeton dont
l'appel reussit sans renvoyer aucune donnee — le cas USDT sur mainnet — doit
etre accepte comme un succes. Tester la moitie "revert" seule prouverait
seulement qu'un jeton fautif derange ; c'est la seconde moitie qui montre
pourquoi la bibliotheque existe.

`contracts/MockMisbehavingBTC.sol` est ecrit pour ca. Il n'implemente
volontairement PAS `IERC20` au sens Solidity, ce qui lui permet de choisir a
la ligne ce que `transfer` et `transferFrom` renvoient : `Normal` (`true`,
conforme), `False` (le transfert a lieu, la fonction ment et signale un
echec), `Nothing` (le transfert a lieu, la fonction ne renvoie rien, via un
`return(0, 0)` en assembleur qui court-circuite l'encodage ABI). Deux modes
independants, un par fonction, reglables en cours de test.

Les huit tests croisent les quatre sites avec les deux comportements. Le mock
joue token0 et les deux autres jambes restent des `MockWrappedBTC` ordinaires,
pour isoler le comportement sur un seul site a la fois. Cote `False`, les
quatre revertent avec `SafeERC20FailedOperation(address(misbehaving))`. Cote
`Nothing`, les quatre reussissent et rendent exactement ce qu'un jeton
conforme aurait rendu : `3 * SEED - MINIMUM_LIQUIDITY` parts a l'amorcage, le
montant proportionnel au retrait, l'`amountOut` de la formule au swap.

Un detail d'ecriture, note dans le fichier parce qu'il pique : `vm.expectRevert`
porte sur le tout PROCHAIN appel externe. Lire `pool.balanceOf(...)` comme
argument de `removeLiquidity` APRES avoir arme l'attente ferait de CETTE
lecture l'appel attendu en echec, alors qu'elle reussit toujours. Le solde est
donc lu avant l'armement.

### `Pool.forgedState.t.sol` : ce que seul `vm.store` atteint

Trois proprietes qu'aucune sequence d'appels legitime ne peut produire, donc
observables seulement en forgeant le slot des reserves. Le slot n'est jamais
code en dur : il est resolu a l'execution en amorcant le pool, en recomposant
le mot attendu (`uint72[3]` tient dans un seul slot, `reserves[0]` en poids
faibles, `reserves[1]` decale de 72 bits, `reserves[2]` de 144) puis en
balayant les vingt premiers slots. Un deplacement de layout chez OZ echoue
donc proprement, au lieu d'ecrire silencieusement au mauvais endroit.

- **`Math.ceilDiv` livre au moins une unite a la jambe poussiere.** Reserves
  forgees a `[1 000 000e8, 1, 1 000 000e8]`, depot de `1e8` ancre sur token0.
  `amounts[1] = ceilDiv(1e8 * 1, 1e14)` vaut `1`, la ou une troncature aurait
  donne `0` : la jambe n'aurait rien recu alors que `mintedShares` restait
  strictement positif (`300 000`, verifie par le test), c'est-a-dire des parts
  frappees contre rien depose sur cette jambe. C'est la raison d'etre du
  `ceilDiv` de `Pool.sol:108`, et l'etat qui l'exhibe est inatteignable en
  nominal : l'amorcage est egal, et les bandes interdisent a tout swap de
  descendre une jambe sous `13 %` de la somme, ce qui, sur un pool de taille
  reelle, reste tres au-dessus d'un satoshi.
- **Un pool deja hors bande refuse le swap, et la boucle designe la bonne
  jambe.** Reserves forgees a `[1000e8, 50e8, 1000e8]` : token1 est a `2,44 %`,
  tres sous son plancher, les deux autres a `48,78 %` chacune. Un `0 -> 2`
  modeste, ou token1 n'est ni l'entree ni la sortie et ne bouge donc pas d'un
  satoshi, revert quand meme par `FloorTouched(1)` — jamais `CeilingTouched(0)`,
  l'indice `0` passant ses deux controles, ni un defaut sur l'indice `2`,
  jamais atteint.
- **`addLiquidity` et `removeLiquidity` ne voient pas les bandes.** Sur le
  meme etat force, les deux restent appelables : la boucle vit uniquement dans
  `swap` (`Pool.sol:151-154`). Etant proportionnels, ils ne corrigent pas le
  ratio hors bande, mais ils ne le signalent pas non plus. C'est exactement le
  piege que `invariant_bandsAlwaysRespected` doit pouvoir reveler.

### `Pool.feeInForce.t.sol` : la preuve que la couche TypeScript ne peut pas donner

Meme technique que `Pool.forgedState.t.sol`, meme raison de fond — un etat reel
du contrat qu'aucune sequence d'appels legitime ne produit — mais un slot
different et un balayage RETOURNE.

`Pool.forgedState.t.sol` recompose depuis les getters le mot qu'il cherche,
puis balaye les vingt premiers slots a la recherche de cette valeur. Ici ce
serait sans effet : au deploiement, le mot cherche vaut `5`, un entier qu'un
autre slot peut porter par hasard. Le balayage ECRIT donc un mot distinctif
(`feeNum = 37`, hors bande legitime, et `lastSetFeeEpoch = 123 456`) dans
chaque slot candidat, regarde si les DEUX getters basculent ensemble, puis
restaure le slot avant de passer au suivant. Ce balayage est deja, en lui-meme,
la preuve du packing : si le compilateur separait un jour les deux champs,
aucune ecriture d'un slot unique ne pourrait plus les deplacer tous les deux, et
la recherche sortirait en `revert` au lieu de laisser la regression passer en
silence. Le commentaire de `Pool.sol:23-28` n'est jamais pris pour argent
comptant : c'est lui que ce fichier verifie.

Pourquoi pas le `setFee` `onlyOwner` pour deplacer `feeNum`, ce qui aurait
evite tout `vm.store` : parce qu'il etait condamne, avec `lastFeeUpdate` et
`MIN_SET_FEE_DELAY`. Un test bati dessus serait mort avec lui, ce qui est
arrive depuis ; ce fichier, lui, a survecu sans une ligne a changer. `vm.store`
ne depend d'aucun organe condamne, et cette independance vaut aussi pour le
`setFee` gestionnaire.

Le detail des six sections du fichier est dans la liste des cas limites
ci-dessus, sous `feeInForce`.

### `Pool.setFee.t.sol` : cinq axes, et un domaine qu'on ne fuzze pas au hasard

`setFee` a trois parametres implicites — QUI appelle, QUAND il appelle, AVEC
QUOI — et le fichier consacre un contrat a chacun, plus un contrat a la bande
hors norme et un a l'independance vis-a-vis de l'epoch. Rien d'exotique dans la
technique : `PoolTestBase`, `vm.warp`, `vm.prank`, `bound`. Ce qui merite un mot
est le choix des DOMAINES, parce que deux pieges y guettent et qu'ils
produisent tous les deux un test vert qui n'eprouve rien.

Le premier est le domaine VIDE. Sous `MIN_FEE_NUM`, il n'existe qu'une seule
valeur sur cette fixture, `0`, et il n'en existerait aucune si `MIN_FEE_NUM`
valait `0` : `bound(x, 0, MIN_FEE_NUM - 1)` sortirait alors en sous-flow, ou
pire, retournerait toujours la meme valeur en se faisant passer pour un
balayage. Ce cas est donc ecrit en dur, avec un `require` de mise en place qui
fait echouer franchement le jour ou la fixture changerait de `MIN_FEE_NUM`.

Le second est le domaine DESEQUILIBRE, et il est plus insidieux. Fuzzer
l'offset dans l'epoch sur `[0, EPOCH_DURATION - 1]` pour exprimer "l'appel
passe si et seulement si l'offset est sous `PRIORITY_WINDOW`" donnerait douze
tirages favorables sur quatorze mille : la branche "l'appel passe" ne serait
presque jamais executee, et le test dirait "ca reverte partout" en se croyant
une equivalence. Un fuzz dont une branche n'est atteinte qu'avec une
probabilite negligeable ne vaut pas mieux qu'un fuzz au domaine vide.
L'equivalence est donc posee sur `[0, 2 * PRIORITY_WINDOW]`, ou les deux
branches sont echantillonnees a peu pres egalement et ou chaque tirage voisin
de `11` ou `12` eprouve reellement le `<` de `Pool.sol:154` ; le reste de
l'epoch est balaye separement, par un test unilateral qui n'a rien a prouver
sur la frontiere.

Un troisieme piege, purement mecanique celui-la, a coute un echec pendant
l'ecriture : `vm.expectRevert` porte sur le PROCHAIN appel, et
`pool.setFee(pool.MAX_FEE_NUM())` le fait porter sur le staticcall du getter,
qui ne reverte pas. Le getter est donc lu dans une variable AVANT d'armer le
cheatcode. Meme discipline que `Pool.safeERC20.t.sol`, qui lit `burnedShares`
avant d'armer.

Le detail des cinq sections est dans la liste des cas limites ci-dessus, sous
`setFee`.

### `Pool.depeg.t.sol` : ce que les bandes valent face a une decote reelle

Le morceau le plus argumentatif de la suite, et le seul qui reponde a la
question qu'un jury posera : `13` et `53`, pourquoi ces nombres, et que
laissent-ils passer.

Le modele tient en une ligne. Les trois jetons visent la parite avec le BTC et
le pool les cote a cibles egales. Si l'un decote de `d` sur le marche
exterieur, le pool cote encore l'ancienne parite : il est arbitrable.
L'arbitragiste y deverse le jeton decote et retire les deux autres jusqu'a ce
que le prix marginal du pool rejoigne celui du marche. Sur une courbe a
produit constant, le prix marginal de la paire `(i, j)` vaut `r_i / r_j` :
l'equilibre est atteint quand `r_decote / r_autre = 1 / (1 - d)`, donc quand
les trois reserves sont dans le rapport `1/(1-d) : 1 : 1`.

Le pool arbitre n'est donc pas un etat qu'on tirerait au hasard, c'est une
FONCTION de la seule decote. Chaque test forge exactement cet etat pour une
decote donnee, puis mesure si le pool y reste echangeable. Ce que le modele
donne, chiffres verifies par les tests :

```
decote        jambe decotee   les deux autres
-------------------------------------------------
0 bps            33,33 %         33,33 %
1000 bps         35,71 %         32,14 %
5000 bps         50,00 %         25,00 %
5566 bps         52,9998 %       23,5001 %   <- derniere decote en bande
5567 bps         53,0054 %       23,4972 %   <- premiere hors bande
8000 bps         71,43 %         14,29 %
```

Deux lectures a en tirer. La premiere : une decote de `10 %` sur un wrapper de
BTC est deja un evenement de marche considerable, et le pool arbitre s'y
installe a `35,71 %`, soit dix-sept points de marge sous le plafond. Les
bandes ne genent jamais l'arbitrage nominal. La seconde : c'est TOUJOURS le
plafond de la jambe decotee qui mord en premier, jamais le plancher des deux
autres. Le plancher ne serait atteint qu'a `1/(x+2) = 13 %`, soit
`x = 5,6923`, soit une decote de `8243` bps — bien au-dela du point ou le
plafond a deja ferme le pool.

Il n'existe aucun getter qui dise "ce pool est en bande" : la boucle ne juge
que l'etat d'arrivee d'un `swap`. L'observable est donc l'acceptation d'un
echange de SONDE, `0,01 %` d'une reserve, assez grand pour que `amountOut > 0`,
assez petit pour ne pas deplacer les ratios (les frais de la sonde pesent
`5e-7` de la somme). La sonde nominale va d'une jambe saine vers l'autre, de
sorte que la jambe decotee ne bouge pas en valeur absolue et ne peut pas, a
elle seule, faire basculer le verdict qu'elle mesure.

Cinq tests :

- **`test_FuzzNormalArbitrageKeepsPoolSwappable`** — jusqu'a `1000` bps, la
  sonde passe, et son `amountOut` est celui de la formule du contrat.
- **`test_FuzzRealDepegBelowFrontierKeepsPoolSwappable`** — meme propriete
  poussee a `5500` bps, un wrapper qui aurait perdu plus de la moitie de sa
  valeur. Le pool y est deforme (`52,63` / `23,68` / `23,68`) et toujours
  ouvert.
- **`test_FuzzDepegBeyondFrontierRejectsProbeWithCeilingError`** — de `5600` a
  `8000` bps, la sonde est refusee, et le test exige le selecteur `CeilingTouched`
  ET son argument d'index, ce qui exclut un refus pour une raison etrangere
  aux bandes.
- **`test_FuzzDepegBeyondFrontierRejectsEvenTheRepairingSwap`** — le piege,
  rendu executable. La sonde part cette fois d'une jambe saine VERS la jambe
  decotee : c'est le sens de l'arbitrage CORRECTEUR, celui qui ferait
  redescendre la jambe sous son plafond. Il est refuse comme les autres,
  parce que la garde ne juge que l'etat d'arrivee et ne s'interesse jamais au
  fait que cet etat soit MEILLEUR que le precedent. Un pool sorti de bande
  cesse d'echanger, y compris sur l'echange qui le reparerait ; sa seule porte
  de sortie est un depot ou un retrait, qui ne portent pas la boucle mais qui,
  etant proportionnels, ne corrigent pas le ratio non plus.
- **`test_BandFrontierSitsExactlyBetween5566And5567Bps`** — le seul test non
  fuzze du fichier, et son role est d'etre fragile. La frontiere se resout a
  la main : la jambe decotee vaut `x = 1/(1-d)` quand les deux autres valent
  `1`, son ratio vaut `x / (x + 2)`, l'egaler au plafond donne
  `x = 106/47 = 2,25532`, soit `depegBps = 5566,04`. La derniere decote
  ENTIERE en bande est donc `5566` (ratio `52,9998 %`, l'inegalite stricte de
  `Pool.sol:152` tient encore) et la premiere hors bande `5567` (ratio
  `53,0054 %`). Ce nombre est une fonction des bandes, des frais et du modele
  d'arbitrage : si l'un des trois change, ce test doit tomber. Ses trois
  assertions d'ouverture (`ceiling == 53`, `floor == 13`, `feeNum == 5`)
  nomment ce qui a bouge, pour que l'echec dise quoi recalculer au lieu de
  laisser un nombre magique orphelin.

L'intervalle `]5500, 5600[` est laisse de cote volontairement : tout pres de
la frontiere, la sonde elle-meme peut faire basculer le ratio, et un fuzz qui
traverserait la frontiere y deviendrait ambigu. Le trou est couvert par le
test de frontiere ci-dessus, qui epingle les deux valeurs entieres qui
l'encadrent.

Deux precautions de fixture, sans lesquelles ces tests prouveraient autre
chose que ce qu'ils annoncent. Le forgeage remet les soldes ERC-20 du pool a
niveau : sans ca, le transfert de sortie du swap echouerait faute de jetons,
pour une raison sans rapport avec les bandes. Et le complement est transfere
depuis le contrat de test plutot que minte, `MockWrappedBTC` etant plafonne a
`21 000 000e8` par `ERC20Capped`, cap deja entierement frappe par
`PoolTestBase`.

### `Pool.invariant.t.sol` : le handler et ses quatre invariants

Un `PoolHandler` expose quatre entrees au fuzzer (`addLiquidityWrapper`,
`swapWrapper`, `removeLiquidityWrapper`, `addThenRemoveRoundTrip`), chacune
bornant ses arguments et verifiant au passage que reserves et soldes ERC-20
bougent du meme montant. Deux proprietes sont affirmees dans les wrappers
plutot que par un `invariant_`, parce qu'elles portent sur un DELTA autour
d'un appel precis, que le runner ne voit jamais :

- **`k` ne decroit jamais sur un swap.** Mesure par paire, `k = reserves[in] *
  reserves[out]`, snapshot avant l'appel, recalcule apres, assertion dans
  `swapWrapper`. La forme par appel est plus stricte qu'un invariant Foundry
  (qui ne verifie qu'apres chaque sequence) : elle attrape toute baisse
  individuelle de `k`, pas seulement la baisse nette en fin de run. Egalite
  possible quand `amountAfterFee` troncature a zero, mais `ZeroOutput` l'a
  deja rejete a ce stade.
- **`mintedShares > 0` sur tout `addLiquidity` reussi.** Assertion sur la
  valeur de retour dans `addLiquidityWrapper`. La garde `ZeroOutput` dans la
  branche `supply != 0` de `Pool.addLiquidity` rend la condition inatteignable
  par l'ABI ; le fuzzer Foundry, en enchainant swaps et depots, doit
  confirmer qu'aucune sequence n'atteint le `_mint` avec un nombre nul. Les
  sequences qui font varier `reserves[_anchorIndex]` par rapport a
  `totalSupply()` sont l'outil naturel, pas un scenario ecrit a la main.
Le `swapWrapper` merite une precision, parce qu'un try/catch dans un test est
d'ordinaire un aveu. Le fuzzer choisit `amount` sans connaitre les bandes :
une bonne part des tirages pousserait legitimement une jambe hors bande, et
sans filet un seul de ces swaps ferait echouer tout le run, invariants
compris. Le `catch` n'avale donc QUE `FloorTouched` et `CeilingTouched`, les
deux seuls reverts attendus de cette garde ; tout autre revert est re-emis tel
quel, en assembleur et sans reencodage, pour ne jamais transformer ce wrapper
en test vide qui masquerait un vrai bug.

Quatre invariants sont exposes au runner :

- **`invariant_reservesNeverExceedBalances`** — le solde ERC-20 du pool couvre
  toujours sa reserve, sur les trois jambes.
- **`invariant_shareValueNeverDecreases`** — la valeur unitaire des parts ne
  baisse jamais. Plus fort que l'invariant `k` pour un pool a produit
  constant : frais et skew cumulatif font toujours monter la valeur unitaire,
  donc la baisse de `k` qu'on cherche a empecher est elle-meme empechee par la
  monotonie de la valeur de part. Les deux sont gardes pour la clarte, pas
  pour la redondance.
- **`invariant_addLiquidityDeliversAllThreeLegs`** — pour tout `addLiquidity`
  reussi observe pendant le run, chaque reserve a grossi d'au moins une unite.
  C'est `Math.ceilDiv` (`Pool.sol:108`) mis sous fuzz : jamais une troncature
  qui livrerait `0` a une jambe tout en frappant des parts. Comme la propriete
  porte sur un delta, c'est le handler qui la constate et abaisse un drapeau ;
  l'invariant ne fait que l'exposer.
- **`invariant_bandsAlwaysRespected`** — pour chaque indice, la reserve reste
  strictement entre `floor %` et `ceiling %` de la somme des trois, en ratios
  et non en valeurs absolues, exactement comme `Pool.sol:151-154`.

Ce dernier demande un mot, parce qu'il n'est PAS affirme partout. Il l'est
au-dessus de `MIN_ECONOMIC_RESERVE = 1e8`, une unite de BTC par jambe, seuil
qui borne `addLiquidityWrapper`, `removeLiquidityWrapper` et
`addThenRemoveRoundTrip`. La raison n'est pas une faiblesse du contrat : sur
un pool de poussiere, l'unite indivisible du satoshi pese autant que la
reserve elle-meme, si bien que ce sont les troncatures entieres qui fixent les
ratios et non la courbe. Et rien ne garde ces troncatures : `addLiquidity` et
`removeLiquidity` sont proportionnels en theorie, mais aucun des deux ne porte
la boucle de bandes, qui vit dans `swap` seul.

Le fait est etabli, pas suppose. Avant ce bornage, pousse en diagnostic
ponctuel a `invariant.runs = 3000` / `invariant.depth = 500`, une longue chaine
alternant ajouts et retraits, sans qu'aucun swap n'intervienne, faisait
tomber l'invariant sur `169600 >= 169600` : la somme des trois reserves valait
alors `3 200` unites, soit `0,000032` BTC, dont `1 696` sur la jambe fautive,
qui touchait donc son plafond a l'unite pres (`1 696 * 100 = 53 * 3 200`). Le
contre-exemple etait arithmetique, pas economique : personne ne cote un pool
de trois millioniemes de BTC, et l'arbitrage qui redresse les ratios n'y a
plus de granularite pour operer. Depuis le bornage, la meme configuration
`3000 / 500` passe, soit un million et demi d'appels de handler sans un seul
ratio hors bande. La trace est conservee dans le fichier plutot qu'effacee :
elle dit exactement ce que l'invariant affirme, et ou il s'arrete.

Le fichier porte enfin un test cible, non fuzze : **`test_InsufficientReserveReachedViaForgedState`**.
Amorce par `handler.addLiquidityWrapper`, `vm.store` sur le slot des reserves
(decouvert par lecture du getter public et balayage, pas code en dur) pour
mettre `reserves[0]` a zero, puis `pool.swap(0, 1000, 1, 0)` doit revert avec
`Pool.InsufficientReserve.selector`. Les `require` qui encadrent l'ecriture
echouent proprement si elle n'a pas touche le bon slot, ce qui detecte un
deplacement de layout en OZ sans laisser la regression silencieuse. C'est la
contrepartie promise plus haut a la garde de `Pool.sol:143`, que l'ABI ne sait
plus atteindre.

## Differe (couche Solidity)

Un invariant reste en attente, avec son blocker ecrit :

- **Le pot MRN de l'encheresse couvre refunds + pending + high bid.**
  L'enchere elle-meme n'existe pas (`Auction.sol` non ecrit, item 8a-c du
  plan non livre). La forme finale depend de la regle de confiscation du
  cautionnement et du flot de streaming sous 8c, donc l'invariant ne peut
  pas etre ecrit avant l'enchere, et l'ecrire en anticipation le ferait
  ecrire deux fois.

## Hors perimetre (atomcite EVM)

Un point supplementaire, propre a `removeLiquidity`, est explicitement laisse
**hors** de toute couche de test, Solidity comme TypeScript : l'atomicite de
la transaction quand le `_burn` echoue apres que la boucle de decrement des
reserves (`Pool.sol:124-128`) a deja tourne. La question est reelle : ce
decrement a bel et bien lieu, dans l'etat transitoire de la transaction,
avant l'echec eventuel du `_burn` (`Pool.sol:129`) ; ce qui l'annule ensuite
n'est pas une garde de `Pool.sol` mais le revert de l'EVM lui-meme, qui
efface tout l'etat modifie durant la transaction des qu'un appel echoue.
Repondre "cette transaction reste bien atomique" est donc verifier l'EVM,
pas le contrat, ce qui met la question hors perimetre d'un test fonctionnel
sur `Pool.sol`. Le point ci-dessus (`II.B`, `_burnedShares` superieur au
`totalSupply()`) rend d'ailleurs ce paragraphe plus interessant qu'il n'y
parait : c'est justement le seul cas ou ce decrement est effectivement
fautif (`reserves[i] -= uint72(amountsOut[i])` avec `amountsOut[i] >
reserves[i]`), et il echoue de lui-meme, par sous-flow arithmetique, sans
jamais atteindre le `_burn` : c'est la verification integree de Solidity 0.8
qui l'arrete sur place, a l'endroit meme de la faute, plutot qu'une erreur
levee plus loin dans la fonction et qui compterait sur le revert pour
rattraper un etat deja fausse.
