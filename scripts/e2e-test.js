#!/usr/bin/env node
/**
 * E2E test — full system verification in one process (v3.1 dual-panel):
 *   mocks (3x-ui :3030, Telegram :3031, HMPanel :3032) + production standalone server
 *
 * Covers: login, BOTH panels configured simultaneously, per-panel connection tests,
 * one cycle → TWO full backups (3x-ui db + HMPanel archive) both sent to Telegram,
 * panel independence (HM failure doesn't block 3x-ui), auto scheduler tick for both
 * panels, status API, legacy v3.0 migration, RSS resource check.
 */
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const zlib = require("node:zlib");
const path = require("node:path");

const ROOT = require("path").resolve(__dirname, "..");
const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_DIR = path.join(ROOT, "scripts/mock-tg-received");
const DB = `file:${ROOT}/db/custom-e2e.db`;
fs.mkdirSync(path.join(ROOT, ".zscripts"), { recursive: true });

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✔ PASS" : "✘ FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
function start(cmd, args, logFile, env = {}) {
  const out = fs.openSync(logFile, "a");
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB, ...env },
    stdio: ["ignore", out, out],
    detached: false,
  });
  kids.push(p);
  return p;
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body && !(body instanceof Buffer) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  let data = null;
  try { data = await res.json(); } catch { /* html */ }
  return { status: res.status, data, setCookie };
}

async function waitHealthy(proc, label, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`${label} exited early (code ${proc.exitCode})`);
    try {
      const r = await fetch(`${BASE}/api/auth/state`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} not healthy after ${timeoutMs}ms`);
}

function tgFiles() {
  return fs.existsSync(TG_DIR) ? fs.readdirSync(TG_DIR).filter((f) => !f.startsWith(".")) : [];
}

function rssOf(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return parseInt(s.match(/VmRSS:\s+(\d+) kB/)[1], 10);
  } catch { return -1; }
}

(async () => {
  console.log("══════════ E2E: bkup (dual panel) ══════════");
  fs.rmSync(path.join(ROOT, "db/custom-e2e.db"), { force: true });
  fs.rmSync(TG_DIR, { recursive: true, force: true });
  fs.mkdirSync(TG_DIR, { recursive: true });
  execSync("npx prisma db push --accept-data-loss --skip-generate", { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB }, stdio: "pipe" });
  console.log("• fresh DB ready");

  // ── start services ──
  start("node", ["scripts/mock-panel.js"], path.join(ROOT, ".zscripts/e2e-mocks.log"));
  start("node", ["scripts/mock-telegram.js"], path.join(ROOT, ".zscripts/e2e-mocks.log"));
  start("node", ["scripts/mock-hmpanel.js"], path.join(ROOT, ".zscripts/e2e-mocks.log"));
  start("node", ["scripts/mock-pasarguard.js"], path.join(ROOT, ".zscripts/e2e-mocks.log"));
  const server = start("node", [".next/standalone/server.js"], path.join(ROOT, ".zscripts/e2e-server.log"), {
    PORT: String(PORT), NODE_ENV: "production",
  });
  await waitHealthy(server, "app server");
  console.log(`• app up on :${PORT} (pid ${server.pid})`);

  // ── auth ──
  let r = await api("POST", "/api/auth/login", { password: "admin123", setup: true });
  check("first-time login (setup)", r.status === 200, `status=${r.status}`);
  const cookie = (r.setCookie || "").split(";")[0];
  const H = { Cookie: cookie };

  // ══ PART 1: legacy v3.0 migration (panelType=hmpanel + shared panel fields) ══
  r = await api("PUT", "/api/config", {
    panelType: "hmpanel",
    panelUrl: "http://127.0.0.1:3032",
    panelUsername: "admin",
    panelPassword: "hm-secret-123",
  }, H);
  r = await api("GET", "/api/config", null, H);
  check("v3.0 → v3.1 auto-migration (hm fields populated, xui off)",
    r.data?.hmEnabled === true && r.data?.xuiEnabled === false && r.data?.hmUrl === "http://127.0.0.1:3032",
    `hmEnabled=${r.data?.hmEnabled} xuiEnabled=${r.data?.xuiEnabled}`);

  // ══ PART 2: ALL THREE panels configured — independent connections ══
  r = await api("PUT", "/api/config", {
    xuiEnabled: true,
    panelUrl: "http://127.0.0.1:3030",
    panelBasePath: "",
    panelUsername: "admin",
    panelPassword: "secret123",
    hmEnabled: true,
    hmUrl: "http://127.0.0.1:3032",
    hmUsername: "admin",
    hmPassword: "hm-secret-123",
    pgEnabled: true,
    pgUrl: "http://127.0.0.1:3033",
    pgUsername: "pasarguard-admin",
    pgPassword: "pg-secret-123",
    telegramApiBase: "http://127.0.0.1:3031",
    telegramBotToken: "12345:MOCK-TOKEN",
    telegramChatId: "555",
    intervalSeconds: 10,
  }, H);
  check("config saved: ALL THREE panels enabled",
    r.status === 200 && r.data?.xuiEnabled === true && r.data?.hmEnabled === true && r.data?.pgEnabled === true);

  r = await api("POST", "/api/config/test-panel", { panel: "3x-ui" }, H);
  check("3x-ui connection test (independent card)", r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 80));

  r = await api("POST", "/api/config/test-panel", { panel: "hmpanel" }, H);
  check("HMPanel connection test (independent card)", r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 80));

  r = await api("POST", "/api/config/test-panel", { panel: "pasarguard" }, H);
  check("PasarGuard connection test (independent card)", r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 100));

  r = await api("POST", "/api/config/test-telegram", {}, H);
  check("telegram test", r.status === 200 && r.data?.ok === true);

  r = await api("GET", "/api/status", null, H);
  check("status: all three panels ready",
    r.data?.panels?.xui?.ready === true && r.data?.panels?.hm?.ready === true && r.data?.panels?.pg?.ready === true,
    `xui=${JSON.stringify(r.data?.panels?.xui)} hm=${JSON.stringify(r.data?.panels?.hm)} pg=${JSON.stringify(r.data?.panels?.pg)}`);

  // ══ PART 3: ONE cycle → THREE full backups → ALL to Telegram ══
  r = await api("POST", "/api/backup/run", {}, H);
  const outs = r.data?.outcomes || [];
  const xuiOut = outs.find((o) => o.panel === "3x-ui");
  const hmOut = outs.find((o) => o.panel === "hmpanel");
  const pgOut = outs.find((o) => o.panel === "pasarguard");
  check("cycle ran all three panels", outs.length === 3, `outcomes=${outs.length}`);
  check("3x-ui full backup success (db file)", xuiOut?.status === "success" && xuiOut?.method === "db",
    `file=${xuiOut?.fileName} size=${xuiOut?.fileSize}B`);
  check("HMPanel full backup success (tar.gz)", hmOut?.status === "success" && hmOut?.method === "hm-full",
    `file=${hmOut?.fileName} size=${hmOut?.fileSize}B`);
  check("PasarGuard full backup success (tar.gz snapshot)", pgOut?.status === "success" && pgOut?.method === "pg-full",
    `file=${pgOut?.fileName} size=${pgOut?.fileSize}B`);
  check("ALL THREE files received in Telegram mock",
    xuiOut?.fileName && hmOut?.fileName && pgOut?.fileName &&
    tgFiles().includes(xuiOut.fileName) && tgFiles().includes(hmOut.fileName) && tgFiles().includes(pgOut.fileName),
    `tg files: ${tgFiles().length}`);
  const hmMagic = hmOut?.fileName ? Array.from(fs.readFileSync(path.join(TG_DIR, hmOut.fileName)).subarray(0, 2)) : [];
  check("HM archive is valid gzip (magic 1f8b)", hmMagic[0] === 0x1f && hmMagic[1] === 0x8b,
    `magic=${hmMagic.map((b) => b.toString(16)).join(" ")}`);
  const pgMagic = pgOut?.fileName ? Array.from(fs.readFileSync(path.join(TG_DIR, pgOut.fileName)).subarray(0, 2)) : [];
  check("PG archive is valid gzip (magic 1f8b)", pgMagic[0] === 0x1f && pgMagic[1] === 0x8b,
    `magic=${pgMagic.map((b) => b.toString(16)).join(" ")}`);
  // the PG snapshot must contain every section the real panel exposes
  const pgTar = pgOut?.fileName ? fs.readFileSync(path.join(TG_DIR, pgOut.fileName)) : null;
  const pgBody = pgTar ? zlib.gunzipSync(pgTar).toString("latin1") : "";
  check("PG snapshot contains users+hosts+nodes+groups+settings",
    pgBody.includes("users.json") && pgBody.includes("hosts.json") && pgBody.includes("nodes.json") &&
    pgBody.includes("groups.json") && pgBody.includes("settings.json") && pgBody.includes("manifest.json"),
    `sections found: ${(pgBody.match(/[a-z_]+\.json/g) || []).filter((v, i, a) => a.indexOf(v) === i).join(",")}`);
  check("3x-ui db backup non-empty", (xuiOut?.fileSize ?? 0) > 0, `${xuiOut?.fileSize}B`);

  // ══ PART 4: panel independence — HM+PG wrong creds must NOT block 3x-ui ══
  await api("PUT", "/api/config", { hmPassword: "WRONG", pgPassword: "WRONG" }, H);
  r = await api("POST", "/api/backup/run", {}, H);
  const outs2 = r.data?.outcomes || [];
  check("HM+PG wrong creds → both fail, 3x-ui still succeeds",
    outs2.find((o) => o.panel === "hmpanel")?.status === "failed" &&
    outs2.find((o) => o.panel === "pasarguard")?.status === "failed" &&
    outs2.find((o) => o.panel === "3x-ui")?.status === "success",
    outs2.map((o) => `${o.panel}:${o.status}`).join(" "));
  await api("PUT", "/api/config", { hmPassword: "hm-secret-123", pgPassword: "pg-secret-123" }, H);

  // ══ PART 5: auto scheduler — every tick backs up BOTH panels ══
  r = await api("PUT", "/api/config", { enabled: true, intervalSeconds: 10 }, H);
  check("scheduler enabled @10s", r.status === 200);
  let autoXui = null, autoHm = null, autoPg = null;
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    r = await api("GET", "/api/backups?page=1&pageSize=50", null, H);
    const rows = r.data?.items || r.data?.rows || r.data || [];
    const arr = Array.isArray(rows) ? rows : rows.items || [];
    autoXui = autoXui || arr.find((b) => b.trigger === "auto" && b.status === "success" && b.panel === "3x-ui");
    autoHm = autoHm || arr.find((b) => b.trigger === "auto" && b.status === "success" && b.panel === "hmpanel");
    autoPg = autoPg || arr.find((b) => b.trigger === "auto" && b.status === "success" && b.panel === "pasarguard");
    if (autoXui && autoHm && autoPg) break;
  }
  check("auto backup fired for ALL THREE panels", !!autoXui && !!autoHm && !!autoPg,
    `xui=#${autoXui?.id ?? "-"} hm=#${autoHm?.id ?? "-"} pg=#${autoPg?.id ?? "-"}`);

  r = await api("GET", "/api/status", null, H);
  check("status API reports hmpanel-ready + scheduler on", r.status === 200 && r.data?.panels?.anyReady === true && r.data?.scheduler?.enabled === true);

  await api("PUT", "/api/config", { enabled: false }, H);

  // ══ PART 6: resources ══
  await sleep(8000); // idle cooldown
  const rss1 = rssOf(server.pid);
  await sleep(8000);
  const rss2 = rssOf(server.pid);
  const rss = Math.max(rss1, rss2) / 1024;
  check("idle RSS ≤ 250 MB (resource-optimized)", rss > 0 && rss <= 250, `RSS≈${rss.toFixed(0)} MB (t1=${(rss1/1024).toFixed(0)}, t2=${(rss2/1024).toFixed(0)})`);

  // summary
  const fails = results.filter((x) => !x.ok);
  console.log("══════════════════════════════════════════════");
  console.log(`${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) { process.exitCode = 1; fails.forEach((f) => console.log(`  FAILED: ${f.name}`)); }
})().catch((e) => {
  console.error("E2E fatal:", e);
  process.exitCode = 1;
}).finally(() => {
  kids.forEach((p) => { try { p.kill("SIGTERM"); } catch {} });
  setTimeout(() => process.exit(process.exitCode || 0), 800);
});
