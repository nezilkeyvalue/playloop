import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // sharp needs the Node runtime, never Edge. Individual routes also declare
  // `export const runtime = "nodejs"` — this is belt-and-suspenders.
  experimental: {
    serverComponentsExternalPackages: ["sharp"],
  },
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
