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

La suite compte 212 tests verts : 146 en TypeScript (5 fichiers `test/*.test.ts`)
et 66 en Solidity (8 fichiers `test/*.t.sol`, 4 fichiers `contracts/*.t.sol`).

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
  III] Cas limites
    A) Frais nuls, acceptes deliberement
    B) treasury et owner sont deux roles distincts
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

La couche Solidity, elle, se lit par fichier plutot que par arborescence :

```
test/Pool.addLiquidity.t.sol     fuzz des deux branches (pool vide, pool amorce)
test/Pool.removeLiquidity.t.sol  fuzz du pool vierge et du pool amorce
test/Pool.swap.t.sol             fuzz, domaine partage par MAX_IN_BAND_AMOUNT
test/Pool.setFee.t.sol           fuzz du delai, du plafond, du controle d'acces
test/Pool.safeERC20.t.sol        les quatre sites d'appel de SafeERC20
test/Pool.forgedState.t.sol      proprietes atteintes par forge d'etat (vm.store)
test/Pool.depeg.t.sol            les bandes face a une decote reelle d'un wrapper
test/Pool.invariant.t.sol        handler + quatre invariants + un test cible
contracts/Pool.gas.t.sol         mesures de gas (rapport dans GAS.md)
contracts/Pool.t.sol             decimals()
contracts/MockWrappedBTC.t.sol   le mock ERC20Capped du panier
contracts/MRN.t.sol              le jeton natif MRN
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
construction, et `setFee` est `onlyOwner` avec un delai d'un jour). Les deux
`loadFixture` y sont appeles avant toute ecriture, et ce n'est pas cosmetique :
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

`Pool.constructor.test.ts` appelle deux remarques.

La premiere porte sur la frontiere que testent ses deux gardes, et elle n'est
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

La seconde est un detail d'outillage qui pique, du meme genre que le
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

### Duplication des fixtures entre les fichiers de test

`Pool.removeLiquidity.test.ts`, `Pool.swap.test.ts`, `Pool.pause.test.ts` et
`Pool.constructor.test.ts` redefinissent chacun leurs propres fixtures et helpers
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
- `lastFeeUpdate` part du meme timestamp (`Pool.sol:78`), pas de zero : le
  delai de `setFee` court donc des le deploiement et ne s'ouvre pas
  immediatement. C'est ce qui oblige `Pool.pause.test.ts` a avancer le temps
  avant son `setFee`
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
  inadapte. Contrepartie a connaitre : `MIN_SET_FEE_DELAY` court sur
  `block.timestamp`, donc il tourne pendant la pause, et consommer le droit la
  veille de la reprise le rend indisponible pour les vingt-quatre heures qui
  suivent la reouverture

**Retour a l'etat normal**

- apres `unpause()`, `addLiquidity` et `swap` repassent et rendent les memes
  montants qu'avant la pause : la pause ne laisse aucune trace dans l'etat

## Couche Solidity : fuzz, invariants, forge d'etat

Quatre fichiers portent ce que la couche TypeScript ne peut pas atteindre :
un domaine d'entrees, un enchainement d'appels, une valeur de retour ERC-20
non conforme, ou un etat de reserves qu'aucune sequence legitime ne produit.

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
