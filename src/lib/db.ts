import { PrismaClient } from '@prisma/client'

// ── Resource optimization ────────────────────────────────────────────────
// • Query logging is dev-only: `log:['query']` in production spams stdout
//   (journald I/O + CPU) on every single query.
// • The client is ALWAYS cached on globalThis so every module import
//   (API routes, scheduler, CLI bridge) shares ONE connection/pool instead
//   of spawning a new Prisma engine per module graph.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  // During Next.js production build, Prisma engine may not be available
  // (network failure to download binaries). Return a dummy that won't be
  // used at build time — API routes are force-dynamic and skip static generation.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return new Proxy({} as PrismaClient, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        // Return a dummy function that throws only if actually called during build
        return () => {
          throw new Error('PrismaClient used during build — should be dynamic');
        };
      },
    });
  }
  try {
    return new PrismaClient({
      log:
        process.env.NODE_ENV === 'production'
          ? ['error', 'warn']
          : ['query', 'error', 'warn'],
    });
  } catch (e) {
    // Fallback for build environments where Prisma engine is missing
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return new Proxy({} as PrismaClient, {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          return () => {
            throw new Error('PrismaClient used during build');
          };
        },
      });
    }
    throw e;
  }
}

let _db: PrismaClient | undefined = globalForPrisma.prisma;
if (!_db) {
  try {
    _db = createClient();
  } catch {
    // During build, create dummy
    _db = new Proxy({} as PrismaClient, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return () => {
          throw new Error('PrismaClient used during build');
        };
      },
    });
  }
  globalForPrisma.prisma = _db;
}

export const db = _db as PrismaClient
