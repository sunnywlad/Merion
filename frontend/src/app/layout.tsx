import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import Providers from "./providers";
import Header from "@/components/Header";

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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body
        className={`${plexSans.variable} ${plexMono.variable} min-h-full flex flex-col`}
      >
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
