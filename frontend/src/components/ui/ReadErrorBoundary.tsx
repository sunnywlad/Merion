import type { ReactNode } from 'react';
import { collectReadErrors, type ReadSource } from '@/lib/readErrors';
import { AppStateBoundary } from '@/components/ui/AppStateBoundary';

/**
 * Merion ReadErrorBoundary — dédouble le pattern « collectReadErrors →
 * console.error → borne d'état » répété 5 fois dans le front (Swap,
 * AddLiquidity, RemoveLiquidity, MandatePanel, Balances) + 1× la variante
 * `ReadErrors` du panneau d'enchère.
 *
 * 1. Filtre les sources non-vides via `collectReadErrors`.
 * 2. Logge chaque source via `console.error('[Merion]', source.message, source.error)`.
 * 3. Rend l'`AppStateBoundary` (variante `error`) si non-vide, avec
 *    `cause` = message de la première erreur, sinon `children`.
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
  for (const r of failedReads) {
    console.error('[Merion]', r.message, r.error);
  }
  const msgs = failedReads.map((r) => r.message);
  const cause = failedReads.find((r) => r.error)?.error?.message ?? 'unknown';
  return (
    <AppStateBoundary
      state={{
        kind: 'error',
        title,
        description: description
          ? description(msgs)
          : `Unable to read the data. ${msgs.join('; ')}`,
        cause,
      }}
    />
  );
}
