'use client';

import {useReserves} from '@/hooks/useReserves';
import { tokensInfo } from '@/constants/addresses';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

export default function Reserves() {
  const { reserves, supply, isLoading, error } = useReserves();

  // II.2d — whole-request error short-circuits to the boundary. Per-entry
  // errors keep showing through AmountLine, where they belong.
  if (error) {
    console.error('[Merion] reserves read failed', error);
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read reserves',
          description: 'Unable to read the reserves.',
          cause: error.message,
        }}
      />
    );
  }

  // I.5 — Le tarif n'est plus affiché ici : `MandatePanel`, juste en dessous
  // dans la même colonne, porte la même valeur sous « Base fee in force »,
  // et il la donne par direction. Deux libellés pour un seul chiffre
  // se lisaient comme deux tarifs.
  return (
    <section className='min-w-0'>
      <h2 className='text-sm font-semibold pb-2'>Pool reserves</h2>
      <ul className='text-sm'>
        {tokensInfo.map((token, i) => {
          const entry = reserves?.[i];
          return (
            <AmountLine
              key={token.name}
              label={`${token.name} reserves`}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
            />
          );
        })}

        <AmountLine
          label="Total LP shares"
          isLoading={isLoading}
          error={error ?? supply?.error}
          value={supply?.status === 'success' ? supply.result : undefined}
        />
      </ul>
    </section>
  )
}
