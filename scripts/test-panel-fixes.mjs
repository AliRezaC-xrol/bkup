#!/usr/bin/env node
/**
 * Regression tests for the panel-client fixes — the ones that can only be
 * proven against a live HTTP peer, so they run against this repo's own mocks.
 *
 *   #6  3x-ui getDb: an expired session answers 401. The status must reach the
 *       caller (`streamDownload` used to drop it, which made the "re-login once
 *       and retry" branch in backup-service dead code) and that exact retry
 *       must turn the failed download into a success. A panel that answers 200
 *       with a JSON error body must fail too — never be staged as a backup.
 *   #8  HMPanel: after a successful download the archive is DELETED from the
 *       panel host and older leftovers are pruned (the panel itself never
 *       deletes anything → /opt/hmpanel/backups/ filled the disk).
 *   PG  PasarGuard: users.json inside the snapshot must be VALID JSON (a real
 *       array). The old concatenated-objects form made the restore side skip
 *       the section silently and restore an empty panel.
 *
 * Also covers the custom-archive naming/detection change (#10) on the file
 * names the panels actually produce.
 *
 * Run:  node scripts/test-panel-fixes.mjs     (needs node_modules + prisma client)
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-build-panels");

let failures = 0;
function check(cond, msg, extra = "") {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""));
    failures++;
  }
}

// ---------------------------------------------------------------------------
// 0. compile the clients (same tsc the project uses)
// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      outDir: ".",
      rootDir: path.join(ROOT, "src"),
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      skipLibCheck: true,
      strict: true,
      esModuleInterop: true,
      baseUrl: path.join(ROOT, "src"),
      paths: { "@/*": ["./*"] },
    },
    include: [
      path.join(ROOT, "src/lib/panel-client.ts"),
      path.join(ROOT, "src/lib/hmpanel-client.ts"),
      path.join(ROOT, "src/lib/pasarguard-client.ts"),
      path.join(ROOT, "src/lib/reassembly.ts"),
      path.join(ROOT, "src/lib/restore-target-path.ts"),
    ],
  }, null, 2)
);
const tsc = spawnSync(
  process.execPath,
  [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")],
  { encoding: "utf8" }
);
if (tsc.status !== 0) {
  console.error("✗ tsc failed:\n" + tsc.stdout + tsc.stderr);
  process.exit(1);
}

// tsc does not rewrite the "@/…" alias at emit — point every emitted require at
// its sibling file (they all land in the same lib/ directory)
for (const file of fs.readdirSync(path.join(OUT, "lib"))) {
  if (!file.endsWith(".js")) continue;
  const p = path.join(OUT, "lib", file);
  const code = fs.readFileSync(p, "utf8").replace(/require\("@\/lib\/([\w.-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(p, code);
}

const lib = (name) => pathToFileURL(path.join(OUT, "lib", name)).href;
const { getDb, login, invalidateSession } = await import(lib("panel-client.js"));
const { hmFullBackup } = await import(lib("hmpanel-client.js"));
const { pgFullBackup } = await import(lib("pasarguard-client.js"));
const { detectPanel } = await import(lib("reassembly.js"));

// ---------------------------------------------------------------------------
// 1. start the mocks
// ---------------------------------------------------------------------------
const kids = [];
function startMock(script, env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, "scripts", script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(p);
  return p;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.end(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

async function waitPort(port, label, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} did not start on port ${port}`);
}

function stopAll() {
  for (const k of kids) {
    try { k.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bkup-panel-fix-"));

try {
  startMock("mock-panel.js");
  startMock("mock-hmpanel.js", { HM_OLD_BACKUPS: "5" }); // panel already holding old archives
  startMock("mock-pasarguard.js");
  await waitPort(3030, "3x-ui mock");
  await waitPort(3032, "HMPanel mock");
  await waitPort(3033, "PasarGuard mock");

  // -------------------------------------------------------------------------
  // #6 — 3x-ui getDb: status propagates, retry works
  // -------------------------------------------------------------------------
  console.log("\n== #6  3x-ui getDb: expired session → 401 → re-login → retry ==");
  const xui = {
    panelUrl: "http://127.0.0.1:3030",
    panelBasePath: "",
    panelUsername: "admin",
    panelPassword: "secret123",
    authMode: "session",
    apiToken: "",
    skipTlsVerify: false,
  };
  const stale = { cookie: "3x-ui=stale-cookie", flavor: "v3", loggedInAt: Date.now() };
  const first = await getDb(xui, stale, dir, "x-ui-stale.db");
  check(first.ok === false, "a dead session fails the download");
  check(first.status === 401, "…and the HTTP status (401) reaches the caller", `got ${first.status}`);

  // the EXACT retry backup-service performs
  let final = first;
  let retried = false;
  if (!final.ok && (final.status === 401 || final.status === 404)) {
    retried = true;
    invalidateSession();
    const relogin = await login(xui, true);
    if (relogin.ok) final = await getDb(xui, relogin.data, dir, "x-ui-stale.db");
  }
  check(retried, "the 401 branch of the retry is entered (it could never be entered before)");
  check(final.ok === true, "the retry re-logs in and the download succeeds", final.error);

  const head = final.ok ? fs.readFileSync(final.data.filePath).subarray(0, 15).toString("ascii") : "";
  check(head === "SQLite format 3", "the retried download is the panel's real database file");
  check(fs.existsSync(path.join(dir, "x-ui-stale.db")), "the file is on disk for the integrity gate");

  // wrong base path → 404 (the other status the retry keys off). The mock only
  // routes known paths, so an unknown prefix falls through to its 404 — a valid
  // session cookie is used to get past its auth gate first.
  const goodSession = { cookie: "3x-ui=mock-session-cookie-xyz", flavor: "v3", loggedInAt: Date.now() };
  const wrongBase = { ...xui, panelBasePath: "/nope" };
  const notFound = await getDb(wrongBase, goodSession, dir, "x-ui-404.db");
  check(notFound.status === 404, "a wrong base path reports 404 to the caller", `got ${notFound.status}`);
  check(notFound.ok === false, "…and the download is reported as failed");

  // 200 + JSON error body (a panel that answers 200 for a dead session)
  const jsonPage = { cookie: "3x-ui=expired-json", flavor: "v3", loggedInAt: Date.now() };
  const jsonRes = await getDb(xui, jsonPage, dir, "x-ui-jsonpage.db");
  check(jsonRes.ok === false, "a 200 answer carrying a JSON error body is NOT treated as a backup");
  check(/not logged in/.test(jsonRes.error || ""), "…and the panel's own message is reported", jsonRes.error);
  check(!fs.existsSync(path.join(dir, "x-ui-jsonpage.db")), "…and no error page is left behind on disk");

  // -------------------------------------------------------------------------
  // #8 — HMPanel: delete after download + prune older archives
  // -------------------------------------------------------------------------
  console.log("\n== #8  HMPanel: archive is removed from the panel host ==");
  const hm = {
    hmUrl: "http://127.0.0.1:3032",
    hmUsername: "admin",
    hmPassword: "hm-secret-123",
    skipTlsVerify: false,
  };
  const listRemote = async () => {
    const res = await fetch("http://127.0.0.1:3032/api/backups?limit=50", {
      headers: { Authorization: "Bearer HM-MOCK-ACCESS-TOKEN" },
    });
    return res.json();
  };
  const before = await listRemote();
  check(before.length === 5, "the panel host starts with 5 leftover archives", `got ${before.length}`);

  const hmRes = await hmFullBackup(hm, dir);
  check(hmRes.ok === true, "the HMPanel full backup is created and downloaded", hmRes.error);
  check(fs.statSync(hmRes.data.filePath).size > 0, "the downloaded archive is on disk");

  const after = await listRemote();
  const ids = after.map((b) => b.id);
  check(!ids.includes(hmRes.data.fileName), "the archive of THIS run was deleted from the panel host");
  check(after.length === 3, "older leftovers were pruned down to the newest 3", `left ${after.length}`);
  const newestThree = before.slice(0, 3).map((b) => b.id);
  check(newestThree.every((id) => ids.includes(id)), "the archives that survived are the NEWEST ones");

  // -------------------------------------------------------------------------
  // PG — users.json must be a valid JSON array
  // -------------------------------------------------------------------------
  console.log("\n== PasarGuard: users.json is valid JSON ==");
  const pg = {
    pgUrl: "http://127.0.0.1:3033",
    pgUsername: "pasarguard-admin",
    pgPassword: "pg-secret-123",
    skipTlsVerify: false,
  };
  const pgRes = await pgFullBackup(pg, dir);
  check(pgRes.ok === true, "the PasarGuard snapshot is created", pgRes.error);

  const tarList = spawnSync("tar", ["-tzf", pgRes.data.filePath], { encoding: "utf8" });
  const members = tarList.stdout.split("\n").filter(Boolean);
  check(members.includes("users.json"), "the archive carries users.json");
  check(members.includes("manifest.json"), "the archive carries manifest.json");

  const usersRaw = spawnSync("tar", ["-xzOf", pgRes.data.filePath, "users.json"], { encoding: "utf8" });
  let users = null;
  try { users = JSON.parse(usersRaw.stdout); } catch (e) { users = null; }
  check(Array.isArray(users), "users.json parses as JSON and IS an array (the restore side JSON.parses it)");
  check(Array.isArray(users) && users.length === 37, "every user of the panel is in it (37)", `got ${Array.isArray(users) ? users.length : "—"}`);
  check(Array.isArray(users) && users.every((u) => typeof u.username === "string"), "the entries are the panel's own user objects");
  check(!/\}\s*\{/.test(usersRaw.stdout.trim()), "the old concatenated-objects form is gone");

  const manifestRaw = spawnSync("tar", ["-xzOf", pgRes.data.filePath, "manifest.json"], { encoding: "utf8" });
  const manifest = JSON.parse(manifestRaw.stdout);
  check(manifest.usersTotal === 37, "the manifest reports the user count", String(manifest.usersTotal));
  check(manifest.panel === "PasarGuard", "the manifest identifies the panel");

  // -------------------------------------------------------------------------
  // #10 — the file names the panels really produce
  // -------------------------------------------------------------------------
  console.log("\n== #10  archive-name detection ==");
  check(detectPanel("bkup-custom_pasarguard_a1b2c3d4_2026-09-24T09-25-00-000Z.tar.gz") === "custom", "a new custom archive with a 'pasarguard' label stays custom");
  check(detectPanel("custom_rebecca_a1b2c3d4_2026-09-24T09-25-00-000Z.tar.gz") === "custom", "a pre-1.3.1 custom archive stays custom");
  check(detectPanel("pasarguard_full_2026-09-24T09-25-00.tar.gz") === "pasarguard", "a PasarGuard snapshot is still PasarGuard");
  check(detectPanel("backup_full_2026-09-24T09-25-00-000Z.tar.gz") === "hmpanel", "an HMPanel archive is still HMPanel");
  check(detectPanel("x-ui-backup-20260924-092500.db") === "3x-ui", "a 3x-ui database is still 3x-ui");
  check(detectPanel("rebecca-backup-20260924.rbbackup") === "rebecca", "a Rebecca export is still Rebecca");
} finally {
  stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "✔ all panel-client regression checks passed" : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
