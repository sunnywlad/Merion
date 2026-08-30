'use client';

import Reserves from '@/components/Reserves';

/**
 * Merion rail « Pool » — note d'inspiration §7 + §8.
 *
 * Toujours déplié (cf. demande) : le titre « Pool » + le panneau de
 * réserves complet affiché en permanence juste en dessous.
 */
export default function PoolRail() {
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-h4 font-medium text-cloud">Pool</h2>
      <Reserves />
    </section>
  );
}
