import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

// IBM_Plex_Mono n'existe pas en fonte variable, le poids est obligatoire.
// 400 = données courantes, 500 = valeurs mises en avant dans les tableaux.
const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Merion",
  description: "DeFi for wrapped BTC",
};

/**
 * Root layout — minimal, sans web3.
 *
 * Les `Providers` (wagmi + react-query + AppKit) et le `Navbar` (qui monte
 * `<appkit-button>`) sont wrappés par `app/(app)/layout.tsx`, pas ici.
 * Conséquence : la landing `app/(marketing)/page.tsx` ne charge ni wagmi,
 * ni AppKit, ni react-query — cf. plan perf-frontend §3, Étape C
 * (gain cible : ~127 KB gzip sur `/`).
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body
        className={`${plexSans.variable} ${plexMono.variable} min-h-full flex flex-col`}
      >
        {children}
      </body>
    </html>
  );
}
