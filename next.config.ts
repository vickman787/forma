import type { NextConfig } from "next";
const config: NextConfig = {
  output: process.env.FORMA_STANDALONE === "true" ? "standalone" : undefined,
  outputFileTracingExcludes: {
    "/*": ["./.env*", "./.forma/**/*", "./build-pack/**/*", "./tests/**/*"],
  },
  serverExternalPackages: [
    "pg",
    "pdfkit",
    "sharp",
    "archiver",
    "ffmpeg-static",
  ],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
