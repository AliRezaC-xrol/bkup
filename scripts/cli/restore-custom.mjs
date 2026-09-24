#!/usr/bin/env node
/**
 * CLI wizard: restore a CUSTOM-PATH backup onto a server over SSH.
 *
 * The wizard talks to the LOCAL bkup web service over loopback using the
 * shared CLI secret (.cli-secret), so the exact restore engine that powers
 * the web panel drives the terminal flow — the same target-path validation,
 * the same step pipeline (connect → check target → upload → extract →
 * verify), and the same English-only logs, which land in the web console
 * too.
 *
 * All output is English by design (v1.3.0 made logs English-only).
 */
import { APP_ROOT } from "./_env.mjs"; // side effect: loads .env (PORT, …)
import fs from "node:fs";
import readline from "node:readline";

const PORT = Number(process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

// ── terminal helpers ────────────────────────────────────────────────────────
const TTY = Boolean(process.stdout.isTTY);
const c = {
  g: (s) => (TTY ? `[32m${s}[0m` : s),
  r: (s) => (TTY ? `[31m${s}[0m` : s),
  y: (s) => (TTY ? `[33m${s}[0m` : s),
  d: (s) => (TTY ? `[2m${s}[0m` : s),
  b: (s) => (TTY ? `[1m${s}[0m` : s),
  c: (s) => (TTY ? `[36m${s}[0m` : s),
};
const okMark = c.g("OK");
const failMark = c.r("FAIL");
const runMark = c.c("..");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

/** Ask for a secret (password / passphrase) echoing only asterisks. */
function askSecret(query) {
  return new Promise((resolve) => {
    const writeToOutput = rl._writeToOutput.bind(rl);
    rl._writeToOutput = function (chunk) {
      // keep the prompt itself visible, mask only what the user types
      rl.output.write(chunk.includes(query) || chunk.trim() === "" ? chunk : "*");
    };
    rl.question(query, (ans) => {
      rl._writeToOutput = writeToOutput;
      rl.output.write("\n");
      resolve(ans.trim());
    });
  });
}

const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};
const fmtDate = (iso) => String(iso || "").replace("T", " ").slice(0, 16);
const fmtSecs = (ms) => `${Math.max(1, Math.round((ms || 0) / 1000))}s`;

// ── CLI-secret auth + HTTP plumbing ─────────────────────────────────────────
function readCliSecret() {
  if (process.env.CLI_SECRET) return process.env.CLI_SECRET.trim();
  for (const p of [`${APP_ROOT}/.cli-secret`, "/opt/auto-backup-xui/.cli-secret"]) {
    try {
      const s = fs.readFileSync(p, "utf8").trim();
      if (s.length >= 16) return s;
    } catch { /* try the next candidate */ }
  }
  return "";
}

const SECRET = readCliSecret();
if (!SECRET) {
  console.error(c.r("✗ The CLI secret (.cli-secret) was not found — re-run the installer or check the install directory."));
  process.exit(1);
}

async function api(method, urlPath, body) {
  let res;
  try {
    res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        "X-CLI-Secret": SECRET,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    if (e?.cause?.code === "ECONNREFUSED" || String(e).includes("fetch failed")) {
      throw new Error("SERVICE_DOWN");
    }
    throw e;
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  return { status: res.status, json: json || {} };
}

function fatalApi(e) {
  if (e?.message === "SERVICE_DOWN") {
    console.error(c.r("✗ The bkup web service is not running — start it first (bkup menu → item 8)."));
  } else if (e?.message === "UNAUTHORIZED") {
    console.error(c.r("✗ The CLI secret was rejected by the service — the .cli-secret file and the running install are out of sync."));
  } else {
    console.error(c.r(`✗ Request failed: ${e?.message || e}`));
  }
  process.exit(1);
}

// ── target path validation (mirrors src/lib/restore-target-path.ts) ─────────
const REFUSED_ROOTS = ["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var"];
const TARGET_ERR = {
  TARGET_PATH_REQUIRED: "A target path is required",
  TARGET_PATH_MUST_BE_ABSOLUTE: "The target path must be absolute (start with /)",
  TARGET_PATH_NO_DOTDOT: 'The target path must not contain ".." segments',
  TARGET_PATH_INVALID_CHARS: "The target path contains unsupported characters",
  TARGET_PATH_REFUSED: "That system directory cannot be used as a restore target",
  TARGET_PATH_TOO_BROAD: "The target path is too broad — use at least two levels, e.g. /opt/myapp",
};
function validateTargetPath(candidate) {
  const t = String(candidate || "").trim();
  if (!t) return "TARGET_PATH_REQUIRED";
  if (!t.startsWith("/")) return "TARGET_PATH_MUST_BE_ABSOLUTE";
  if (/\.\./.test(t)) return "TARGET_PATH_NO_DOTDOT";
  if (/[^A-Za-z0-9 ._+\-/]/.test(t)) return "TARGET_PATH_INVALID_CHARS";
  const norm = t === "/" ? "/" : t.replace(/\/+$/, "");
  if (REFUSED_ROOTS.includes(norm)) return "TARGET_PATH_REFUSED";
  if (norm.split("/").filter(Boolean).length < 2) return "TARGET_PATH_TOO_BROAD";
  return null;
}

// friendly messages for the server-side start-restore errors
const START_ERR = {
  RESTORE_ALREADY_RUNNING: "Another restore job is already running",
  BACKUP_NOT_FOUND: "The selected backup no longer exists",
  BACKUP_FILE_MISSING: "The backup file is missing on disk",
  NOT_A_CUSTOM_BACKUP: "The selected backup is not a custom-path backup",
  SSH_HOST_REQUIRED: "An SSH host is required",
  SSH_USER_REQUIRED: "An SSH username is required",
  AUTH_REQUIRED: "An SSH password or private key is required",
  INVALID_PORT: "The SSH port is invalid",
  ...TARGET_ERR,
};
const startErrText = (code) => START_ERR[code] || `The restore could not be started (${code})`;

// ── live watch: render every step transition as it happens ──────────────────
async function watchRestore() {
  const seen = new Map(); // stepKey -> rendered "status|detail"
  const icon = { done: okMark, failed: failMark, running: runMark, pending: "  ", skipped: c.d("skip") };
  let announced = false;
  console.log(c.d("  watching… (press c + Enter to cancel, Ctrl+C to stop watching)"));

  const onLine = async (line) => {
    if (line.trim().toLowerCase() === "c") {
      const conf = await ask(c.y("  Cancel the running restore? [y/N]: "));
      if (conf.toLowerCase() === "y") {
        try { await api("POST", "/api/restore/cancel"); console.log(c.y("  cancellation requested…")); }
        catch (e) { console.log(c.r(`  cancel request failed: ${e?.message || e}`)); }
      }
    }
  };
  rl.on("line", onLine);
  const onSigint = () => console.log(c.d("  (still watching — type c + Enter to cancel the restore, or Ctrl+C again to exit)"));
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      let st;
      try {
        st = (await api("GET", "/api/restore/status")).json;
      } catch (e) {
        if (e?.message === "SERVICE_DOWN") fatalApi(e);
        throw e;
      }
      if (!st || st.status === "idle") {
        console.log(c.d("  no restore state found — the job may have finished before watching began"));
        return 1;
      }
      if (!announced) {
        announced = true;
        console.log(`  restore of ${c.b(st.backupName || "?")} → ${c.b(st.sshHost || "?")}`);
      }
      for (const s of st.steps || []) {
        const sig = `${s.status}|${s.detail || ""}|${s.error || ""}`;
        if (seen.get(s.key) === sig) continue;
        seen.set(s.key, sig);
        if (s.status === "pending") continue;
        const extra = s.error ? ` — ${s.error}` : s.detail ? ` — ${s.detail}` : "";
        console.log(`  [${icon[s.status] || "  "}] ${s.title}${extra}`);
      }
      if (st.status === "success") {
        console.log(`\n${c.g("✔")} restore completed successfully in ${fmtSecs(st.durationMs)}.`);
        return 0;
      }
      if (st.status === "failed" || st.status === "cancelled") {
        const head = st.status === "cancelled" ? c.y("- restore cancelled") : c.r("✗ restore FAILED");
        console.log(`\n${head}`);
        // multi-line remote errors are printed line by line — that detail is
        // exactly what is needed to fix a permission/path problem on the target
        for (const ln of String(st.error || "unknown error").split(/\r?\n/)) {
          if (ln.trim()) console.log(`  ${ln}`);
        }
        return 1;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    rl.removeListener("line", onLine);
    process.removeListener("SIGINT", onSigint);
  }
}

// ── main wizard ─────────────────────────────────────────────────────────────
async function main() {
  // non-interactive conveniences: --cancel / --watch
  const arg = process.argv[2] || "";
  if (arg === "--cancel") {
    try { await api("POST", "/api/restore/cancel"); console.log("Cancellation requested."); return 0; }
    catch (e) { fatalApi(e); }
  }
  if (arg === "--watch") return await watchRestore();

  if (!process.stdin.isTTY) {
    console.error("This wizard is interactive — run `bkup` in a terminal on the server.");
    return 1;
  }

  console.log(c.b("\nRestore a custom-path backup over SSH"));

  // already running? offer watch / cancel
  let status;
  try { status = (await api("GET", "/api/restore/status")).json; } catch (e) { fatalApi(e); }
  if (status && status.status === "running") {
    console.log(c.y(`! A restore is already running: ${status.backupName} → ${status.sshHost}`));
    const a = (await ask("  [w] watch progress · [c] cancel it · [q] quit — ")).toLowerCase();
    if (a === "w") return await watchRestore();
    if (a === "c") {
      try { await api("POST", "/api/restore/cancel"); } catch (e) { fatalApi(e); }
      return await watchRestore();
    }
    return 0;
  }

  // pick a backup
  let list;
  try { list = (await api("GET", "/api/restore/backups")).json; } catch (e) { fatalApi(e); }
  const isCustomName = (n) => String(n || "").startsWith("custom_");
  const candidates = [
    ...(list.backupRuns || [])
      .filter((b) => b.panel === "custom" || isCustomName(b.fileName))
      .map((b) => ({ source: "backup-run", id: b.id, name: b.fileName, size: b.fileSize, ts: b.startedAt, sourcePath: b.sourcePath || null })),
    ...(list.reassembled || [])
      .filter((b) => b.panel === "custom" || isCustomName(b.name))
      .map((b) => ({ source: "reassembled", id: b.id, name: b.name, size: b.size, ts: b.createdAt, sourcePath: null })),
  ];
  if (candidates.length === 0) {
    console.log(c.y("\nNo custom-path backups were found."));
    console.log(c.d("Custom paths are configured in the web panel (Settings → Custom paths); run a backup first."));
    return 0;
  }
  console.log(`\n  ${c.b("custom-path backups available:")}`);
  candidates.forEach((b, i) => {
    const src = b.sourcePath ? c.d(`  (from ${b.sourcePath})`) : "";
    console.log(`  ${c.c(String(i + 1).padStart(2))}) ${fmtDate(b.ts)}  ${fmtBytes(b.size).padStart(8)}  ${b.name}${src}`);
  });
  const pick = (await ask(`\nSelect a backup [1-${candidates.length}] (q to quit): `)).toLowerCase();
  if (pick === "q" || pick === "") return 0;
  const idx = Number(pick) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    console.log(c.r("✗ invalid selection"));
    return 1;
  }
  const backup = candidates[idx];

  // SSH connection details
  console.log(`\n  ${c.b("target server (SSH):")}`);
  const host = await ask("  SSH host (IP or domain): ");
  if (!host) { console.log(c.r("✗ an SSH host is required")); return 1; }
  const portRaw = await ask("  SSH port [22]: ");
  const port = portRaw ? Number(portRaw) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.log(c.r("✗ invalid port")); return 1; }
  const user = (await ask("  SSH user [root]: ")) || "root";

  let password, privateKey, passphrase;
  const method = (await ask("  Auth method — (p)assword or private (k)ey [p]: ")).toLowerCase();
  if (method === "k") {
    for (;;) {
      const kp = (await ask("  Private key file path: ")).replace(/^~(?=\/|$)/, process.env.HOME || "");
      try {
        privateKey = fs.readFileSync(kp, "utf8");
        break;
      } catch {
        console.log(c.r(`  ✗ cannot read ${kp} — check the path and permissions`));
      }
    }
    passphrase = (await askSecret("  Key passphrase (empty for none): ")) || undefined;
  } else {
    password = await askSecret("  SSH password: ");
    if (!password) { console.log(c.r("✗ an SSH password is required")); return 1; }
  }

  // restore destination on the target server
  const defTgt = backup.sourcePath || "";
  console.log(`\n  ${c.b("restore destination on the target server:")}`);
  let targetPath = "";
  for (;;) {
    const t = (await ask(`  Target path${defTgt ? ` [${defTgt}]` : ""}: `)) || defTgt;
    const err = validateTargetPath(t);
    if (!err) { targetPath = t === "/" ? "/" : t.replace(/\s+$/, "").replace(/\/+$/, ""); break; }
    console.log(c.r(`  ✗ ${TARGET_ERR[err]}`));
  }

  // summary + confirm
  console.log(`\n  ${c.b("about to restore:")}
  backup : ${backup.name}  ${c.d(`(${fmtBytes(backup.size)})`)}
  server : ${user}@${host}:${port}
  target : ${targetPath}  ${c.d("(created when missing; existing files are overwritten)")}`);
  const go = (await ask(`\nStart the restore? [y/N]: `)).toLowerCase();
  if (go !== "y") { console.log("cancelled."); return 0; }

  // verify SSH credentials BEFORE starting the real job
  process.stdout.write(c.c("  testing the SSH connection…\n"));
  const testBody = { sshHost: host, sshPort: port, sshUser: user, sshPassword: password, sshPrivateKey: privateKey, sshPassphrase: passphrase };
  try {
    const t = await api("POST", "/api/restore/test-ssh", testBody);
    if (!t.json?.ok) {
      console.log(c.r(`  ✗ SSH test failed: ${t.json?.error || "connection refused"}`));
      const anyway = (await ask("  start the restore anyway? [y/N]: ")).toLowerCase();
      if (anyway !== "y") return 1;
    } else {
      console.log("  [OK] SSH connection verified");
    }
  } catch (e) {
    if (e?.message === "SERVICE_DOWN" || e?.message === "UNAUTHORIZED") fatalApi(e);
    console.log(c.y(`  ! SSH test could not run (${e?.message || e}) — continuing anyway`));
  }

  // start
  let start;
  try {
    start = await api("POST", "/api/restore/start", {
      panel: "custom",
      backupId: backup.id,
      backupSource: backup.source,
      targetPath,
      ...testBody,
    });
  } catch (e) { fatalApi(e); }
  if (!start.json?.ok) {
    console.log(c.r(`✗ ${startErrText(start.json?.error)}`));
    return 1;
  }
  console.log(c.g(`✔ restore job #${start.json.jobId} started`));

  return await watchRestore();
}

main()
  .then((code) => { rl.close(); process.exit(code ?? 0); })
  .catch((e) => { rl.close(); console.error(c.r(`✗ ${e?.message || e}`)); process.exit(1); });
