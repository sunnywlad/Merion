/**
 * Coquille marketing — groupe `(marketing)` (pas de segment d'URL).
 *
 * Landing statique. Pas de `Providers` (pas de web3), pas de `Navbar` :
 * la page `/` ne charge ni wagmi, ni AppKit, ni react-query, ni le
 * composant web3 `appkit-button` — gain bundle ~127 KB gzip (cf. plan
 * perf-frontend §3, Étape C).
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
