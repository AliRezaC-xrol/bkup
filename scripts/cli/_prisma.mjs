/**
 * Shared Prisma loader.
 *
 * A pre-built (standalone) install has NO <app>/node_modules — the client
 * lives inside .next/standalone/node_modules instead. Node's ESM resolver
 * ignores NODE_PATH, so a plain `import "@prisma/client"` failed with
 * ERR_MODULE_NOT_FOUND and made the installer die with "could not set
 * password". Resolve the real location explicitly.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "./_env.mjs";

async function loadPrisma() {
  try {
    return await import("@prisma/client");
  } catch {
    const bundled = path.join(
      APP_ROOT, ".next", "standalone", "node_modules", "@prisma", "client", "default.js",
    );
    const mod = await import(pathToFileURL(bundled).href);
    return mod.default ?? mod;
  }
}

export const { PrismaClient } = await loadPrisma();
