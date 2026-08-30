'use client';

import { useReserves } from '@/hooks/useReserves';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import Reserves from '@/components/Reserves';

/**
 * Merion rail « Pool » — note d'inspiration §7 + §8.
 *
 * Toujours déplié (cf. demande) : le titre « Pool » + le résumé d'une
 * ligne lisent les réserves pour signaler l'état du pool, et le panneau
 * de réserves complet est affiché en permanence juste en dessous :
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
 * Pas de `pt-6` : le rail gauche ne contient plus que « Pool », donc le
 * titre s'aligne en haut du rail (cf. alignement des trois fenêtres).
 */
export default function PoolRail() {
  const { reserves } = useReserves();
  const { tokens } = useDeployedChainId();
  // Le résumé parle toujours de 3 actifs (BTC wrappé + 2) tant qu'on n'a
  // pas un tableau complet ; sans charger le contrat pour `paused`, le
  // signal de pause reste dans le panneau de réserves.
  const summary = (() => {
    if (!reserves) return `${tokens.length} assets`;
    const total = reserves.reduce<bigint>((acc, v) => acc + v, 0n);
    if (total === 0n) return `${tokens.length} assets`;
    const target = 1 / 3;
    const band = 0.04;
    const shares = reserves.map(
      (v) => Number((v * 10000n) / total) / 10000,
    );
    const balanced = shares.every((s) => Math.abs(s - target) <= band);
    return `${tokens.length} assets, ${balanced ? 'balanced' : 'off-band'}`;
  })();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-h4 font-medium text-cloud">Pool</h2>
        <span className="text-caption text-cloud/60 num-tabular">
          {summary}
        </span>
      </div>
      <Reserves />
    </section>
  );
}
