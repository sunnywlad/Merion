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

La couche Solidity fuzz + invariants sur `addLiquidity` et `removeLiquidity`
est une question distincte, laissee a l'auteur (voir "A venir" plus bas).

## Perimetre couvert

Cette suite couvre `Pool.sol` seul. Les dependances OpenZeppelin (`ERC20`,
`Ownable`) sont hors perimetre : on suppose leur comportement correct, on ne
teste que ce que `Pool.sol` fait avec elles (les montants qu'il transfere, les
montants qu'il mint, les erreurs qu'il declenche).

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

### Duplication des fixtures entre les deux fichiers de test

`Pool.removeLiquidity.test.ts` redefinit ses propres fixtures et helpers
(`deployTokensAndPool`, `mintAndApprove`, `readReserves`, `readBalances`,
`assertPanic`, `deploySeededPoolFixture`, `deployImbalancedPoolFixture`...),
identiques a ceux d'`addLiquidity`, plutot que de les importer d'un module
partage. C'est delibere. Chaque fichier de test ouvre sa propre connexion
reseau via son propre appel a `network.create()` (voir la skill `hardhat`) :
c'est cette connexion qui porte l'etat de la blockchain simulee et le cache
de `networkHelpers.loadFixture`. Un module de fixtures partage entre les deux
fichiers devrait soit se lier a une connexion choisie arbitrairement (couplant
deux fichiers senses etre independants l'un de l'autre), soit reconstruire ses
fixtures depuis la connexion du fichier appelant a chaque import (perdant
l'interet du partage). Dans les deux cas, un fichier qui echoue ou se
modifie peut casser l'autre sans lien logique evident. La duplication a un
cout (un second lieu a maintenir si `Pool.sol` change), mais elle est plus
sure qu'un couplage implicite entre deux suites qui doivent pouvoir tourner,
echouer et evoluer separement.

### Panics Solidity : comment ils sont attrapes

Plusieurs cas de la suite, repartis sur les deux fichiers, attendent un panic
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
- `_amount == 0` : transaction sans effet (aucune part mintee, aucun
  transfert), mais aucun revert
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

## A venir (couche Solidity)

Deux points sont volontairement renvoyes a la couche fuzz + invariants,
inatteignables ou peu pertinents en scenario scripte :

- **`mintedShares` qui tombe a 0 par arrondi entier.** Sur un pool fortement
  desequilibre par l'accumulation de frais sur le tres long terme, la
  division entiere `supply * _amount / reserves[_anchorIndex]` peut s'arrondir
  a 0 pour un petit depot. C'est un etat degenere qui suppose des centaines
  de swaps successifs pour deriver les reserves jusqu'a ce point : un fuzzer
  qui enchaine des sequences d'operations est le bon outil pour l'atteindre,
  pas un scenario ecrit a la main.
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
