import type { NextConfig } from "next";
import fs from "node:fs";
import path from "path";

// Single source of truth for the app version: package.json.
// The value is inlined into the bundle at BUILD time, so the web panel ALWAYS
// shows the version of the code it is running — it can never drift from the
// release again (fixes "panel still shows the old version after update").
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")
) as { version: string };

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  output: "standalone",
  // Pin the tracing root to THIS project. Without it, Next.js hoists the
  // workspace root to any parent that has a package.json/lockfile — e.g. when
  // bkup is installed inside another JS project — which breaks the standalone
  // output (missing server.js) and can leak unrelated files into the build.
  outputFileTracingRoot: path.resolve(__dirname),
  // Same pinning for the Turbopack compiler (Next 16): without turbopack.root
  // the build fails outright when the project sits inside another workspace.
  turbopack: {
    root: path.resolve(__dirname),
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Resource/privacy optimization: no framework fingerprint header,
  // gzip compression stays enabled (default) for smaller HTTP payloads.
  poweredByHeader: false,
};

export default nextConfig;
