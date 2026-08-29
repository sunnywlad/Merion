'use client';

import { createContext, useContext, useEffect, useState } from 'react';
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
//
// Étape 5 (plan §7) — Source unique. Avant, `useChainNow` était monté 5 fois
// par page `(app)` (AuctionBar direct, AuctionPanel, MandatePanel direct,
// MandatePanel via `useMandateTimeline`, AuctionBar via `useMandateTimeline`).
// En pratique, viem déduplique la promesse `getBlock` en vol, mais cette
// coalescence est timing-dépendante. Le `ChainNowProvider` posé dans
// `app/(app)/layout.tsx` garantit par construction qu'il n'y a qu'un seul
// `getBlock` par tick de bloc, indépendamment du nombre de composants
// montés. Le public `useChainNow()` reste un consumer de contexte, donc
// l'API publique ne change pas : même signature, même type de retour, même
// sémantique (null pendant la lecture initiale).

const ChainNowContext = createContext<bigint | null>(null);

export function ChainNowProvider({ children }: { children: React.ReactNode }) {
  const chainNow = useChainNowSource();
  return (
    <ChainNowContext.Provider value={chainNow}>
      {children}
    </ChainNowContext.Provider>
  );
}

// Cœur du calcul. Mounté **une seule fois** par le provider, donc le
// `getBlock` qui suit `useBlockNumber` n'est lancé qu'à un seul endroit de
// l'arbre, quel que soit le nombre de consumers. Tous les
// `useChainNow()` en aval lisent la valeur via le contexte.
function useChainNowSource(): bigint | null {
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

export function useChainNow(): bigint | null {
  return useContext(ChainNowContext);
}
