'use client';

import {useReserves} from '@/hooks/useReserves';
import { tokensInfo } from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';

export default function Reserves() {
  const { reserves, supply, isLoading, error } = useReserves();

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
      </ul>
    </section>
  )
}
