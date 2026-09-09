# ---------- deps ----------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

# ---------- builder ----------
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# build an empty template database with the final schema
RUN mkdir -p db && DATABASE_URL=file:/app/db/template.db bunx prisma db push --skip-generate
RUN bun run build

# ---------- runner ----------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Tehran \
    DATABASE_URL=file:/app/data/prod.db \
    BACKUP_DIR=/app/data/backups \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN mkdir -p /app/data/backups

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# template db + schema for first-boot initialization
COPY --from=builder /app/db/template.db /app/prisma/template.db
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
