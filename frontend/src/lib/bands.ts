/**
 * Reserve bands — the front-end mirror of `Pool.sol`'s post-swap guard.
 *
 * `Pool.swap` ends with, for each token i:
 *
 *   uint256 sum = r0 + r1 + r2;                  // AFTER the swap
 *   require(r[i] * 100 <  ceiling * sum, CeilingTouched(i));
 *   require(r[i] * 100 >  floor   * sum, FloorTouched(i));
 *
 * with `floor = 13` and `ceiling = 53`, both `constant` and setter-less.
 *
 * That is the one class of revert the quote libraries cannot see at all: they
 * model the PRICING, this models a CONSTRAINT on the resulting state. A swap
 * can be priced perfectly and still revert on a band.
 *
 * Everything below reproduces the contract term for term. The point is not
 * merely to warn earlier — a front-end that mirrors the contract exactly is a
 * claim one can defend at review, where an approximation is a claim one has to
 * excuse.
 */

export type BandBreach = {
  /** Index of the token whose reserve left the band, matching the contract's argument. */
  index: number;
  kind: 'floor' | 'ceiling';
};

export type Reserves3 = readonly [bigint, bigint, bigint];

/**
 * Everything `Pool.swap` needs to know to decide how much of the input reaches
 * the reserves. Pricing uses the EFFECTIVE fee; funding uses the BASE fee, and
 * the two are not the same number.
 */
export type FeeRouting = {
  feeDen: bigint;
  /** `NOMINAL_FEE_NUM` — immutable, set in the constructor. */
  nominalFeeNum: bigint;
  /** `feeNum` — the manager's tariff for the epoch. */
  feeNum: bigint;
  /** `lastSetFeeEpoch == currentEpoch()` — whether that tariff is in force now. */
  feeSetThisEpoch: boolean;
  /** `manager() != address(0)` — whether a manager is in office. */
  hasManager: boolean;
  protocolFeeBps: bigint;
  splitDen: bigint;
};

/**
 * The post-swap guard, applied to reserves the caller has already advanced.
 *
 * Inequalities are strict in the contract, so the breach conditions are the
 * negations: `>= ceiling * sum` and `<= floor * sum`. Checks run per token in
 * contract order (ceiling before floor) so the reported index matches the
 * error the transaction would actually raise.
 *
 * Returns the first breach found, or null when every reserve sits inside.
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
 * The part of the input that actually reaches the reserves.
 *
 * `Pool.swap` books the fee cuts to pull-only registries instead of adding them
 * to the pool, so the reserves receive less than the user sent:
 *
 *   baseFee      = lastSetFeeEpoch == currentEpoch() ? feeNum : NOMINAL_FEE_NUM
 *   baseAmount   = _amount * baseFee / FEE_DEN
 *   protocolCut  = baseAmount * PROTOCOL_FEE_BPS / SPLIT_DEN
 *   managerCut   = manager() == address(0) ? 0 : baseAmount - protocolCut
 *   toReserves   = _amount - protocolCut - managerCut
 *
 * Two regimes follow. With no manager elected, only the 10 % protocol cut
 * leaves the pool. With a manager in office, the whole base fee does — the
 * manager's share is credited to his fee registry, not to the reserves.
 *
 * Integer division truncates in Solidity and BigInt division truncates too, so
 * the two agree without any rounding correction.
 */
export function amountToReserves(amountIn: bigint, r: FeeRouting): bigint {
  const baseFee = r.feeSetThisEpoch ? r.feeNum : r.nominalFeeNum;
  const baseAmount = (amountIn * baseFee) / r.feeDen;
  const protocolCut = (baseAmount * r.protocolFeeBps) / r.splitDen;
  const managerCut = r.hasManager ? baseAmount - protocolCut : 0n;
  return amountIn - protocolCut - managerCut;
}

/**
 * Reserves as they will stand once the swap lands.
 *
 * `amountOut` comes from the quote, which prices on `effectiveFeeNum` read from
 * the contract — so the output side is already exact and is subtracted as is.
 * Only the input side needed the routing above.
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
