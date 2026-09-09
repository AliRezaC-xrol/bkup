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
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['query', 'error', 'warn'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

globalForPrisma.prisma = db
