'use client';

import { useEffect, useState } from 'react';

// I.5 — L'horloge locale du panneau : un tick par seconde, rendu en secondes
// Unix, du même type que les horodatages de la chaîne.
//
// LE POINT DE DESIGN : la valeur est RECALCULÉE depuis `Date.now()` à chaque
// tick, jamais incrémentée. Un compteur incrémenté dérive dès que l'intervalle
// est suspendu, ce qui arrive quand l'onglet passe en arrière-plan (les
// navigateurs bornent les timers) et, sous Next 16 avec `cacheComponents`,
// quand une route est masquée plutôt que démontée : le nettoyage de l'effet
// tourne, l'intervalle s'arrête, et les ticks manqués ne se rattrapent pas.
// Dérivée de l'heure murale, la valeur se corrige d'elle-même au retour.
//
// Le décompte affiché ne ment donc que d'une seconde, et aucune lecture de
// chaîne n'est déclenchée par un tick.
// Le premier rendu vaut `null`, et l'heure n'arrive qu'avec l'effet : rendu sur
// le serveur, `Date.now()` donnerait un instant différent de celui de
// l'hydratation, et React signalerait une divergence sur la ligne du décompte.
// L'effet se déclenche dans la foulée de l'hydratation, donc le `null` ne dure
// pas un rendu visible, mais il doit être traité par l'appelant.
export function useNow(intervalMs = 1000): bigint | null {
  const [now, setNow] = useState<bigint | null>(null);

  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
