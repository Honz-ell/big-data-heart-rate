import type { NextConfig } from "next";

const deviceManagerOrigin =
  process.env.DEVICE_MANAGER_INTERNAL_URL ?? "http://127.0.0.1:8001";
const modelRegistryOrigin =
  process.env.MODEL_REGISTRY_INTERNAL_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["*.e2b.app"],
  async rewrites() {
    return [
      {
        source: "/api/device/:path*",
        destination: `${deviceManagerOrigin}/:path*`,
      },
      {
        source: "/api/registry/:path*",
        destination: `${modelRegistryOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
