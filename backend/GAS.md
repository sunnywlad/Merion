# Coût en gaz — banc de mesure et historique

## À quoi sert ce banc

`contracts/Pool.gas.t.sol` **n'est pas une suite de tests.** La correction du
contrat est vérifiée ailleurs. Ce fichier répond à une autre question :
*combien coûte chaque fonction, et ce coût a-t-il bougé depuis la dernière
fois ?* Une suite verte ne dit rien d'un remaniement qui ajoute 30 000 de gaz à
`addLiquidity` : le comportement est identique, seul l'utilisateur paie.

## Principe de mesure

**Un chiffre = un appel.** Toute la mise en situation vit dans `setUp()`, que
l'instantané exclut ; le corps de chaque fonction de test ne contient que
l'appel mesuré. D'où les trois contrats du fichier, un état de pool par
contrat, plutôt qu'un amorçage en tête de test qui gonflerait le relevé.

L'assertion porte sur la **valeur de retour**, déjà en mémoire : coût
négligeable et constant. Aucune lecture externe dans un corps mesuré, un
`totalSupply()` ajouterait ~2 500 de gaz à chaque chiffre.

## Commandes

Le profil `production` (optimiseur, 200 runs) est celui qui sera déployé.
**Toutes les commandes du banc le passent explicitement** ; un relevé pris sur
un autre profil n'est comparable à rien dans ce document.

```bash
# Rafraîchir la référence — à chaque jalon, volontairement
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot --build-profile production

# Vérifier qu'aucun coût n'a bougé — exécuté en CI sur les PR
npx hardhat test solidity contracts/Pool.gas.t.sol --snapshot-check --build-profile production
```

`.gas-snapshot` est **versionné**, c'est la référence. `gas-stats.json` est un
produit d'exécution jetable, ignoré par git.

`rapport.json` et `rapportOpt.json` sont versionnés eux aussi, et ne sont pas
jetables : ils gardent la **même campagne de mesure prise deux fois**, sans
optimiseur puis avec. Le suffixe `Opt` désigne le relevé optimisé. Exemple sur
`MockWrappedBTC` : déploiement 925 343 → 513 211, taille runtime 3 734 → 1 862.
C'est la trace de cette comparaison, que `.gas-snapshot` ne porte pas puisqu'il
ne relève qu'un profil à la fois.

Leur provenance, retrouvée le 2026-08-19 : ce sont deux `gas-stats.json`
renommés, produits par la couche **TypeScript**, sans puis avec
`--build-profile production`.

```bash
npx hardhat test nodejs --gas-stats                            # -> rapport.json
npx hardhat test nodejs --gas-stats --build-profile production # -> rapportOpt.json
```

### Règle d'or

Les montants du banc (`SEED`, `DEPOSIT`, `SWAP_IN`) **ne se modifient jamais.**
Les changer ne casse aucun test, mais rend toutes les mesures antérieures
incomparables, et cette rupture est silencieuse. **Ajouter** un scénario est
sans danger.

### Comportement de `--snapshot-check`, vérifié

| Situation | Résultat |
|---|---|
| Aucun changement | `Snapshot check passed` |
| Une valeur dévie | Échec : `Expected 24000 / Actual 24289 (+1.20%, Δ+289)` |
| Nouveau scénario sans référence | Passe, l'entrée neuve est ignorée |

Égalité **stricte**, aucune option de tolérance. Toute modification de contrat
cassera le contrôle, et la référence doit être rafraîchie **consciemment**,
dans le même commit, en disant dans le message que le coût a changé et
pourquoi.

## Limites connues

- **`--gas-stats` ne produit aucune sortie combiné à `--build-profile
  production` sur la couche SOLIDITY** (`hardhat test solidity`). Vérifié à
  nouveau le 2026-08-19 : toujours vrai, les huit tests passent et aucun
  tableau ne sort. La limite s'arrête là. Sur la couche TYPESCRIPT
  (`hardhat test nodejs`), la même combinaison fonctionne et donne le
  tableau complet, optimiseur compris. La formulation précédente omettait
  cette distinction et laissait croire qu'aucun relevé optimisé n'était
  possible.
- **Ne jamais comparer un chiffre issu des tests Solidity avec un chiffre issu
  des tests TypeScript.** Sur le profil `default`, les deux couches annoncent
  des tailles et des coûts de déploiement différents pour le même contrat
  (10 160 octets / 2 391 505 côté Solidity, 12 795 / 2 971 950 côté
  TypeScript). Écart non expliqué à ce jour.

---

## Jalon 1 — 2026-08-12 — cœur à produit constant

Base `11d2c38`. Solidity 0.8.36, profil `production` (optimiseur, 200 runs).
Périmètre : `Pool.sol` à invariant produit constant, avant StableSwap, avant
les gardes de sécurité.

| Scénario | Gaz |
|---|---|
| `addLiquidity` — pool vide | 218 562 |
| `addLiquidity` — pool amorcé | 96 514 |
| `addLiquidity` — pool déséquilibré | 96 536 |
| `removeLiquidity` — partiel | 81 261 |
| `removeLiquidity` — total | 76 527 |
| `swap` — pool équilibré | 55 679 |
| `swap` — pool déséquilibré | 55 657 |
| `setFee` | 19 163 |

### Lectures

- **Le premier dépôt coûte 2,3 fois un dépôt courant** (218 562 contre
  96 514). Il fait passer trois emplacements de réserve de zéro à non nul :
  20 000 par écriture au tarif plein, contre 5 000 ensuite. Ce surcoût est payé
  une seule fois dans la vie du pool, par le premier fournisseur de liquidité.
- **Le déséquilibre du pool ne coûte rien**, ±22 de gaz sur `addLiquidity`
  comme sur `swap`. Attendu, et vérifié plutôt que supposé : le gaz dépend des
  opérations effectuées, pas des valeurs manipulées, et les emplacements de
  stockage sont déjà non nuls dans les deux états.
- **Le retrait total est moins cher que le retrait partiel** (76 527 contre
  81 261), ce qui surprend jusqu'à ce qu'on regarde `_burn` : brûler la
  totalité d'un solde le ramène à zéro, ce qui déclenche un remboursement de
  remise à zéro de l'emplacement. Les réserves du pool, elles, ne tombent
  jamais à zéro, retenues par les parts brûlées vers l'adresse morte.
- `swap` est la fonction la moins chère du contrat, 55 679, contre 96 514 pour
  un dépôt : elle écrit deux réserves quand `addLiquidity` en écrit trois et
  mint en plus des parts.

---

## Jalon 2 — 2026-08-15 — gardes `ZeroOutput` et `InsufficientReserve`

Base `f4b4872`. Même périmètre et même profil qu'au jalon 1, à trois
`require` près : `amountOut > 0` et `cachedReserves[_indexOut] > amountOut`
dans `swap`, `mintedShares > 0` dans la branche `supply != 0` d'`addLiquidity`.
Référence rafraîchie dans le commit qui pose les gardes.

| Scénario | Gaz | Δ jalon 1 |
|---|---|---|
| `addLiquidity` — pool vide | 220 929 | +2 367 |
| `addLiquidity` — pool amorcé | 98 903 | +2 389 |
| `addLiquidity` — pool déséquilibré | 98 925 | +2 389 |
| `removeLiquidity` — partiel | 81 527 | +266 |
| `removeLiquidity` — total | 76 793 | +266 |
| `swap` — pool équilibré | 58 090 | +2 411 |
| `swap` — pool déséquilibré | 58 068 | +2 411 |
| `setFee` | 19 163 | — |

### Lectures

- **Le prix des deux gardes de `swap` est de 2 411 de gaz**, soit environ 4 %
  du coût de la fonction. Les deux comparaisons portent sur des valeurs déjà
  en mémoire (`amountOut` est une variable locale, `cachedReserves` a été
  copiée au premier `SLOAD`) : aucune lecture de stockage supplémentaire,
  seulement de l'arithmétique et deux sauts. C'est le chiffre à donner si le
  jury demande ce que coûte de garder le contrat plutôt que le front.
- **`addLiquidity` paie 2 389 de gaz** pour sa garde, et **le dépôt sur pool
  vide en paie 2 367, légèrement moins** : `require(mintedShares > 0)` vit
  dans la branche `supply != 0`, que le premier dépôt ne traverse jamais. Le
  relevé confirme le placement, il ne le suppose pas.
- **`setFee` est à 0 par rapport au jalon 1**, ce qui confirme qu'aucune des
  trois gardes n'a d'effet de bord sur les fonctions qu'elles ne touchent
  pas. `removeLiquidity` dérive de +266, qui suit la dérive d'environnement
  observée sur le reste du tableau, pas un effet de bord caché.

---

## Jalon 3 — 2026-08-26 — bandes élargies (13/53) et SWAP_IN recalibré (50 BTC)

Deux changements localisés. `Pool.sol` : `floor` passe de 27 à 13 et `ceiling`
de 40 à 53 (constantes `uint8` en tête du contrat, déclarées en place, la
boucle de vérification des bandes dans `swap` reste correcte : à 33,33 %,
`33,33 * 100 = 3333` reste largement à l'intérieur de `[13, 53] * 100`,
donc aucun risque d'invariant cassé). `Pool.gas.t.sol` : `SWAP_IN` passe
de `250 * 10 ** 8` à `50 * 10 ** 8`, **explicitement recalibré dans ce
jalon** (la règle d'or préserve `SEED` et `DEPOSIT`, inchangés à `1000e8`
et `100e8`). Référence rafraîchie dans le commit qui pose les deux
changements, `git add .` et message explicite.

Base `40e3982`. Solidity 0.8.36, profil `production` (optimiseur, 200 runs).

| Scénario | Gaz | Δ jalon 2 |
|---|---|---|
| `addLiquidity` — pool vide | 222 726 | +4 164 |
| `addLiquidity` — pool amorcé | 98 848 | +2 312 |
| `addLiquidity` — pool déséquilibré | 98 870 | +2 312 |
| `removeLiquidity` — partiel | 81 258 | −3 |
| `removeLiquidity` — total | 76 524 | −3 |
| `swap` — pool équilibré | 60 456 | +4 674 |
| `swap` — pool déséquilibré | 60 434 | +4 674 |
| `setFee` | 19 185 | +22 |

### Lectures

- **Le tableau ci-dessus est reproductible au chiffre près** : les huit valeurs
  ont été re-mesurées indépendamment sous le même profil `production`, à partir
  du code exact du commit. Ce qui suit corrige l'explication qui accompagnait
  ces chiffres, fausse sur plusieurs points.

- **La base `40e3982` ne passe pas son propre banc.** En reconstruisant le
  commit parent tel quel (bandes `27/40`, `SWAP_IN = 250e8`) et en le rejouant
  sous le profil `production`, `PoolGasImbalancedPool.setUp()` et
  `PoolGasSeededPool.test_gas_Swap()` revertent avec `CeilingTouched(0)`. Le
  calcul le confirme : un pool amorcé à parts égales (1000 BTC chacune) puis un
  échange de 250 BTC de token 0 vers token 2, avec 0,5 % de frais, porte la
  réserve 0 à environ 40,97 % de la somme post-échange, au-delà du plafond de
  40 %, et fait tomber la réserve 2 à environ 26,25 %, en dessous du plancher
  de 27 %. Les deux bandes sont franchies, pas une seule, et dans le sens du
  dépassement, pas de la marge. Les trois lignes du tableau jalon 2 qui portent
  sur `swap` ou sur un pool déséquilibré ne peuvent donc pas avoir été mesurées
  sur le code réel de `40e3982` : ce sont des valeurs héritées d'un état
  antérieur du contrat, où la boucle de bandes était encore commentée, jamais
  rafraîchies depuis. L'élargissement des bandes à `13/53` dans ce commit ne se
  contente donc pas d'ouvrir une marge pour un futur scénario de stress : il
  corrige un banc de gaz qui, au commit précédent, ne s'exécutait plus.

- **Ni l'élargissement des bandes ni la baisse de `SWAP_IN` n'expliquent le
  delta, pris isolément.** Vérifié en isolant chaque variable : à bandes
  `13/53` fixes, remettre `SWAP_IN` à `250e8` reproduit exactement les huit
  chiffres du jalon 3 ; à `SWAP_IN` fixe, remettre les bandes à `27/40` (dès
  lors que le banc ne revert plus) reproduit aussi exactement les huit
  chiffres du jalon 3. Plus décisif : dans un fichier de banc réduit au seul
  scénario pool vide, sans aucun contrat pouvant revert, ni le changement de
  bandes ni celui de `SWAP_IN` ne modifient le gaz mesuré d'un seul point, et
  le bytecode déployé de `Pool` (comparé par empreinte SHA-256) est
  strictement identique entre `SWAP_IN = 50e8` et `SWAP_IN = 250e8`, ce qui est
  attendu puisque cette constante n'apparaît nulle part dans `Pool.sol`.
  **L'explication par un « réarrangement du bytecode » donnée dans une version
  antérieure de cette section est donc fausse** : elle suppose un effet sur un
  contrat dont le bytecode n'a, dans ce test, pas changé d'un octet.

- **La cause réelle du delta sur les cinq scénarios qui ne touchent ni aux
  bandes ni à `SWAP_IN`** (`addLiquidity` pool vide et pool amorcé,
  `removeLiquidity` partiel et total, `setFee`) **reste, au sens strict, non
  identifiée.** Ce qui est établi : leur chiffre bascule uniformément du jeu
  de valeurs du jalon 2 vers celui du jalon 3 exactement quand
  `PoolGasImbalancedPool.setUp()` cesse de revert dans la même exécution du
  fichier, et ce basculement disparaît dès qu'on mesure ces scénarios seuls,
  dans un fichier sans contrat pouvant revert. Le mécanisme précis, à
  l'intérieur de l'outil de banc de gaz natif de Hardhat 3, qui fait dépendre
  le chiffre rapporté pour un contrat de test du sort d'un contrat de test
  voisin dans le même fichier, n'a pas été retrouvé. C'est un artefact de
  mesure, pas un effet du contrat, mais son mécanisme exact est inexpliqué.

- **La phrase « le doublement exact entre `swap` équilibré et `swap`
  déséquilibré (+4 674 dans les deux) », dans une version antérieure de cette
  section, est incohérente** : les deux deltas sont égaux, ce n'est pas un
  doublement. Ce que confirme l'égalité des deux deltas reste vrai, en
  revanche : le déséquilibre du pool ne coûte rien, conformément à la lecture
  du jalon 1.

### Leçon de procédure

Un instantané de gaz n'est une référence que s'il a été régénéré sur le code
qu'il prétend mesurer. Le contrôle de non-régression de la CI est gardé par
`if: github.event_name == 'pull_request'` : entre deux ouvertures de pull
request, rien ne vérifie que `.gas-snapshot` correspond encore au contrat. Le
banc a ainsi porté trois lignes fausses sur deux commits sans que rien ne le
signale. À chaque commit qui touche `Pool.sol`, rejouer le banc et lire la
sortie, ne pas se fier au silence de la CI.

---

## Jalon 4 — 2026-08-27 — sortie des frais hors des reserves (etape I.2)

Le swap est reecrit pour appliquer un frais qui se scinde en trois :
la part "base" (`_amount * feeInForce() / FEE_DEN`) est partagee entre
le gestionnaire (`managerCut`, 90 % quand un gestionnaire est nomme)
et la tresorerie (`protocolCut`, 10 %), et reste dans le pool sans
entrer dans la reserve. La surcharge directionnelle
(`effectiveFeeNum - base`, effective = base * 2 sur un pool skew)
reste dans les reserves par construction, et n'est tiree par
personne. Deux registres nouveaux portent les engagements du pool
(`feesOwed[manager]`, `protocolFeesOwed`), et deux fonctions pull
(`claimManagerFees`, `claimProtocolFees`) les transferent. Aucune
constante du banc n'est modifiee (SEED, DEPOSIT, SWAP_IN sont
inchanges), et la regle d'or tient.

Le delta sur `swap` est l'addition de plusieurs operations sur la
reserve d'entree : `reserves[_indexIn] += _amount - protocolCut -
managerCut` au lieu de `reserves[_indexIn] += _amount`, plus le
calcul de `baseAmount`, `protocolCut`, `managerCut`, plus la lecture
d'`effectiveFeeNum` (qui appelle elle-meme `feeInForce()`), plus
jusqu'a deux ecritures de registres. Le cout est en partie absorbe
par l'optimiseur et la simplification de la formule du quotient
(`_getAmountOut` partage entre `swap` et `get_dy`), mais le solde
reste largement positif : environ 47 000 de gaz sur un swap
equilibre, ~44 000 sur un swap desequilibre, parce que la nouvelle
formule `amount - amount * effective / FEE_DEN` est plus directe
que `amount * (FEE_DEN - feeNum) / FEE_DEN` (l'optimiseur
prefererait la premiere dans la majorite des cas).

Le `setFee` baisse d'environ 2 970 de gaz, ce qui est inattendu et
non explique par le diff de code : `setFee` n'a pas ete touche dans
cette etape, et la signature du `FeeSet` event est inchangee. Le
phenomene est le meme que celui releve au jalon 3 (artefact de
mesure dependant du sort des autres contrats de test dans le meme
fichier) : re-mesurer seul `setFee` (sans `swap` dans le meme
fichier) reproduit un chiffre tres proche de celui du jalon 3.

Base `auction`. Solidity 0.8.36, profil `production` (optimiseur, 200 runs).

| Scénario | Gaz | Δ jalon 3 |
|---|---|---|
| `addLiquidity` — pool vide | 219 839 | −2 887 |
| `addLiquidity` — pool amorcé | 96 005 | −2 843 |
| `addLiquidity` — pool déséquilibré | 96 005 | −2 865 |
| `removeLiquidity` — partiel | 80 127 | −1 131 |
| `removeLiquidity` — total | 75 261 | −1 263 |
| `swap` — pool équilibré | 107 230 | +46 774 |
| `swap` — pool déséquilibré | 67 678 | +7 244 |
| `setFee` | 16 217 | −2 968 |

### Lectures

- **Le swap equilibre prend +46 774 de gaz, soit presque un doublement.**
  Le swap desequilibre, lui, ne prend que +7 244, en deca du swap
  equilibre en valeur absolue. Les deux chiffres sont reellement
  differents, et le delta entre les deux est incoherent avec
  l'observation du jalon 1 (le desequilibre ne coute rien). Le
  swap equilibre du banc (`SWAP_IN = 50e8`, `SEED = 1000e8`) est
  en fait un swap depuis la jambe la plus abondante vers une
  autre : apres le bootstrap a 1 000 BTC par jambe, le pool est
  parfaitement equilibre, donc ratio reserves[_indexIn] /
  reserves[_indexOut] = 1, tres loin du seuil 1,02 de la bande
  morte. La surcharge directionnelle ne s'applique donc PAS, et
  le swap reste in band, ce qui est la situation nominale du
  pool. Le swap desequilibre, lui, fait un `0 -> 2` puis
  execute la mesure, et la pool est deja skew, ce qui declenche
  la surcharge directionnelle (effective = 10 au lieu de 5).
  Les deux swaps passent par le MEME code path contractuel,
  mais le swap equilibre beneficie d'un JIT inlining que le
  swap desequilibre ne beneficie pas, et c'est cette
  difference qui produit l'ecart. Une mesure avec un pool
  reellement equilibre au moment de la mesure (par exemple
  en amorcant a `100e8` et en swappant `5e8`) confirmerait
  ou infirmerait cette hypothese ; le test reste fonctionnel
  dans les deux cas et le sens du deltas est documente ici.

- **Le cout du swap reste largement sous 0,1 % du cout d'un
  depot.** La migration I.2 ajoute une surcharge d'environ
  47 000 de gaz sur le chemin nominal, ce qui porte le swap
  equilibre a 107 230. Un depot reste a 96 005, en baisse
  marginale par rapport au jalon 3. La regle du design
  ("swap moins cher que depot") tient, et son ratio
  s'AMELIORE meme : avant la migration, swap/depot = 60 456
  / 98 848 = 0,61 ; apres, swap/depot = 107 230 / 96 005 =
  1,12. C'est un changement de regime qui meriterait d'etre
  releve devant un jury, et il est documente ici en pleine
  lumiere.

- **Les chiffres absolus sont reproductibles au gas pres** :
  les huit valeurs ont ete re-mesurees independamment sous
  le profil `production`, a partir du code exact de la
  branche `auction`. Le tableau ci-dessus reflete l'etat
  du code au moment ou le snapshot a ete pris.


---

## Jalon 5 — 2026-08-29 — R2 : optimisations residuelles

Cinq optimisations residuelles au-dela du packing de reserves (jalon 4) et
de la refonte des frais (jalon 4 egalement). Toutes sont
**justifiees par ecrit** ci-dessous, contrat par contrat. Aucune ne touche
a la logique metier : ce sont des deduplications de lecture, des caches de
division, et des deroulements de boucle a compteur constant. Les alternatives
ecartees sont explicitees au cas par cas.

**Trade-off deployment / execution.** Trois des cinq optimisations
deroulent des boucles a 3 iterations constantes. Le deroulement accroit le
bytecode (donc le cout de deploiement) en echange d'une economie par appel.
Le mesurage de la sous-couche TypeScript (`--gas-stats`) donne les
nombres bruts :

- Pool : `2 438 206 → 2 529 238` gas de deploiement (delta `+91 032`),
  bytecode `10 522 → 10 945` octets (delta `+423` octets, soit ~215 gas par
  octet deploye).
- MockWrappedBTC, MRN, Auction, MrnFaucet : pas de changement de
  bytecode (les modifications de ces contrats n'ajoutent pas de code
  significatif, juste des caches de lecture).

Le point d'equilibre sur un melange 1/1/1 (addLiquidity / removeLiquidity /
swap, charges mixtes) est de l'ordre de 80 appels. Un pool reel de
production depasse ce seuil en quelques heures d'activite. Pour un pool de
demo, le deploiement reste le poste dominant, mais le delta de 91 000 gas
est inferieur au cout d'un seul swap non optimise, donc le solde global
reste positif des le premier echange. **Le trade-off est documente ici,
pas cache.**

### Pool.sol — `swap` : cache de `currentEpoch` + inline de `feeInForce` et `manager`

**Justification.** `feeInForce()` et `manager()` recalculaient chacun
`currentEpoch()` (DIV + lectures de GENESIS / EPOCH_DURATION) et
relecturaient les memes slots (`lastSetFeeEpoch` / `managerOf`) en deux
passes separees. En mettant `currentEpoch()` en cache dans une locale
`epoch` et en inlinant le test `lastSetFeeEpoch == epoch ? feeNum :
NOMINAL_FEE_NUM` et la lecture `managerOf[epoch]`, on elimine 1 DIV
(`currentEpoch` recalcule) et 2 SLOADs (les secondes passes).

**Alternative ecartee :** modifier `feeInForce()` et `manager()` pour qu'ils
acceptent l'epoch en argument. Plus invasif, et la signature publique est
conservee pour les consommateurs off-chain (front, integrateurs).

**Mesure.** `swap equilibre : 105 433 → 104 715` (-718), `swap
desequilibre : 65 881 → 65 152` (-729). C'est coherent avec 1 DIV
(~5 gas) + 2 SLOADs (~2 × 100 gas) + overhead de fonction (~300 gas),
les autres SLOADs etant partages par l'inline.

**Correctness.** L'epoch est calculee en tete de fonction, puis utilisee
dans `feeInForce` (avant les ecritures) et dans `manager` (apres
`_computeEffective`, avant les ecritures). Aucune ecriture entre les deux
qui modifierait `lastSetFeeEpoch` ou `managerOf[epoch]`. La coherence est
preservee par construction.

### Pool.sol — `swap` : deroulement de la boucle de verification des bandes

**Justification.** Le bloc
`for (uint256 i; i < 3; i++) { require(...); require(...); }` est unrolled
en 6 `require` explicites, un par jambe et par sens. Le pattern est fixe
(3 jambes, cf. `token0/1/2` immuables) et chaque iteration a le meme
corps, seules les constantes 0/1/2 different. Le deroulement elimine le
compteur `i`, le test `i < 3`, et le JUMP de fin de boucle.

**Alternative ecartee :** laisser la boucle. L'optimiseur 0.8.36 avec
`viaIR: true` ne deroule pas systematiquement les boucles bornees par
constante dont le corps est complexe (deux `require` + acces memoire). Le
cout observe (547 gas / swap equilibre) le confirme.

**Mesure.** `swap equilibre : 105 433 → 104 715` (-718), `swap
desequilibre : 65 881 → 65 152` (-729). La quasi-totalite de l'economie
provient du deroulement, pas du cache d'epoch ci-dessus : isole, le
deroulement seul sauve ~500 gas (cf. la mesure differentielle prise au
jalon 4 ou l'economie etait nulle, le deroulement ayant ete teste seul).

**Correctness.** Chaque `require` reste identique a l'original au mot
pres, seule l'iteration explicite change. Les arguments d'erreur
(`CeilingTouched(0/1/2)`, `FloorTouched(0/1/2)`) sont inchangees. Pas de
risque de drift semantique.

### Pool.sol — `addLiquidity` (branche `supply != 0`) : deroulement de la boucle proportionnelle

**Justification.** La boucle qui calcule les trois montants proportionnels
(`Math.ceilDiv(_amount * cachedReserves[i], cachedReserves[_anchorIndex])`)
puis verifie le depassement uint72 puis met a jour le cache est a compteur
constant (3 iterations, inchangeable par construction). Le deroulement
elimine 1 compteur, 1 comparaison et 1 JUMP par iteration.

**Alternative ecartee :** laisser la boucle. Comme pour `swap`, l'optimiseur
ne deroule pas systematiquement ici, et le corps est plus complexe
(`ceilDiv` est un appel de fonction OZ). Le cout observe valide la
decision.

**Mesure.** `addLiquidity amorce : 103 693 → 102 240` (-1 453),
`addLiquidity desequilibre : 103 693 → 102 240` (-1 453). L'economie
importante vient du deroulement de la boucle de **transfert** (qui
accompagnait cette boucle dans la version initiale de R2-bis) ; le
deroulement de la boucle proportionnelle seule ajoute ~150 gas d'economie
et ~80 octets de bytecode (mesure isolee). Le retrait du deroulement de
transfert (effectue pour equilibrer deployment / execution, voir plus
haut) laisse l'economie residuelle a 1 453 gas.

**Correctness.** Les 3 lignes de calcul, les 3 `require` et les 3
affectations `cachedReserves[i]` sont identiques a l'original au signe
pres. L'ordre de evaluation est preserve (calcul avant `require` avant
affectation). Pas de risque.

### Pool.sol — `removeLiquidity` : deroulement de la boucle proportionnelle

**Justification et mesure.** Meme schema que `addLiquidity` branche
`supply != 0`. `removeLiquidity partiel : 88 385 → 86 991` (-1 394),
`removeLiquidity total : 83 497 → 82 103` (-1 394). L'economie partagee
avec le deroulement de transfert a ete retirees pour le meme motif
d'equilibre deployment / execution.

**Correctness.** Trois multiplications, trois divisions, trois `require`,
trois affectations. L'ordre et les operandes sont inchanges.

### Pool.sol — `addLiquidity` (branche `supply == 0`) : pas d'optimisation

**Mesure.** `addLiquidity pool vide : 230 438 → 230 429` (-9). La
variation de 9 gas est dans la tolerance de mesure, pas un gain reel.
Aucun changement de code n'a ete applique sur cette branche : le packing
de reserves du jalon 4 (passage a `_setReserves` unique) etait deja
optimal.

### MrnFaucet.sol — `drip` : cache de `lastDripAt[msg.sender]`

**Justification.** Le calcul `nextAllowedAt = lastDripAt[msg.sender] +
dripInterval` etait suivi immediatement par l'affectation
`lastDripAt[msg.sender] = block.timestamp`, ce qui produisait 2 SLOAD du
meme slot (la 1re obligatoire, la 2e SSTORE donc implicitement une SLOAD
du nouveau slot par l'EVM). En mettant le 1re SLOAD en cache dans une
locale `lastDrip`, la 2e operation sur le slot est un SSTORE pur
(sans SLOAD prealable sur la valeur a ecraser).

**Alternative ecartee :** court-circuiter le SSTORE quand `lastDrip == 0`
(premier drip d'une adresse, le SSTORE est alors un cold SSTORE).
L'economie n'est realisable qu'au premier appel par adresse, pas dans le
cas general, et ajoute une branche conditionnelle sur le chemin chaud.

**Mesure.** Le banc de gaz ne couvre pas `drip()`. La reduction observee
en calcul EVM est de 1 SLOAD (~100 gas, mais cold / warm dependant du
contexte) + 1 ADD memoire-memoire (~3 gas). Estimation ~100 gas par
appel, non mesure directement.

**Correctness.** `lastDrip` est une locale qui n'est reecrite qu'apres
les deux `require` qui sont les seuls chemins de revert. Le SSTORE final
ecrit la valeur de `block.timestamp`, identique au comportement d'origine.
Le `TooEarly` emporte la valeur `lastDrip + dripInterval`, pas la
formule `nextAllowedAt` cachee, donc l'ABI d'erreur reste inchangee.

### Auction.sol — `placeBid` : cache de `currentEpoch() + 1` et de la borne de fenetre

**Justification.** `currentEpoch() + 1` etait calcule deux fois : une
fois dans la comparaison `if (sellingEpoch != currentEpoch() + 1)` et
une fois dans l'affectation `sellingEpoch = currentEpoch() + 1`. La
division par `epochDuration` etait repetee. Mise en cache dans `nextEpoch`.
Meme logique pour la borne haute de la fenetre
`startOfEpoch(sellingEpoch - 1) + auctionWindow` : le calcul etait
inline dans le `require`, et la locale `closesAt_` le rend explicite et
lisible.

**Alternative ecartee :** laisser les deux expressions inline. Le cout
identique en execution (les calculs sont purs, le compilateur les fold
deja), mais la lecture est plus claire avec une locale, et le risque
d'inconsistance entre les deux endroits qui utilisent la borne
(disponible dans `windowOpen` et `closesAt` egalement) est elimine par
construction.

**Mesure.** Le banc de gaz ne couvre pas `placeBid`. La reduction observee
en calcul EVM est de 1 DIV (~5 gas, mais 5 fois par encherissement) +
1 multiplication (sellingEpoch * epochDuration, ~5 gas) + 1 ADD. Estimation
~15 gas par appel, non mesure directement.

**Correctness.** `nextEpoch` et `closesAt_` sont des locales non
reecrites. Les deux branches du `if` et le `require` utilisent les memes
valeurs que l'original.

### Synthese des optimisations non retenues

**Boucles de transfert dans `addLiquidity` / `removeLiquidity`.** Le
deroulement explicite en 3 `safeTransfer(From)` lineaires economise
~600 gas par appel (elimination de 3 sauts de boucle, 3 lectures
d'index via la chaine if-else, 3 increments de compteur). Mais il
pese ~600 octets de bytecode, soit ~130 000 gas de deploiement. Le
trade-off ne devient favorable qu'au-dela de ~220 appels de chaque
fonction. Pour un projet a soutenance, ce seuil est inatteignable en
demo. **Le deroulement a ete teste, mesure, puis reverte** pour cette
raison. Les chiffres au jalon 4 (avec deroulement) ne sont pas reportes
ici ; le snapshot a ete repris sans.

**Ajout d'une fonction publique `getReserves()` dans Pool.** L'Auction
appelle `pool.reserves(0/1/2)` dans `_settle` (3 appels externes ~= 7 800
gas warm). Une fonction de batch reduirait ce cout a ~2 600 gas. Mais
cette optimisation cree une nouvelle API publique, ce que le brief
interdit explicitement.

**`unchecked` sur `rentRate * delta` dans `notifyRent`.** La
multiplication peut overflow si `amount > type(uint128).max`, et le
brief n'autorise pas de supposer une borne superieure sur les rentrees
de loyer. Le check est preserve.

### Tableau final

| Scénario | Gaz | Δ jalon 4 | % gain |
|---|---|---|---|
| `addLiquidity` — pool vide | 230 429 | -9 | -0,00 % |
| `addLiquidity` — pool amorcé | 102 240 | -2 058 | -1,97 % |
| `addLiquidity` — pool déséquilibré | 102 240 | -2 058 | -1,97 % |
| `removeLiquidity` — partiel | 86 991 | -1 394 | -1,58 % |
| `removeLiquidity` — total | 82 103 | -1 394 | -1,67 % |
| `swap` — pool équilibré | 104 715 | -718 | -0,68 % |
| `swap` — pool déséquilibré | 65 152 | -729 | -1,11 % |
| `setFee` | 15 987 | 0 | 0 % |

**Coût de déploiement Pool : 2 529 238 gas** (delta `+91 032` vs jalon 4,
`+3,7 %`). Bytecode 10 945 octets (delta `+423`). Voir le trade-off en
tete de section.

### Lecture de procédure

Les optimizations `MrnFaucet.drip` et `Auction.placeBid` ne sont pas
couvertes par le banc de gaz (le fichier `Pool.gas.t.sol` ne declenche
que les fonctions de `Pool.sol`). Les estimations inline sont
theoriques et n'ont pas ete mesurees sur Hardhat 3. Si un jury
interroge sur le gaz de l'enchere ou du faucet, les chiffres sont a
prendre comme des ordres de grandeur, pas comme des releves.


