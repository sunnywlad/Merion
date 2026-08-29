'use client';

import { useEffect, useState } from 'react';
import { useBlockNumber, usePublicClient } from 'wagmi';

// I.5 — Le temps de la chaîne, pas du navigateur. Le décompte de l'enchère
// compare deux grandeurs de même domaine (`closesAt` est un timestamp de bloc,
// donc `now` doit l'être aussi), sinon le moindre décalage entre l'horloge
// du navigateur et celle du nœud fait apparaître « 0 min 00 s » alors que la
// fenêtre est encore ouverte.
//
// Source : timestamp du dernier bloc vu par `useBlockNumber`. Cette valeur
// avance à chaque bloc (~12 s sur Hardhat, ~2 s sur Base), pas à chaque
// seconde, mais c'est le bon domaine de comparaison. Le composant ajoute à
// ce `chainNow` l'écart de `Date.now()` depuis la lecture — c'est une
// translation, pas un changement de source.
//
// Tick seconde-par-seconde : un `setInterval(1000)` interne force un
// re-render entre deux blocs pour que la translation reste à jour. Sans lui,
// le décompte saute par paliers de bloc, ce qui rend la dernière minute de
// fenêtre inutilement saccadée.
//
// L'intervalle porte l'heure courante plutôt qu'un compteur dont personne ne
// lit la valeur : lire `Date.now()` dans le corps du rendu est un appel impur
// (react-hooks/purity), la translation se fait donc depuis cet état.
export function useChainNow(): bigint | null {
  const publicClient = usePublicClient();
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const [chainNow, setChainNow] = useState<bigint | null>(null);
  const [readAtMs, setReadAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (blockNumber === undefined || !publicClient) return;
    let cancelled = false;
    publicClient.getBlock({ blockNumber: BigInt(blockNumber) })
      .then((b) => {
        if (cancelled) return;
        setChainNow(BigInt(b.timestamp));
        setReadAtMs(Date.now());
      })
      .catch(() => { /* une lecture ratée ne fait pas crasher le panneau */ });
    return () => { cancelled = true; };
  }, [blockNumber, publicClient]);

  // Translation : on ajoute l'écart entre `Date.now()` et le moment de la
  // lecture pour lisser le tick à la seconde entre deux blocs. La source
  // reste le timestamp de bloc, jamais `Date.now()` seul.
  if (chainNow === null || readAtMs === null || nowMs === null) return null;
  const drifted = BigInt(Math.floor((nowMs - readAtMs) / 1000));
  return chainNow + (drifted > 0n ? drifted : 0n);
}
