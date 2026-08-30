'use client';

/**
 * Web component `<appkit-button>` de Reown AppKit.
 *
 * Isolé dans sa propre feuille client pour que la coque server du Navbar
 * (cf. `Navbar.tsx`) puisse poser ce composant comme enfant direct de la
 * grille `1fr | auto | 1fr` (le bouton occupe la colonne de droite,
 * symétrique au logo). Les fragments React ne deviennent pas des
 * enfants de grille — chaque cellule doit être un nœud distinct.
 */
export default function AppkitButton() {
  return <appkit-button balance="hide" />;
}
