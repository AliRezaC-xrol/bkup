/**
 * Mock PasarGuard API server — simulates the PasarGuard/panel backend
 * (FastAPI, /api/* paths, OAuth2 form login) exactly like a real install.
 *
 *   POST /api/admin/token        x-www-form-urlencoded -> 200 { access_token, token_type }
 *   GET  /api/system             (Bearer) -> { version, ... }
 *   GET  /api/settings|hosts|nodes|cores|groups|client_templates|admins
 *   GET  /api/users?offset&limit -> { users, total }
 *
 * Wrong credentials -> 401. Wrong/absent token -> 401.
 */
const http = require("node:http");

const PORT = 3033;
const USER = "pasarguard-admin";
const PASS = "pg-secret-123";
const TOKEN = "PG-MOCK-ACCESS-TOKEN";

const USERS = Array.from({ length: 37 }, (_, i) => ({
  username: `user_${i + 1}`,
  status: "active",
  used_traffic: i * 1024 * 1024,
  data_limit: 10 * 1024 * 1024 * 1024,
  proxy_settings: { type: "vless" },
}));

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function authOk(req) {
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[MOCK-PG] ${req.method} ${url.pathname}`);

  if (req.method === "POST" && url.pathname === "/api/admin/token") {
    const raw = await body(req);
    const params = new URLSearchParams(raw.toString("utf8"));
    if (params.get("username") === USER && params.get("password") === PASS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ access_token: TOKEN, token_type: "bearer" }));
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ detail: { message: "Incorrect username or password" } }));
  }

  if (!authOk(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ detail: "Not authenticated" }));
  }

  const json = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/api/system") {
    return json({
      version: "5.3.0-mock",
      mode: "release",
      total_user: USERS.length,
      active_user: USERS.length,
      mem_total: 4 * 1024 * 1024 * 1024,
      mem_used: 1 * 1024 * 1024 * 1024,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json({ general: { dashboard_language: "en", telegram: { enable: true } } });
  }
  if (req.method === "GET" && url.pathname === "/api/hosts") {
    return json([
      { id: 1, remark: "vless-direct", address: "example.com", port: 443, protocol: "vless" },
      { id: 2, remark: "vmess-cdn", address: "cdn.example.com", port: 2053, protocol: "vmess" },
    ]);
  }
  if (req.method === "GET" && url.pathname === "/api/nodes") {
    return json({ nodes: [{ id: 1, name: "tehran-node", address: "10.0.0.5", status: "connected" }], total: 1 });
  }
  if (req.method === "GET" && url.pathname === "/api/cores") {
    return json([{ id: 1, name: "xray-core", version: "25.x" }]);
  }
  if (req.method === "GET" && url.pathname === "/api/groups") {
    return json([{ id: 1, name: "default", inbounds_tags: ["vless-1"] }]);
  }
  if (req.method === "GET" && url.pathname === "/api/client_templates") {
    return json([{ id: 1, name: "default-template" }]);
  }
  if (req.method === "GET" && url.pathname === "/api/admins") {
    // superadmin-only in real installs — the mock grants it
    return json({ admins: [{ username: USER, role: "SUPER_ADMIN" }], total: 1 });
  }
  if (req.method === "GET" && url.pathname === "/api/users") {
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    return json({ users: USERS.slice(offset, offset + limit), total: USERS.length });
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ detail: "Not Found" }));
});

server.listen(PORT, () => console.log(`[MOCK-PG] PasarGuard mock on http://127.0.0.1:${PORT}/api`));
