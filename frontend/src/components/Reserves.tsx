'use client';

import { useReserves } from '@/hooks/useReserves';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import AmountLine from '@/components/AmountLine';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';
import ReservesBar from '@/components/ReservesBar';

/**
 * Merion pool reserves — sous-section du rail « Pool » (cf. PoolRail).
 *
 * Lecture sur les mêmes hooks que la page `/pool`. La détection d'erreur
 * suit le motif de la voie C (§II.2d) : un échec global court-circuite
 * vers la borne d'état ; les erreurs par entrée restent visibles en
 * ligne via `AmountLine`, où elles ont leur place.
 *
 * Affichage : barres relatives d'abord (la question « est-ce équilibré ? »),
 * tableau de valeurs absolues ensuite (les montants sous-jacents). Le
 * tout plafonne dans la colonne du rail.
 */
export default function Reserves() {
  const { reserves, entries, supply, isLoading, error } = useReserves();
  const { tokens } = useDeployedChainId();

  if (error) {
    return (
      <AppStateBoundary
        state={{
          kind: 'error',
          title: 'Could not read reserves',
          description: 'Unable to read the reserves.',
        }}
      />
    );
  }

  const allLoaded = reserves !== undefined;
  const totalReserves = allLoaded
    ? reserves!.reduce<bigint>((acc, v) => acc + v, 0n)
    : 0n;
  const shares = tokens.map((_token, i) => {
    const v = reserves?.[i];
    if (v === undefined || totalReserves === 0n) return 0;
    return Number((v * 10000n) / totalReserves) / 10000;
  });

  return (
    <section className="flex flex-col gap-3 min-w-0">
      <h3 className="text-h5 font-medium text-cloud/80">Pool reserves</h3>

      <div className="flex flex-col gap-2">
        {tokens.map((token, i) => (
          <ReservesBar
            key={token.name}
            tokenSymbol={token.name}
            share={shares[i]}
          />
        ))}
      </div>

      <ul className="border-t border-merion-blue/40 pt-2">
        {tokens.map((token, i) => {
          const entry = entries?.[i];
          return (
            <AmountLine
              key={token.name}
              label={`${token.name} reserves`}
              isLoading={isLoading}
              error={error ?? entry?.error}
              value={entry?.status === 'success' ? entry.result : undefined}
              displayDecimals={4}
              tokenDecimals={8}
              unit={token.name}
            />
          );
        })}

        <AmountLine
          label="Total LP shares"
          isLoading={isLoading}
          error={error ?? supply?.error}
          value={supply?.status === 'success' ? supply.result : undefined}
          displayDecimals={4}
          tokenDecimals={8}
          unit="LP"
        />
      </ul>
    </section>
  );
}
