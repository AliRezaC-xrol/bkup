/**
 * Mock 3x-ui panel server — implements the verified v3 API flow:
 *   GET  /csrf-token                    -> { success, obj: token } + session cookie
 *   POST /login  (X-CSRF-Token header)  -> { success: true } + 3x-ui cookie
 *   GET  /panel/api/inbounds/list       -> { success, obj: [...] }
 *   POST /panel/setting/all             -> { success, obj: {...} }
 *   GET  /panel/api/server/getDb        -> binary db file
 */
const http = require("node:http");

const PORT = 3030;
const CSRF = "mock-csrf-token-123";
const V2_MODE = process.env.V2_MODE === "1"; // simulate old panel without CSRF
let dbCounter = 0;

const inboundSample = {
  id: 1,
  remark: "vless-reality-main",
  enable: true,
  port: 443,
  protocol: "vless",
  settings: JSON.stringify({ clients: [{ id: "uuid-1", email: "user1", flow: "xtls-rprx-vision" }] }),
  streamSettings: JSON.stringify({ network: "tcp", security: "reality", realitySettings: { dest: "www.google.com:443" } }),
  up: 1024000,
  down: 2048000,
  total: 0,
  expiryTime: 0,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const cookies = req.headers.cookie || "";

  console.log(`[MOCK-PANEL] ${req.method} ${path}`);

  if (path === "/csrf-token" && req.method === "GET") {
    if (V2_MODE) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, msg: "not found" }));
      return;
    }
    res.setHeader("Set-Cookie", "mocksession=abc123; Path=/");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, obj: CSRF }));
    return;
  }

  if (path === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!V2_MODE && req.headers["x-csrf-token"] !== CSRF) {
        res.writeHead(403);
        res.end("CSRF failed");
        return;
      }
      const data = JSON.parse(body || "{}");
      if (data.username === "admin" && data.password === "secret123") {
        res.setHeader("Set-Cookie", "3x-ui=mock-session-cookie-xyz; Path=/; HttpOnly");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, msg: "login success" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, msg: "wrong username or password" }));
      }
    });
    return;
  }

  // eslint-disable-next-line no-unreachable

  // everything below requires the session cookie
  if (!cookies.includes("3x-ui=mock-session-cookie-xyz")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, msg: "not logged in" }));
    return;
  }

  if (path === "/panel/api/inbounds/list" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, msg: "", obj: [inboundSample] }));
    return;
  }

  if (path === "/panel/setting/all" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        obj: { webListen: "", webPort: 2053, webBasePath: "/", timeLocation: "Asia/Tehran" },
      })
    );
    return;
  }

  if (path === "/panel/api/server/getDb" && req.method === "GET") {
    dbCounter++;
    // fake sqlite db: header + variable payload so sizes differ
    const payload = Buffer.alloc(4096 + dbCounter * 128, 0x41);
    const header = Buffer.from("SQLite format 3\0");
    header.copy(payload, 0);
    dbCounter % 20 === 0 && null; // keep counter moving
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="x-ui-backup-${Date.now()}.db"`,
    });
    res.end(payload);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, msg: "not found" }));
});

server.listen(PORT, () => console.log(`[MOCK-PANEL] listening on :${PORT}`));
