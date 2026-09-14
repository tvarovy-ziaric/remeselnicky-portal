import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers() {
    return Promise.resolve([
      {
        headers: [{ key: "Cache-Control", value: "no-store" }],
        source: "/remeselnici/:path*",
      },
      {
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
        source: "/admin/:path*",
      },
    ]);
  },
  reactStrictMode: true,
  transpilePackages: [
    "@portal/config",
    "@portal/contracts",
    "@portal/domain",
    "@portal/observability",
  ],
};

export default nextConfig;
