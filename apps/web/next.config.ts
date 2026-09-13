import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@portal/config",
    "@portal/contracts",
    "@portal/observability",
  ],
};

export default nextConfig;
