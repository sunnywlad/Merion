/**
 * Coquille de la landing — groupe `(landing)` (pas de segment d'URL).
 *
 * Landing statique. Pas de `Providers` (pas de web3), pas de `Navbar` :
 * la page `/` ne charge ni wagmi, ni AppKit, ni react-query, ni le
 * composant web3 `appkit-button`.
 */
export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
