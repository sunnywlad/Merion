'use client';

import { useUserBalances } from '@/hooks/useUserBalances';
import { useLpBalance } from '@/hooks/useLpBalance';
import { useReserves } from '@/hooks/useReserves';
import {tokensInfo} from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';

export default function Balances() {

  const { data, isLoading, error } = useUserBalances();

  const { data: dataLp, isLoading: isLoadingLp, error: errorLp } = useLpBalance();
  const { supply: supplyEntry, isLoading: isLoadingR, error: errorR } = useReserves();
  const supply = supplyEntry?.status === 'success' ? supplyEntry.result : undefined;

  // Derived from TWO reads, so it exists only once both have landed. Testing `supply` for
  // truthiness is deliberate here: 0n is exactly the case to exclude, an empty pool holds no
  // position to express. Result is in basis points, hence decimals={2} below.
  const sharePercent = dataLp !== undefined && supply
    ? dataLp * 10000n / supply
    : undefined;

  return (
    <div className='border rounded p-4'>
      <ul>
        {tokensInfo.map((token, i) => {
          const entry = data?.[i];
          return (
            <AmountLine
              key={token.name}
              label={`Votre montant de ${token.name}`}
              isLoading={isLoading}
              // Two error levels folded into one: the whole multicall may die, or this single
              // call may have failed while its siblings succeeded.
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
            />
          );
        })}

        <AmountLine
          label="Vos parts LP"
          isLoading={isLoadingLp}
          error={errorLp}
          value={dataLp}
        />

        <AmountLine
          label="Votre part du pool"
          isLoading={isLoadingLp || isLoadingR}
          error={errorLp ?? errorR}
          value={sharePercent}
          decimals={2}
          suffix=" %"
        />
      </ul>
    </div>
  )
}
