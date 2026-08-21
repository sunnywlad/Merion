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
ERC-20 differents (tBTC, cbBTC, LBTC) doivent chacun recevoir un `approve` du
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

La couche Solidity fuzz + invariants sur les trois fonctions est une question
distincte, laissee a l'auteur (voir "A venir" plus bas).

## Perimetre couvert

Cette suite couvre `Pool.sol` seul. Les dependances OpenZeppelin (`ERC20`,
`Ownable`, `Pausable`) sont hors perimetre : on suppose leur comportement
correct, on ne teste que ce que `Pool.sol` fait avec elles (les montants qu'il
transfere, les montants qu'il mint, les erreurs qu'il declenche).

## Structure de la suite

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
    B) InsufficientReserve
  II] swap sur pool amorce, feeNum = 5
    A) Cas nominal
    B) Balayage des six paires (indexIn, indexOut) distinctes
    C) Reverts
    D) Cas limites
    E) Pool desequilibre
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

La section `II.D` merite un mot. Elle ne recalcule pas la formule interne du
contrat (`_amount * reserves[i] / reserves[_anchorIndex]`, `Pool.sol:90`) en
JavaScript pour la comparer au resultat on-chain : un test qui reimplemente la
ligne qu'il teste ne prouve rien, il verifie que le code fait ce que le code
fait. La sous-section `1)` verifie a la place des proprietes qui se deduisent
de ce que doit etre un AMM, independamment de l'implementation : un depot ne
change pas la composition du pool (le rapport entre deux reserves est
identique avant et apres, verifie en comparant directement les reserves
attendues — chaque reserve doit croitre de la meme fraction que le depot
represente sur son ancre — a celles lues on-chain), et les parts emises sont
proportionnelles a la fraction du pool apportee. Cette propriete de
composition est testee une fois par ancre (trois `it` distincts, une fonction
d'aide nommee factorise le scenario) : chaque ancre est une transaction
differente, donc un comportement a verifier separement, une seule assertion
par test. La sous-section `2)` documente, avec des montants poses en dur et un
calcul a la main en commentaire, la consequence observable du choix de
l'ancre : a montant nominal identique, ancrer sur l'actif rare mint plus de
parts et preleve plus sur les autres tokens qu'ancrer sur l'actif abondant. La
sous-section `3)` verifie que l'evenement `AddedLiquidity` porte bien trois
`amountsIn` distincts sur un pool desequilibre (la verification sur pool vide,
en `I.A`, ne peut montrer que trois montants triviaux et egaux).

Un seul test fait exception a la regle "une assertion par `it`" au sens strict
du decompte de lignes `assert` : "sur un pool equilibre, le resultat est
identique quel que soit `_anchorIndex`" (`II.A`) execute trois depots (un par
ancre) et conclut par une unique assertion sur leur egalite. La claim testee
("identique quel que soit l'ancre") est intrinsequement comparative et ne se
decompose pas en trois tests independants sans perdre ce qu'elle affirme : un
`it` isole par ancre prouverait une valeur, jamais une egalite entre plusieurs
valeurs. C'est different du cas de composition ci-dessus, ou chaque ancre est
une transaction et un comportement distincts.

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
non nul dans chaque reserve (`334` unites, calcul a la main en commentaire).
C'est la meme protection anti-inflation que `MINIMUM_LIQUIDITY` en amorcage,
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
montant en frais dans les reserves (`Pool.sol:121-122`), et l'unique LP du
pool en profite au retrait, en recuperant strictement plus que son depot
initial.

`Pool.swap.test.ts` appelle quatre remarques.

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
forger l'etat par `vm.store`. C'est le meme genre de branche que le
`totalSupply() == 0` de `removeLiquidity` : reelle, mais inatteignable depuis
l'exterieur.

La section `II.B` balaie les six paires `(indexIn, indexOut)` distinctes, une
par `it`. Sur un pool equilibre elles rendent toutes le meme montant, ce qui
pourrait tenir en une boucle et une assertion ; chacune est pourtant une
transaction differente au niveau de l'ABI, donc un comportement a verifier
separement, dans l'esprit du "une ancre = un `it`" d'`addLiquidity`.

La section `II.D` documente un choix de conception assume : `_indexIn ==
_indexOut` n'est PAS garde. L'appel reussit, le swapper paie `_amount` et
recupere `amountOut` du meme token, donc il perd les frais et le slippage. Deux
`it` le verifient par des lectures on-chain, et la conclusion est celle qui
justifie l'absence de garde : rien n'est draine du pool, la reserve monte
exactement de ce que l'appelant perd. C'est le seul des trois cas degeneres de
`swap` a ne pas avoir recu de `require`, et la raison en est la : les deux
autres faisaient perdre de l'argent a un integrateur qui ne pouvait pas savoir,
celui-ci ne fait perdre de l'argent qu'a qui le demande explicitement.

Enfin, un seul test de la suite a besoin de DEUX pools vivants en meme temps,
la comparaison `feeNum = 0` contre `feeNum = 5` (le `feeNum` est fixe a la
construction, et `setFee` est `onlyOwner` avec un delai d'un jour). Les deux
`loadFixture` y sont appeles avant toute ecriture, et ce n'est pas cosmetique :
`loadFixture` restaure un instantane de la chaine, ce qui detruit tout ce qui a
ete deploye apres sa prise. Charger la seconde fixture apres avoir mint sur la
premiere effacerait ce mint, et charger la plus ancienne des deux en second
effacerait les contrats de l'autre. Corollaire utilise ailleurs dans le
fichier : deux `loadFixture` de la MEME fixture ne donnent jamais deux pools
independants, seulement deux fois le meme, donc la comparaison "actif rare
contre actif abondant" se fait par deux `simulate` (qui n'ecrivent rien) sur un
unique pool.

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

### Duplication des fixtures entre les fichiers de test

`Pool.removeLiquidity.test.ts`, `Pool.swap.test.ts` et `Pool.pause.test.ts`
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

### `addLiquidity` — pool vide

- depot minimal : `3 * _amount < MINIMUM_LIQUIDITY` sous-flow en panic
  arithmetique (`0x11`), pas une erreur nommee
- `_amount > type(uint72).max` : `ReserveOverflow`
- `_minShares` strictement superieur aux parts mintees : `BadSlippage`
- `_minShares` exactement egal aux parts mintees : accepte, pas de revert
- ordre des gardes : un appel a la fois trop grand (`> uint72.max`) et trop
  exigeant en `_minShares` echoue par `BadSlippage`, jamais `ReserveOverflow`
  (le garde de slippage est verifie en premier, `Pool.sol:76-77`)
- `_anchorIndex` hors bornes sur un pool vide : reussit sans revert, la
  branche `supply == 0` ne lit jamais l'ancre

### `addLiquidity` — pool amorce

- deuxieme deposant : parts proportionnelles au premier
- approbation insuffisante sur un seul des trois tokens : revert ERC-20
  (`ERC20InsufficientAllowance`)
- `_amount == 0` : `ZeroOutput`. Jusqu'au 2026-08-15 c'etait une transaction
  sans effet (aucune part mintee, aucun transfert) qui emettait quand meme un
  `AddedLiquidity` fantome, et quatre cas limites le documentaient ici. La
  garde `mintedShares > 0` (`Pool.sol:89`) les remplace par un unique revert,
  et le cas a change de section : ce n'est plus une limite toleree, c'est un
  refus. La garde ne vit que dans la branche `supply != 0` ; sur la branche
  d'amorcage `3 * _amount - MINIMUM_LIQUIDITY` ne peut pas valoir zero, un
  `require` y serait du code mort
- `_anchorIndex` hors bornes sur un pool amorce : panic `0x32`, acces hors
  bornes d'un tableau memoire (a la difference du pool vide, l'ancre est lue
  des la premiere ligne de la branche)
- pool desequilibre par un `swap` prealable : composition preservee et parts
  proportionnelles quel que soit l'anchorIndex ; consequence chiffree du
  choix de l'ancre (rare vs abondant)

### `removeLiquidity`

**Pool vierge**

- `totalSupply() == 0` : la division par `totalSupply()` declenche un panic
  de division par zero (`0x12`), pas une erreur nommee — branche inatteignable
  une fois le pool amorce (`MINIMUM_LIQUIDITY` n'est jamais brulee), mais bien
  reelle sur un contrat tout juste deploye

**Reverts**

- `_burnedShares` superieur au solde LP du retirant, ou retirant sans aucune
  part : `ERC20InsufficientBalance` (l'erreur vient de `Pool` lui-meme, qui
  est le token LP)
- `_minOut[i]` strictement superieur au montant sortant, sur chacun des trois
  indices : `BadSlippage`
- ordre des gardes : un retrait a la fois trop grand (`> solde LP`) et trop
  exigeant en `_minOut` echoue par `BadSlippage`, jamais
  `ERC20InsufficientBalance` (la boucle de slippage s'execute avant le
  `_burn`, `Pool.sol:106-111`)
- `_burnedShares` superieur au `totalSupply()` lui-meme (pas seulement au
  solde du retirant) : panic arithmetique (`0x11`), pas
  `ERC20InsufficientBalance` — le decrement des reserves (`Pool.sol:106-110`)
  sous-flow avant que le `_burn` (`Pool.sol:111`) n'ait la moindre chance de
  s'executer

**Cas limites**

- `_minOut` exactement egal aux montants sortants : accepte, pas de revert
- `_burnedShares == 0` : transaction sans effet (aucun transfert, reserves et
  `totalSupply` inchanges), mais l'evenement est quand meme emis
- arrondi entier toujours en faveur du pool (une part brulee isolement peut
  ne rendre aucun token, la part est quand meme retiree du `totalSupply`)
- retrait total du solde "libre" d'un deposant : laisse un residu non nul
  dans chaque reserve (garanti par `MINIMUM_LIQUIDITY`, jamais brulee)
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

- pool vierge, `_amount > 0` : `ZeroOutput` — sans cette garde, le
  `transferFrom` entrant s'executait et le swapper payait pour ne rien recevoir
- pool vierge, `_amount == 0` : panic `0x12`, le denominateur
  `amountAfterFee + reserves[_indexIn]` vaut `0 + 0` et la division precede
  tous les `require`
- `InsufficientReserve` : inatteignable par l'ABI, documente en commentaire et renvoye a la
  couche Solidity (voir la discussion plus haut)

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
  qui est verifie en dernier (`Pool.sol:127-131`). C'est l'ordre inverse
  d'`addLiquidity`, ou le slippage passe en premier pour ne pas lancer la
  boucle de rebalancement pour rien ; dans `swap` il n'y a pas de boucle a
  economiser, l'ordre suit donc l'information rendue a l'appelant

**Cas limites**

- `_minOut` exactement egal a `amountOut` : accepte
- `_indexIn == _indexOut` : accepte, deliberement non garde (voir plus haut)
- a entree identique, un pool a `feeNum = 0` rend strictement plus qu'un pool
  a `feeNum = 5`
- `amountOut` reste strictement sous `reserves[_indexOut]` meme sur une entree
  cent fois superieure aux reserves : un swap ne peut pas vider le pool
- impact de prix : deux swaps identiques successifs, le second rend
  strictement moins que le premier
- pool desequilibre : acheter l'actif rare rend strictement moins qu'acheter
  l'actif abondant, a entree identique (montants poses en dur, calcul a la
  main) ; l'evenement `Swapped` porte bien ces montants

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

## A venir (couche Solidity)

Trois TESTS sont volontairement renvoyes a la couche fuzz + invariants,
inatteignables ou peu pertinents en scenario scripte. Il s'agit bien de tests
manquants, jamais de code de contrat manquant : les gardes citees ci-dessous
sont ecrites, compilees et deployees, c'est leur EXERCICE depuis TypeScript qui
est impossible.

- **`mintedShares` qui tombe a 0 par arrondi entier.** Sur un pool fortement
  desequilibre par l'accumulation de frais sur le tres long terme, la
  division entiere `supply * _amount / reserves[_anchorIndex]` peut s'arrondir
  a 0 pour un petit depot non nul. Depuis la garde `ZeroOutput`, l'enjeu n'est
  plus "le deposant paie pour rien" mais "le depot est bien refuse" : ce que
  le fuzzer doit prouver, c'est qu'aucune sequence d'operations n'atteint le
  `_mint` avec `mintedShares == 0`. L'etat degenere suppose des centaines de
  swaps successifs pour deriver les reserves jusqu'a ce que
  `reserves[_anchorIndex]` depasse `totalSupply()` : un fuzzer qui enchaine
  des sequences est le bon outil pour l'atteindre, pas un scenario ecrit a la
  main.
- **Le test de la garde `InsufficientReserve` de `swap`** (la garde, elle, est
  en place dans `Pool.sol:128`). Elle n'est atteignable que sur
  un etat que l'ABI ne permet plus de construire (reserve d'entree nulle,
  reserve de sortie garnie). Un test Solidity peut forger cet etat par
  `vm.store` sur le slot des reserves, et c'est le seul endroit ou cette
  branche s'execute : simple commentaire cote TypeScript, en attendant.
- **Les invariants de conservation des reserves.** Que la somme des
  transferts entrants/sortants sur `addLiquidity`, `removeLiquidity` et
  `swap` corresponde toujours exactement aux deltas de `reserves`, sur des
  sequences arbitraires d'operations. C'est la definition meme d'un test
  d'invariant Foundry, pas d'un test fonctionnel isole.

Un point supplementaire, propre a `removeLiquidity`, est explicitement laisse
**hors** de toute couche de test, Solidity comme TypeScript : l'atomicite de
la transaction quand le `_burn` echoue apres que la boucle de decrement des
reserves (`Pool.sol:106-110`) a deja tourne. La question est reelle : ce
decrement a bel et bien lieu, dans l'etat transitoire de la transaction,
avant l'echec eventuel du `_burn` (`Pool.sol:111`) ; ce qui l'annule ensuite
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
