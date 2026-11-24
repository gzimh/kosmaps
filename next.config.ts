import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // tiles live under a new versioned folder per export (tiles/<version>/...), so they never
        // change in place and can be cached for a year
        source: "/data/tiles/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // meta.json says which tile version to use, and the JSON layers are small: always revalidate
        source: "/data/:file*.json",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
