/**
 * Mock HMPanel API server — simulates neoauroraproject/hmpanel backend
 * (behind nginx with the /api prefix, exactly like a real install).
 *
 *   POST /api/auth/login                {username,password} -> { accessToken, refreshToken, admin }
 *   GET  /api/health                    (Bearer)            -> { status: "ok" }
 *   POST /api/backups                   (Bearer) {"type":"full"} -> { id, file, type, size }
 *   GET  /api/backups/:id/download      (Bearer|?token=)    -> tar.gz bytes
 *
 * Wrong credentials -> 401. Wrong/absent token on backups -> 401.
 * The generated "full backup" is a small gzip tarball with a manifest inside.
 */
const http = require("node:http");
const zlib = require("node:zlib");

const PORT = 3032;
const USER = "admin";
const PASS = "hm-secret-123";
const TOKEN = "HM-MOCK-ACCESS-TOKEN";

const backups = new Map(); // id -> Buffer
let counter = 0;

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
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `backup_${type}_${stamp}_${counter}.tar.gz`;
    const buf = tarGzFake();
    backups.set(id, buf);
    console.log(`[MOCK-HM] created ${id} (${buf.length} bytes)`);
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, file: id, type, size: buf.length }));
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
