import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // sharp needs the Node runtime, never Edge. Individual routes also declare
  // `export const runtime = "nodejs"` — this is belt-and-suspenders.
  //
  // playwright-core and @sparticuz/chromium are here for a different reason:
  // they resolve a real Chromium BINARY at runtime
  // (sparticuzChromium.executablePath() in lib/engine/extract/render.ts).
  // Bundling them rewrites the paths that lookup depends on, so the headless
  // render step — the last rung of the extraction ladder for SPA storefronts —
  // fails on Vercel while working locally. Dynamic `await import()` is not
  // enough on its own; the bundler still traces them.
  serverExternalPackages: ["sharp", "playwright-core", "@sparticuz/chromium"],
  async headers() {
    return [
      {
        // The hosted runtime page is loaded inside a cross-origin iframe by design.
        source: "/play/:path*",
        headers: [{ key: "X-Frame-Options", value: "ALLOWALL" }],
      },
    ];
  },
};

export default nextConfig;
