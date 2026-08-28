'use client';

import { useReserves } from '@/hooks/useReserves';
import { tokensInfo } from '@/constants/addresses';
import Chevron from '@/components/ui/Chevron';
import Disclosure from '@/components/ui/Disclosure';
import Reserves from '@/components/Reserves';

/**
 * Merion rail « Pool » — note d'inspiration §7 + §8.
 *
 * Plié par défaut, dépliable via un bouton d'en-tête. Le résumé d'une
 * ligne lit les réserves pour signaler l'état du pool :
 *   - « 3 assets »                    (chargement / pool vide)
 *   - « 3 assets, balanced »          (chaque actif dans la bande ±4 pp)
 *   - « 3 assets, off-band »          (au moins un actif hors bande)
 *
 * La détection de pause n'est pas branchée ici : `useConstants` ne lit
 * pas le flag, et lire `paused` côté contrat ajouterait un multicall
 * pour une seule ligne. La décision est documentée dans le rapport de
 * tâche ; le panneau de réserves complet reste l'endroit pour voir la
 * pause.
 *
 * Le même chevron `▾` (12 px Neutral, rotation 180° à l'ouverture,
 * 200 ms ease-in-out) sert pour tous les blocs rétractables de l'app,
 * conformément à §8. L'état ouvert/fermé est mémorisé par le composant
 * `Disclosure` dans `localStorage` (clé `merion:disclosure:rail-pool`).
 */
export default function PoolRail() {
  const { reserves } = useReserves();
  // Le résumé parle toujours de 3 actifs (BTC wrappé + 2) tant qu'on n'a
  // pas un tableau complet ; sans charger le contrat pour `paused`, le
  // signal de pause reste dans le panneau de réserves.
  const summary = (() => {
    const values =
      reserves?.map((entry) =>
        entry?.status === 'success' ? entry.result : undefined,
      ) ?? [];
    if (values.length < tokensInfo.length) return `${tokensInfo.length} assets`;
    const defined = values.filter((v): v is bigint => v !== undefined);
    if (defined.length < tokensInfo.length) return `${tokensInfo.length} assets`;
    const total = defined.reduce<bigint>((acc, v) => acc + v, 0n);
    if (total === 0n) return `${tokensInfo.length} assets`;
    const target = 1 / 3;
    const band = 0.04;
    const shares = defined.map(
      (v) => Number((v * 10000n) / total) / 10000,
    );
    const balanced = shares.every((s) => Math.abs(s - target) <= band);
    return `${tokensInfo.length} assets, ${balanced ? 'balanced' : 'off-band'}`;
  })();

  return (
    <section className="flex flex-col gap-3 pt-6">
      <Disclosure
        id="rail-pool"
        defaultOpen={false}
        trigger={(open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="disclosure-rail-pool"
            className={
              `group flex items-center justify-between gap-3 text-left rounded ` +
              `transition-colors duration-150 ` +
              `hover:bg-cloud/5 ` +
              `focus:outline-none focus-visible:border-merion-blue focus-visible:border-2`
            }
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-h4 font-medium text-cloud">Pool</h2>
              <span className="text-caption text-cloud/60 num-tabular">
                {summary}
              </span>
            </div>
            <Chevron open={open} />
          </button>
        )}
      >
        <Reserves />
      </Disclosure>
    </section>
  );
}
