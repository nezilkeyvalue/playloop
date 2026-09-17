import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
// Headlines only (the `font-display` class) — Inter alone across every
// weight reads as generic/default-web-font-dull; a geometric display face
// gives titles some real character while body copy stays on the readable,
// neutral Inter.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Playloop — Make your brand playable in 60 seconds",
  description:
    "Paste a website URL. Playloop builds a playable game from your brand and products, ready to embed in one line.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
