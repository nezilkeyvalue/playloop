import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlayLoop — Make your brand playable in 60 seconds",
  description:
    "Paste a website URL. PlayLoop builds a playable game from your brand and products, ready to embed in one line.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
