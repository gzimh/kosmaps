import type { NextConfig } from "next";

// `KOSMAPS_EXPORT=1 next build` writes a static site to out/ for the macOS app (macos/build.sh).
// A static export can't set response headers, so the cache rules below are for `next start` only.
const staticExport = process.env.KOSMAPS_EXPORT === "1";

const nextConfig: NextConfig = staticExport
  ? { output: "export" }
  : {
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
