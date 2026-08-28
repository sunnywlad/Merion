'use client';

import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useReserves } from '@/hooks/useReserves';
import {MRN_DECIMALS, tokensInfo} from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

export default function Balances() {
  const { btcBalances, mrnBalance, refundBalance, isLoading, error } = useUserBalances();
  const { data: dataLp, isLoading: isLoadingLp, error: errorLp } = useLpBalance();
  const { supply: supplyEntry, isLoading: isLoadingR, error: errorR } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;

  // II.2d — same pattern as Reserves: whole-request error short-circuits to
  // the boundary, per-entry errors keep showing inline.
  if (error || errorLp || errorR) {
    const first = error ?? errorLp ?? errorR;
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read your balances',
          description: first?.message,
        }}
      />
    );
  }

  // Derived from TWO reads, so it exists only once both have landed. Testing `supply` for
  // truthiness is deliberate here: 0n is exactly the case to exclude, an empty pool holds no
  // position to express. Result is in basis points, hence decimals={2} below.
  const sharePercent = dataLp !== undefined && supply
    ? dataLp * 10000n / supply
    : undefined;

  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Your position</h2>
      <ul className='text-sm'>
        {tokensInfo.map((token, i) => {
          const entry = btcBalances[i];
          return (
            <AmountLine
              key={token.name}
              label={`Your ${token.name} balance`}
              isLoading={isLoading}
              // Two error levels folded into one: the whole multicall may die, or this single
              // call may have failed while its siblings succeeded.
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
            />
          );
        })}

        {/* MRN est libelle a 18 decimales (cf. addresses.ts MRN_DECIMALS), les
            BTCs a 8. AmountLine formate via `formatUnits` avec le decimals
            prop, donc chaque ligne passe son echelle. */}
        <AmountLine
          label="Your MRN balance"
          isLoading={isLoading}
          error={error ?? mrnBalance?.error}
          value={mrnBalance?.status === 'success' ? mrnBalance.result : undefined}
          decimals={MRN_DECIMALS}
        />

        <AmountLine
          label="Your refund to claim"
          isLoading={isLoading}
          error={error ?? refundBalance?.error}
          value={refundBalance?.status === 'success' ? refundBalance.result : undefined}
          decimals={MRN_DECIMALS}
        />

        <AmountLine
          label="Your LP shares"
          isLoading={isLoadingLp}
          error={errorLp}
          value={dataLp}
        />

        <AmountLine
          label="Your pool share"
          isLoading={isLoadingLp || isLoadingR}
          error={errorLp ?? errorR}
          value={sharePercent}
          decimals={2}
          suffix=" %"
        />
      </ul>
    </section>
  )
}
