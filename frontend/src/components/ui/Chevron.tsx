import type { CSSProperties } from 'react';

type ChevronProps = {
  /** Vrai : chevron pivote de 180° (deplie). */
  open?: boolean;
  /** Remplace le label ARIA (defaut « Toggle details »). */
  label?: string;
  className?: string;
};

/**
 * Merion chevron.
 *
 * Glyphe Neutral 12 px (`▾`), rotation de 200 ms sur `transform` seulement. Le
 * killswitch `prefers-reduced-motion` de `globals.css` annule la transition globalement.
 */
export function Chevron({
  open = false,
  label = 'Toggle details',
  className = '',
}: ChevronProps) {
  // Style statique suffisant : la rotation passe par `transform`, sans decalage de layout, et
  // l'attribut data-open garde l'etat visuel accessible via l'aria-expanded parent.
  const style: CSSProperties = {};
  return (
    <span
      role="img"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      className={`merion-chevron ${className}`}
      style={style}
    >
      ▾
    </span>
  );
}

export default Chevron;
