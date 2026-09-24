/**
 * Mock HMPanel API server — simulates neoauroraproject/hmpanel backend
 * (behind nginx with the /api prefix, exactly like a real install).
 *
 *   POST /api/auth/login                {username,password} -> { accessToken, refreshToken, admin }
 *   GET  /api/health                    (Bearer)            -> { status: "ok" }
 *   POST /api/backups                   (Bearer) {"type":"full"} -> { id, file, type, size }
 *   GET  /api/backups?limit=N           (Bearer)            -> [{ id, file, size, createdAt }] (newest first)
 *   GET  /api/backups/:id/download      (Bearer|?token=)    -> tar.gz bytes
 *   DELETE /api/backups/:id             (Bearer)            -> { deleted: true }
 *
 * Wrong credentials -> 401. Wrong/absent token on backups -> 401.
 * The generated "full backup" is a small gzip tarball with a manifest inside.
 *
 * ENV: HM_OLD_BACKUPS=<n> pre-seeds n OLD archives (the real panel keeps every
 * archive it ever made under /opt/hmpanel/backups/ and never deletes one — the
 * seeding reproduces that state so the cleanup path can be tested).
 */
const http = require("node:http");
const zlib = require("node:zlib");

const PORT = 3032;
const USER = "admin";
const PASS = "hm-secret-123";
const TOKEN = "HM-MOCK-ACCESS-TOKEN";

const backups = new Map(); // id -> Buffer
const meta = new Map(); // id -> { createdAt, size, type }
let counter = 0;

function archiveId(type, when) {
  const stamp = new Date(when).toISOString().replace(/[:.]/g, "-");
  return `backup_${type}_${stamp}_${counter}.tar.gz`;
}

function store(id, buf, when, type = "full") {
  backups.set(id, buf);
  meta.set(id, { createdAt: new Date(when).toISOString(), size: buf.length, type });
}

// ── seed: archives left behind by earlier runs (the "disk fills up" state) ──
const SEED = Number(process.env.HM_OLD_BACKUPS || 0);
for (let i = SEED; i >= 1; i--) {
  counter += 1;
  const when = Date.now() - i * 3600 * 1000; // one per hour, older first
  store(archiveId("full", when), tarGzFake(), when);
}

function tarGzFake() {
  // build a tiny deterministic payload that looks like an archive
  const manifest = JSON.stringify({
    version: "2.2.7-mock",
    schemaVersion: "3",
    timestamp: new Date().toISOString(),
    type: "full",
    components: ["database", "config", "uploads"],
  });
  const fileData = Buffer.from(`MOCK-HMPANEL-FULL-BACKUP\n${manifest}\n`, "utf8");
  return zlib.gzipSync(fileData);
}

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function authOk(req, url) {
  const h = req.headers["authorization"] || "";
  if (h === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get("token") === TOKEN) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[MOCK-HM] ${req.method} ${url.pathname}`);

  // nginx strips /api — this mock keeps it, so clients must target /api/*
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const raw = await body(req);
    let creds = {};
    try { creds = JSON.parse(raw.toString("utf8") || "{}"); } catch { /* ignore */ }
    if (creds.username === USER && creds.password === PASS) {
      // REAL hmpanel returns **201** on successful login (NestJS @Post default,
      // no @HttpCode(200) in the official auth controller) — mirror that exactly
      // so the E2E suite exercises the same code path as a live panel.
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        accessToken: TOKEN,
        refreshToken: "HM-MOCK-REFRESH",
        admin: { id: "a1", username: USER, role: "SUPER_ADMIN", isOwner: true },
      }));
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "Unauthorized", statusCode: 401 }));
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    // REAL HMPanel: /api/health is UNAUTHENTICATED (verified against a live panel)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      version: "2.2.7-mock",
      mode: "COMMUNITY",
      timestamp: new Date().toISOString(),
      services: { api: "ok", database: "ok" },
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    if (!authOk(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Unauthorized", statusCode: 401 }));
    }
    const raw = await body(req);
    let type = "full";
    try { type = JSON.parse(raw.toString("utf8") || "{}").type || "full"; } catch { /* ignore */ }
    counter += 1;
    const now = Date.now();
    const id = archiveId(type, now);
    const buf = tarGzFake();
    store(id, buf, now, type);
    console.log(`[MOCK-HM] created ${id} (${buf.length} bytes)`);
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, file: id, type, size: buf.length }));
  }

  // list (newest first, like the real NestJS service)
  if (req.method === "GET" && url.pathname === "/api/backups") {
    if (!authOk(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Unauthorized", statusCode: 401 }));
    }
    const limit = Number(url.searchParams.get("limit") || 50);
    const rows = [...meta.entries()]
      .map(([id, m]) => ({ id, file: id, type: m.type, size: m.size, createdAt: m.createdAt }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(rows));
  }

  // delete one archive
  const del = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (req.method === "DELETE" && del) {
    if (!authOk(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Unauthorized", statusCode: 401 }));
    }
    const id = decodeURIComponent(del[1]);
    const had = backups.delete(id);
    meta.delete(id);
    console.log(`[MOCK-HM] deleted ${id} (existed: ${had})`);
    if (!had) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Backup file not found", statusCode: 404 }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ deleted: true, id }));
  }

  const dl = url.pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (req.method === "GET" && dl) {
    if (!authOk(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Unauthorized", statusCode: 401 }));
    }
    const id = decodeURIComponent(dl[1]);
    const buf = backups.get(id);
    if (!buf) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Backup file not found", statusCode: 404 }));
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${id}"`,
    });
    return res.end(buf);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Not found", statusCode: 404 }));
});

server.listen(PORT, () => console.log(`[MOCK-HM] HMPanel mock on http://127.0.0.1:${PORT}/api`));
