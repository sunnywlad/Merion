'use client';

import {useReserves} from '@/hooks/useReserves';
import { useFeeNum } from '@/hooks/useFeeNum';
import { useConstants } from '@/hooks/useConstants';
import { tokensInfo } from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';

export default function Reserves() {
  const { reserves, supply, isLoading, error } = useReserves();

  const { data: feeNum, isLoading: isLoadingFee, error: errorFee } = useFeeNum();
  const { feeDen: feeDenEntry, isLoading: isLoadingDen, error: errorDen } = useConstants();
  const feeDen = feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;

  // Basis points, so decimals={2} below renders a percentage. `feeDen` is tested for truthiness
  // and not merely for definedness: a zero denominator would divide by zero, and the pool would
  // be broken anyway.
  const feePercent = feeNum !== undefined && feeDen
    ? feeNum * 10000n / feeDen
    : undefined;

  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Réserves du pool</h2>
      <ul className='text-sm'>
        {tokensInfo.map((token, i) => {
          const entry = reserves?.[i];
          return (
            <AmountLine
              key={token.name}
              label={`Réserves de ${token.name}`}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
            />
          );
        })}

        <AmountLine
          label="Total des parts LP"
          isLoading={isLoading}
          error={error ?? supply?.error}
          value={supply?.status === 'success' ? supply.result : undefined}
        />

        <AmountLine
          label="Frais de swap"
          isLoading={isLoadingFee || isLoadingDen}
          error={errorFee ?? errorDen ?? feeDenEntry?.error}
          value={feePercent}
          decimals={2}
          suffix=" %"
        />
      </ul>
    </section>
  )
}
