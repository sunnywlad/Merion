/**
 * Bandes de reserve — le miroir front du garde post-swap de `Pool.sol`.
 *
 * `Pool.swap` finit par, pour chaque token i :
 *
 *   uint256 sum = r0 + r1 + r2;                  // APRES le swap
 *   require(r[i] * 100 <  ceiling * sum, CeilingTouched(i));
 *   require(r[i] * 100 >  floor   * sum, FloorTouched(i));
 *
 * avec `floor = 13` et `ceiling = 53`, constants et sans setter.
 *
 * C'est le seul revert que les libs de devis ne voient pas : elles modelisent le PRIX,
 * ceci modelise une CONTRAINTE sur l'etat resultant. Un swap peut etre parfaitement
 * price et reverter quand meme sur une bande.
 *
 * Tout ce qui suit reproduit le contrat terme pour terme.
 */

export type BandBreach = {
  /** Index du token dont la reserve est sortie de la bande, comme l'argument du contrat. */
  index: number;
  kind: 'floor' | 'ceiling';
};

export type Reserves3 = readonly [bigint, bigint, bigint];

/**
 * Tout ce dont `Pool.swap` a besoin pour decider combien de l'entree atteint les reserves.
 * Le prix utilise la fee EFFECTIVE ; le financement utilise la fee de BASE. Nombres differents.
 */
export type FeeRouting = {
  feeDen: bigint;
  /** `NOMINAL_FEE_NUM` — immuable, fixe au constructeur. */
  nominalFeeNum: bigint;
  /** `feeNum` — le tarif du gestionnaire pour l'epoque. */
  feeNum: bigint;
  /** `lastSetFeeEpoch == currentEpoch()` — ce tarif est-il en vigueur maintenant. */
  feeSetThisEpoch: boolean;
  /** `manager() != address(0)` — un gestionnaire est-il en poste. */
  hasManager: boolean;
  protocolFeeBps: bigint;
  splitDen: bigint;
};

/**
 * Le garde post-swap, applique a des reserves deja avancees par l'appelant.
 *
 * Les inegalites sont strictes dans le contrat, donc les conditions de breche sont les
 * negations : `>= ceiling * sum` et `<= floor * sum`. Verif par token dans l'ordre du
 * contrat (ceiling avant floor) pour que l'index rapporte colle a l'erreur reelle.
 *
 * Rend la premiere breche trouvee, ou null si toutes les reserves sont dans la bande.
 */
export function breachedBand(
  reservesAfter: Reserves3,
  floorBps: bigint,
  ceilingBps: bigint,
): BandBreach | null {
  const sum = reservesAfter[0] + reservesAfter[1] + reservesAfter[2];
  if (sum === 0n) return null;

  for (let i = 0; i < 3; i++) {
    const scaled = reservesAfter[i] * 100n;
    if (scaled >= ceilingBps * sum) return { index: i, kind: 'ceiling' };
    if (scaled <= floorBps * sum) return { index: i, kind: 'floor' };
  }
  return null;
}

/**
 * La part de l'entree qui atteint reellement les reserves.
 *
 * `Pool.swap` verse les coupes de fee dans des registres pull-only au lieu de les ajouter
 * au pool, donc les reserves recoivent moins que ce que l'utilisateur a envoye :
 *
 *   baseFee      = lastSetFeeEpoch == currentEpoch() ? feeNum : NOMINAL_FEE_NUM
 *   baseAmount   = _amount * baseFee / FEE_DEN
 *   protocolCut  = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN
 *   managerCut   = manager() == address(0) ? 0 : baseAmount - protocolCut
 *   toReserves   = _amount - protocolCut - managerCut
 *
 * Deux regimes : sans gestionnaire elu, seule la coupe protocole de 10 % sort du pool.
 * Avec un gestionnaire, toute la fee de base sort ; sa part va dans son registre, pas aux reserves.
 *
 * La division entiere tronque en Solidity comme en BigInt : les deux concordent sans correction.
 */
export function amountToReserves(amountIn: bigint, r: FeeRouting): bigint {
  const baseFee = r.feeSetThisEpoch ? r.feeNum : r.nominalFeeNum;
  const baseAmount = (amountIn * baseFee) / r.feeDen;
  const protocolCut = (baseAmount * r.protocolFeeBps) / r.splitDen;
  const managerCut = r.hasManager ? baseAmount - protocolCut : 0n;
  return amountIn - protocolCut - managerCut;
}

/**
 * Les reserves telles qu'elles seront une fois le swap passe.
 *
 * `amountOut` vient du devis, price sur `effectiveFeeNum` lu au contrat : le cote sortie
 * est deja exact et se soustrait tel quel. Seul le cote entree exigeait le routage ci-dessus.
 */
export function reservesAfterSwap(
  reserves: Reserves3,
  indexIn: number,
  amountIn: bigint,
  routing: FeeRouting,
  indexOut: number,
  amountOut: bigint,
): Reserves3 {
  const next: [bigint, bigint, bigint] = [...reserves] as [bigint, bigint, bigint];
  next[indexIn] = reserves[indexIn] + amountToReserves(amountIn, routing);
  next[indexOut] = reserves[indexOut] - amountOut;
  return next;
}
