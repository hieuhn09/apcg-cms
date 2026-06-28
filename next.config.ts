import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  // Lint is a CI concern, not a deploy gate — a lint hiccup must never block a
  // production build. Run `npm run lint` separately.
  eslint: { ignoreDuringBuilds: true },
  // The Central CMS has no reader site; the root is the admin panel.
  async redirects() {
    return [{ source: "/", destination: "/admin", permanent: false }];
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...(webpackConfig.resolve.alias ?? {}),
      "@payload-config": path.resolve(dirname, "./payload.config.ts"),
    };
    return webpackConfig;
  },
};

export default withPayload(config);
