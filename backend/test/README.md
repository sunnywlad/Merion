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

La couche Solidity fuzz + invariants sur `addLiquidity` est une question
distincte, laissee a l'auteur (voir "A venir" plus bas).

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
```

La section `II.D` merite un mot. Elle ne recalcule pas la formule interne du
contrat (`_amount * reserves[i] / reserves[_anchorIndex]`, `Pool.sol:90`) en
JavaScript pour la comparer au resultat on-chain : un test qui reimplemente la
ligne qu'il teste ne prouve rien, il verifie que le code fait ce que le code
fait. La sous-section `1)` verifie a la place deux proprietes qui se deduisent
de ce que doit etre un AMM, independamment de l'implementation : un depot ne
change pas la composition du pool (le rapport entre deux reserves est
identique avant et apres, verifie par egalite croisee pour eviter tout biais
d'arrondi), et les parts emises sont proportionnelles a la fraction du pool
apportee. La sous-section `2)` documente, avec des montants poses en dur et un
calcul a la main en commentaire, la consequence observable du choix de
l'ancre : a montant nominal identique, ancrer sur l'actif rare mint plus de
parts et preleve plus sur les autres tokens qu'ancrer sur l'actif abondant.

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
