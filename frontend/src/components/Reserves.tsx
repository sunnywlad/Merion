'use client';

import { useReserves } from '@/hooks/useReserves';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import AmountLine from '@/components/AmountLine';
import { formatAmount } from '@/components/ui/formatAmount';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';
import ReservesBar from '@/components/ReservesBar';

/**
 * Merion pool reserves — sous-section du rail « Pool » (cf. PoolRail).
 *
 * Lecture sur les mêmes hooks que la page `/pool`. La détection d'erreur
 * suit le motif de la voie C (§II.2d) : un échec global court-circuite
 * vers la borne d'état ; les erreurs par entrée restent visibles en
 * ligne via la ligne de montant de chaque token, où elles ont leur
 * place.
 *
 * Affichage : pour chaque token, une ligne avec `ReservesBar` (nom +
 * % à droite) suivie d'une ligne de montant à droite seule (sans
 * label à gauche). Les trois blocs sont espacés verticalement. Le
 * « Total LP shares » garde son label à gauche.
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

  const totalReserves = reserves
    ? reserves.reduce<bigint>((acc, v) => acc + v, 0n)
    : 0n;
  const shares = tokens.map((_token, i) => {
    const v = reserves?.[i];
    if (v === undefined || totalReserves === 0n) return 0;
    return Number((v * 10000n) / totalReserves) / 10000;
  });

  return (
    <section className="flex flex-col gap-3 min-w-0">
      <div className="flex flex-col gap-6">
        {tokens.map((token, i) => {
          const entry = entries?.[i];
          return (
            <div key={token.name} className="flex flex-col gap-1">
              <ReservesBar tokenSymbol={token.name} share={shares[i]} />
              <TokenAmountRow
                isLoading={isLoading}
                error={error ?? entry?.error}
                value={entry?.status === 'success' ? entry.result : undefined}
                unit={token.name}
              />
            </div>
          );
        })}
      </div>

      <AmountLine
        label="Total LP shares"
        isLoading={isLoading}
        error={error ?? supply?.error}
        value={supply?.status === 'success' ? supply.result : undefined}
        displayDecimals={4}
        tokenDecimals={8}
        unit="LP"
      />
    </section>
  );
}

type TokenAmountRowProps = {
  isLoading: boolean;
  error: Error | null | undefined;
  value: bigint | undefined;
  unit: string;
};

/**
 * Ligne de montant pour un token du pool — rail « Pool ».
 *
 * Reproduit la logique d'`AmountLine` (loading / read failed / `—` /
 * valeur formatée) mais avec une taille de police plus grande et sans
 * label à gauche : seul le chiffre et l'unité sont rendus, calés à
 * droite de la colonne. Cf. demande sur la lisibilité du rail.
 */
function TokenAmountRow({ isLoading, error, value, unit }: TokenAmountRowProps) {
  let content: string;
  let contentClass: string;
  if (isLoading) {
    content = 'Loading…';
    contentClass = 'text-cloud/60';
  } else if (error) {
    content = 'Read failed';
    contentClass = 'text-danger';
  } else if (value === undefined) {
    content = '—';
    contentClass = 'text-cloud/60';
  } else {
    content = formatAmount(value, { displayDecimals: 4, tokenDecimals: 8, grouping: 'none' });
    contentClass = 'text-cloud';
  }
  return (
    <p className="flex items-baseline justify-end gap-1.5 min-w-0 text-body-lg">
      <span className={`font-mono text-code-lg num-tabular ${contentClass}`}>
        {content}
      </span>
      <span className="font-mono text-code text-neutral">{unit}</span>
    </p>
  );
}
