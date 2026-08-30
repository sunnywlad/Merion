import type { ReactNode } from 'react';
import { collectReadErrors, type ReadSource } from '@/lib/readErrors';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

/**
 * Merion ReadErrorBoundary — dédouble le pattern « collectReadErrors →
 * borne d'état » répété 5 fois dans le front (Swap,
 * AddLiquidity, RemoveLiquidity, MandatePanel, Balances) + 1× la variante
 * `ReadErrors` du panneau d'enchère.
 *
 * 1. Filtre les sources non-vides via `collectReadErrors`.
 * 2. Rend l'`AppStateBoundary` (variante `error`) si non-vide, sinon `children`.
 *
 * Rien n'est loggé en console : la borne affiche le libellé que l'appelant a
 * écrit, et le message viem sous-jacent ne remonte ni à l'écran ni aux outils
 * de développement.
 *
 * Le préfixe `_` n'est PAS posé : le composant est un export public de
 * l'UI, partagé par les 6 sites applicatifs.
 */
export type ReadErrorSource = ReadSource;

export function ReadErrorBoundary({
  sources,
  title,
  description,
  children,
}: {
  sources: ReadErrorSource[];
  title: string;
  description?: (msgs: string[]) => string;
  children: ReactNode;
}) {
  const failedReads = collectReadErrors(sources);
  if (failedReads.length === 0) return <>{children}</>;
  const msgs = failedReads.map((r) => r.message);
  return (
    <AppStateBoundary
      state={{
        kind: 'error',
        title,
        description: description
          ? description(msgs)
          : `Unable to read the data. ${msgs.join('; ')}`,
      }}
    />
  );
}
