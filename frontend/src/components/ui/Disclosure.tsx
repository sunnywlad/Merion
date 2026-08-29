'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

type DisclosureProps = {
  /**
   * Identifiant stable de la région — sert à la clé `localStorage` et au
   * lien `aria-controls` du trigger. Doit être unique par bloc
   * rétractable. Format suggéré : `<espace>-<rôle>`, ex. `rail-pool`,
   * `auction-bar`, `pool-remove-liquidity`.
   */
  id: string;
  /** État initial quand aucune entrée n'est trouvée en `localStorage`. */
  defaultOpen?: boolean;
  /**
   * Trigger rendu au-dessus du corps. Reçoit l'état `open` et un
   * `toggle()` — l'appelant les branche sur son bouton (chevron,
   * `aria-expanded`, etc.). Toujours visible.
   */
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  /** Corps affiché quand `open === true`. Plié à hauteur 0 sinon. */
  children: ReactNode;
  /** Classe optionnelle pour le wrapper retractable (utile pour le padding). */
  className?: string;
};

/**
 * Merion `Disclosure` — note d'inspiration §8 + §9, brief d'`etat.md` ligne 106.
 *
 * **Bug de mémoisation, leçon retenue** : un `useEffect` qui **écrit**
 * `localStorage` ne doit PAS s'exécuter sur le montage initial avec la
 * valeur de `open` capturée dans la closure du premier rendu. Sur le
 * premier mount, `open === defaultOpen` (false par défaut), et le corps
 * du WRITE écrirait alors `'closed'` *avant* que la branche READ n'ait
 * pu appliquer la valeur persistée. Symptôme observé : clic pour
 * ouvrir → full reload → `data-open` revient à `false` parce que la
 * clé `localStorage` a été écrasée à `'closed'` au montage.
 *
 * La parade : un seul `useEffect`, qui branche sur `hasRead` (un
 * `useRef`, pas un état, pour ne pas déclencher un re-render) :
 *   - Premier passage (`!hasRead.current`) → on lit `localStorage`,
 *     on appelle éventuellement `setOpen` pour restaurer, on marque
 *     `hasRead.current = true` et on `return` sans écrire.
 *   - Passages suivants (l'`open` ou l'`id` ont changé) → on persiste.
 *
 * Si `setOpen` est appelé dans la branche READ, React re-render et
 * l'effet re-tourne avec `hasRead.current = true` et la nouvelle
 * valeur de `open` dans la closure — la branche WRITE écrit alors la
 * valeur correcte. C'est précisément le point qui cassait avec deux
 * `useEffect` séparés : la branche WRITE voyait `open=false` dans sa
 * closure pendant le commit initial, avant que le `setOpen` de la
 * branche READ ne soit traité.
 *
 * Source de vérité pour l'état par défaut : note d'inspiration §8.
 */
export function Disclosure({
  id,
  defaultOpen = false,
  trigger,
  children,
  className = '',
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasRead = useRef(false);

  useEffect(() => {
    if (!hasRead.current) {
      hasRead.current = true;
      // Restauration depuis `localStorage` — intentionnel après
      // hydratation pour rester compatible SSR (`useState(defaultOpen)`
      // rend la même valeur côté serveur et premier rendu client).
      // `setOpen` dans l'effet est le pattern recommandé pour
      // synchroniser avec un système externe (le `localStorage`) sans
      // casser l'hydratation.
      /* eslint-disable react-hooks/set-state-in-effect */
      try {
        const saved = window.localStorage.getItem(storageKey(id));
        if (saved === 'open') setOpen(true);
        else if (saved === 'closed') setOpen(false);
        // toute autre valeur (corrompue, future) : defaultOpen reste.
      } catch {
        // localStorage indisponible : defaultOpen reste.
      }
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    // Passages suivants — l'état a vraiment bougé, on persiste.
    try {
      window.localStorage.setItem(storageKey(id), open ? 'open' : 'closed');
    } catch {
      // quota / mode privé / extension : silencieusement ignoré.
    }
  }, [id, open]);

  const toggle = () => setOpen((v) => !v);
  const bodyId = `disclosure-${id}`;

  return (
    <>
      {trigger(open, toggle)}
      <div
        id={bodyId}
        data-open={open ? 'true' : 'false'}
        className={`merion-retractable ${className}`}
        aria-hidden={!open}
      >
        <div className="merion-retractable-inner">{open ? children : null}</div> {/* enfants montés seulement à l'ouverture, plan §1 perf */}
      </div>
    </>
  );
}

function storageKey(id: string): string {
  return `merion:disclosure:${id}`;
}

export default Disclosure;
