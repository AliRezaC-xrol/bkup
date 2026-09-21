import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { getConfig } from "@/lib/config-service";
import { login, getDb, invalidateSession } from "@/lib/panel-client";
import { hmFullBackup } from "@/lib/hmpanel-client";
import { pgFullBackup } from "@/lib/pasarguard-client";
import { rbFullBackup } from "@/lib/rebecca-client";
import { sendBackupFile, deleteMessage } from "@/lib/telegram";
import { bi, fail, storeBi, throwBi, errorBiOf, type Bi } from "@/lib/messages";
import { customPathBackup, parseCustomPaths } from "@/lib/custom-path-client";

export type PanelId = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca" | "custom";

const ALL_PANELS: PanelId[] = ["3x-ui", "hmpanel", "pasarguard", "rebecca", "custom"];

export interface BackupOutcome {
  runId: number;
  panel: PanelId | "all"; // "all" = cycle-level notice (e.g. a run still in progress)
  status: "success" | "failed" | "skipped";
  method?: string;
  fileName?: string;
  fileSize?: number;
  tgMessageId?: number;
  error?: string;  // canonical fa text
  errorBi?: Bi;    // bilingual pair for the web panel
  durationMs: number;
}

export interface CycleResult {
  outcomes: BackupOutcome[];
  ok: boolean; // true when every enabled panel succeeded
  durationMs: number;
}

export function backupDir(): string {
  const dir = process.env.BACKUP_DIR
    ? process.env.BACKUP_DIR
    : path.join(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampName(prefix: string, ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}-backup-${stamp}.${ext}`;
}

const g = globalThis as unknown as { __xuiRunning?: boolean };

/**
 * Run one full backup CYCLE across ALL enabled panels.
 * Every panel is an independent connection — each enabled panel gets its
 * own full backup, its own local file and its own Telegram delivery.
 * A failing panel never blocks the others.
 */
export async function runBackup(trigger: "auto" | "manual"): Promise<CycleResult> {
  if (g.__xuiRunning) {
    const skipMsg = bi("The previous run is still in progress — this cycle was skipped", "The previous run is still in progress — this cycle was skipped");
    const skip: BackupOutcome = {
      runId: -1,
      panel: "all",
      status: "skipped",
      error: skipMsg.fa,
      errorBi: skipMsg,
      durationMs: 0,
    };
    await log("warn", bi("The previous cycle has not finished yet; this backup cycle was skipped", "The previous cycle has not finished yet; this backup cycle was skipped"));
    return { outcomes: [skip], ok: false, durationMs: 0 };
  }
  g.__xuiRunning = true;
  const cycleStart = Date.now();

  const cfg = await getConfig();

  // duplicate-cycle guard: an auto cycle starting again inside the same
  // scheduling window (stray timer, service restart mid-cycle) is suppressed —
  // exactly ONE full backup per scheduled cycle, never two.
  if (trigger === "auto") {
    const newest = await db.backupRun.findFirst({ where: { trigger: "auto" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    if (newest && Date.now() - new Date(newest.startedAt).getTime() < Math.max(10, cfg.intervalSeconds) * 800) {
      g.__xuiRunning = false;
      await log("warn", bi("A duplicate backup cycle within the same scheduling window was suppressed", "A duplicate backup cycle within the same scheduling window was suppressed"));
      return { outcomes: [], ok: true, durationMs: 0 };
    }
  }

  const targets: PanelId[] = [];
  if (cfg.xuiEnabled) targets.push("3x-ui");
  if (cfg.hmEnabled) targets.push("hmpanel");
  if (cfg.pgEnabled) targets.push("pasarguard");
  if (cfg.rebeccaEnabled) targets.push("rebecca");
  const customPaths = parseCustomPaths(cfg.customPaths);
  for (const _ of customPaths) targets.push("custom");

  if (targets.length === 0) {
    g.__xuiRunning = false;
    await log("warn", bi("No panel is enabled — first enable a panel connection in Settings", "No panel is enabled — first enable a panel connection in Settings"));
    return { outcomes: [], ok: false, durationMs: 0 };
  }

  // the per-entry custom-path runs need their own iterator — a "custom"
  // target appears once per configured path
  let customIndex = 0;

  const outcomes: BackupOutcome[] = [];
  for (const panel of targets) {
    if (panel === "custom") {
      const entry = customPaths[customIndex++];
      if (entry) outcomes.push(await runCustomBackup(entry, cfg, trigger));
    } else {
      outcomes.push(await runPanelBackup(panel, cfg, trigger));
    }
  }

  // post-cycle cleanups — each in its OWN try/catch so one failing
  // (e.g. a busy SQLite moment) can never skip the other one
  try {
    await cleanupTelegramOld(cfg);
  } catch (e: unknown) {
    await log("warn", bi(`Telegram cleanup hit an error: ${e instanceof Error ? e.message : String(e)}`, `Telegram cleanup hit an error: ${e instanceof Error ? e.message : String(e)}`));
  }
  try {
    await sweepOrphanFiles(cfg);
  } catch (e: unknown) {
    await log("warn", bi(`Orphan-file cleanup hit an error: ${e instanceof Error ? e.message : String(e)}`, `Orphan-file cleanup hit an error: ${e instanceof Error ? e.message : String(e)}`));
  }

  g.__xuiRunning = false;
  const ok = outcomes.length > 0 && outcomes.every((o) => o.status === "success");
  return { outcomes, ok, durationMs: Date.now() - cycleStart };
}

/** Full backup of ONE panel: fetch → save locally → send to Telegram → record. */
async function runPanelBackup(
  panel: PanelId,
  cfg: Awaited<ReturnType<typeof getConfig>>,
  trigger: "auto" | "manual"
): Promise<BackupOutcome> {
  const started = Date.now();

  let run;
  try {
    run = await db.backupRun.create({ data: { status: "running", trigger, panel } });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    await log("error", bi(`Could not create the ${panelTitle(panel)} backup run record: ${error}`, `Could not create the ${panelTitle(panel)} backup run record: ${error}`));
    return { runId: -1, panel, status: "failed", error, durationMs: 0 };
  }

  let outcome: BackupOutcome;

  // Only the backup FILE is delivered to Telegram — no progress, success or
  // completion messages of any kind.
  try {
    // 1) Obtain the backup payload — every panel streams its archive to a
    //    staging file under backups/.staging/ so the payload is NEVER held
    //    in RAM: a full backup can be hundreds of MB and buffering it is
    //    what used to OOM-kill the service mid-backup.
    const stagingDir = path.join(backupDir(), ".staging");
    fs.mkdirSync(stagingDir, { recursive: true });

    let filePath: string;
    let fileName: string;
    let size: number;
    let method: "db" | "hm-full" | "pg-full" | "rb-full";
    let warnNoteBi: Bi | null = null;

    if (panel === "hmpanel") {
      // ── HMPanel: FULL archive via official API (db + config + uploads,
      //    premium data included when the panel is a Premium edition) ──
      const hm = await hmFullBackup(cfg, stagingDir);
      if (!hm.ok || !hm.data) throwBi(hm.error ?? "The HMPanel backup failed", hm.errorBi?.en ?? "The HMPanel backup failed");
      filePath = hm.data.filePath;
      fileName = hm.data.fileName;
      size = hm.data.size;
      method = "hm-full";
      // Persist the freshly-detected premium status so the UI stays current
      // Only write when the value actually changed — Prisma @updatedAt bumps on every update()
      try {
        if (cfg.hmPremium !== hm.data.premium) {
          await db.backupConfig.update({ where: { id: 1 }, data: { hmPremium: hm.data.premium } });
        }
      } catch { /* best-effort */ }
    } else if (panel === "pasarguard") {
      // ── PasarGuard: FULL logical snapshot via official API (users + hosts +
      //    nodes + cores + groups + settings + templates) packed as tar.gz ──
      const pg = await pgFullBackup(cfg, stagingDir);
      if (!pg.ok || !pg.data) throwBi(pg.error ?? "The PasarGuard backup failed", pg.errorBi?.en ?? "The PasarGuard backup failed");
      filePath = pg.data.filePath;
      fileName = pg.data.fileName;
      size = pg.data.size;
      method = "pg-full";
    } else if (panel === "rebecca") {
      // ── Rebecca: FULL export via official API (database + configuration) ──
      const rb = await rbFullBackup(cfg, stagingDir);
      if (!rb.ok || !rb.data) throwBi(rb.error ?? "The Rebecca backup failed", rb.errorBi?.en ?? "The Rebecca backup failed");
      filePath = rb.data.filePath;
      fileName = rb.data.fileName;
      size = rb.data.size;
      method = "rb-full";
    } else {
      // ── 3x-ui: ONE backup method only — the panel's OWN full database
      // backup (getDb), exactly the file the panel serves, byte-for-byte,
      // never modified. No JSON export, no local-file mode: those produced
      // partial backups that broke X-Ray after a restore. ──
      const sess = await login(cfg, cfg.authMode !== "bearer" && trigger === "manual");
      if (!sess.ok) throwBi(sess.error ?? "Panel login failed", sess.errorBi?.en ?? sess.error ?? "Panel login failed");

      const dbName = timestampName("x-ui", "db");
      let dbRes = await getDb(cfg, sess.data!, stagingDir, dbName);
      // One retry with a fresh session on auth failure
      if (!dbRes.ok && (dbRes.status === 401 || dbRes.status === 404)) {
        invalidateSession();
        const relogin = await login(cfg, true);
        if (relogin.ok) dbRes = await getDb(cfg, relogin.data!, stagingDir, dbName);
      }
      if (!dbRes.ok || !dbRes.data) {
        throwBi(dbRes.error ?? "The database download failed", dbRes.errorBi?.en ?? dbRes.error ?? "The database download failed");
      }
      filePath = dbRes.data!.filePath;
      fileName = dbRes.data!.fileName;
      size = dbRes.data!.size;
      method = "db";
    }

    // integrity gate — the archive must be a real, complete backup file.
    // Read the header from the file rather than from an in-memory buffer.
    const integrity = await verifyArchiveFile(fileName, filePath);
    if (!integrity.ok) throwBi(integrity.error!, integrity.errorBi!.en);

    await log("info", bi(`[${panelTitle(panel)}] backup file saved: ${fileName} (${formatSize(size)})`, `[${panelTitle(panel)}] backup file saved: ${fileName} (${formatSize(size)})`));

    // 2) Send to Telegram — ANY size; large files go out as parts. The file
    //    is streamed off disk, never copied into RAM.
    const tg = await sendBackupFile(cfg, filePath, size, fileName, method, panel);
    if (!tg.ok) {
      throwBi(`Sending to Telegram failed: ${tg.errorBi?.en ?? tg.error}`, `Sending to Telegram failed: ${tg.errorBi?.en ?? tg.error}`);
    }
    await log("success", bi(`[${panelTitle(panel)}] the full backup was sent to Telegram successfully (chat ${cfg.telegramChatId})`, `[${panelTitle(panel)}] the full backup was sent to Telegram successfully (chat ${cfg.telegramChatId})`));

    if (warnNoteBi) await log("warn", warnNoteBi);

    // 3) Move the verified archive out of staging into the real backups dir.
    //    Only a file that passed the integrity gate AND reached Telegram is
    //    promoted — a failed run never leaves a fake "backup" in history.
    const finalPath = path.join(backupDir(), fileName);
    if (path.resolve(filePath) !== path.resolve(finalPath)) {
      await fs.promises.rename(filePath, finalPath);
      filePath = finalPath;
    }

    const durationMs = Date.now() - started;
    await db.backupRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        method,
        fileName,
        filePath,
        fileSize: size,
        tgMessageId: tg.data!.messageIds[0],
        tgMessageIds: JSON.stringify(tg.data!.messageIds),
        durationMs,
      },
    });

    // per-panel local retention — enforced after EVERY successful backup
    try {
      await enforceLocalRetention(cfg, panel);
    } catch { /* retention is best-effort and must never fail the backup */ }

    outcome = {
      runId: run.id,
      panel,
      status: "success",
      method,
      fileName,
      fileSize: size,
      tgMessageId: tg.data!.messageIds[0],
      durationMs,
    };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    const errBi = errorBiOf(e);
    const durationMs = Date.now() - started;
    await db.backupRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: storeBi(errBi, error), durationMs },
    });
    await log("error", bi(`[${panelTitle(panel)}] the backup failed: ${errBi?.en ?? error}`, `[${panelTitle(panel)}] the backup failed: ${errBi?.en ?? error}`));
    outcome = { runId: run.id, panel, status: "failed", error, errorBi: errBi, durationMs };
  }

  return outcome;
}

/** Archive integrity gate — a delivered backup must be a real archive, never an error page. */
export function verifyArchive(fileName: string, buf: Buffer): { ok: true } | { ok: false; error: string; errorBi: Bi } {
  if (buf.length === 0) return fail("The backup file was empty", "The backup file was empty");
  return verifyMagic(fileName, buf.length, buf.subarray(0, 16));
}

/**
 * File-backed integrity gate — reads only the first 16 bytes + the size from
 * disk. Backups now stream to a file, so this is the version the backup path
 * uses; verifyArchive above stays for the in-memory reassembly path.
 */
export async function verifyArchiveFile(fileName: string, filePath: string): Promise<{ ok: true } | { ok: false; error: string; errorBi: Bi }> {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return fail("The backup file is missing", "The backup file is missing");
  }
  if (stat.size === 0) return fail("The backup file was empty", "The backup file was empty");
  const fd = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await fd.read(head, 0, 16, 0);
    return verifyMagic(fileName, stat.size, head.subarray(0, bytesRead));
  } finally {
    await fd.close();
  }
}

/** Shared magic-byte gate used by both the in-memory and the file-backed path. */
function verifyMagic(fileName: string, size: number, head: Buffer): { ok: true } | { ok: false; error: string; errorBi: Bi } {
  if (size === 0) return fail("The backup file was empty", "The backup file was empty");
  const b0 = head[0], b1 = head[1];
  const isGzip = b0 === 0x1f && b1 === 0x8b;
  const isZip = b0 === 0x50 && b1 === 0x4b;
  const lower = fileName.toLowerCase();
  if ((lower.endsWith(".gz") || lower.endsWith(".tgz")) && !isGzip) {
    return fail("The backup file is not a valid gzip archive", "The backup file is not a valid gzip archive");
  }
  if (lower.endsWith(".zip") && !isZip) {
    return fail("The backup file is not a valid zip archive", "The backup file is not a valid zip archive");
  }
  // a JSON error body or an HTML error page must never be stored/sent as a backup
  const looksJson = b0 === 0x7b || b0 === 0x5b;
  const looksHtml = b0 === 0x3c;
  // .db files must be real SQLite — check the magic header "SQLite format 3\000"
  const isSqlite = head.length >= 15 && head.subarray(0, 15).toString("ascii") === "SQLite format 3";
  if (lower.endsWith(".db") && !isSqlite) {
    return fail("The backup file claims to be a database but is not a valid SQLite file", "The backup file claims to be a database but is not a valid SQLite file");
  }
  const isPlaintextFormat = lower.endsWith(".json") || (lower.endsWith(".db") && isSqlite);
  if (!isGzip && !isZip && !isPlaintextFormat && (looksJson || looksHtml)) {
    return fail("The panel answered with an error message instead of the backup file", "The panel answered with an error message instead of the backup file");
  }
  return { ok: true };
}

function panelTitle(panel: PanelId): string {
  return panel === "hmpanel"
    ? "HMPanel"
    : panel === "pasarguard"
      ? "PasarGuard"
      : panel === "rebecca"
        ? "Rebecca"
        : panel === "custom"
          ? "Custom"
          : "3x-ui";
}

/**
 * Back up ONE custom directory. Same contract as a panel backup: create a
 * run row, stream the archive to disk, integrity-check it, send it to
 * Telegram, then promote it out of staging and enforce retention.
 */
async function runCustomBackup(
  entry: { path: string; label: string },
  cfg: Awaited<ReturnType<typeof getConfig>>,
  trigger: "auto" | "manual"
): Promise<BackupOutcome> {
  const started = Date.now();
  const label = entry.label || path.basename(entry.path) || entry.path;

  let run;
  try {
    run = await db.backupRun.create({ data: { status: "running", trigger, panel: "custom" } });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    await log("error", bi(`Could not create the custom-path backup run record: ${error}`, `Could not create the custom-path backup run record: ${error}`));
    return { runId: -1, panel: "custom", status: "failed", error, durationMs: 0 };
  }

  let outcome: BackupOutcome;
  try {
    const stagingDir = path.join(backupDir(), ".staging");
    fs.mkdirSync(stagingDir, { recursive: true });

    const res = await customPathBackup(cfg, entry, stagingDir, process.cwd());
    if (!res.ok || !res.data) {
      throwBi(res.error ?? "The custom-path backup failed", res.errorBi?.en ?? res.error ?? "The custom-path backup failed");
    }
    const { filePath, fileName, size, files } = res.data;

    const integrity = await verifyArchiveFile(fileName, filePath);
    if (!integrity.ok) throwBi(integrity.error!, integrity.errorBi!.en);

    await log("info", bi(`[Custom:${label}] backup file saved: ${fileName} (${formatSize(size)}, ${files} files)`, `[Custom:${label}] backup file saved: ${fileName} (${formatSize(size)}, ${files} files)`));

    const tg = await sendBackupFile(cfg, filePath, size, fileName, "custom-full", "custom");
    if (!tg.ok) {
      throwBi(`Sending to Telegram failed: ${tg.errorBi?.en ?? tg.error}`, `Sending to Telegram failed: ${tg.errorBi?.en ?? tg.error}`);
    }
    await log("success", bi(`[Custom:${label}] the directory backup was sent to Telegram successfully (chat ${cfg.telegramChatId})`, `[Custom:${label}] the directory backup was sent to Telegram successfully (chat ${cfg.telegramChatId})`));

    const finalPath = path.join(backupDir(), fileName);
    if (path.resolve(filePath) !== path.resolve(finalPath)) {
      await fs.promises.rename(filePath, finalPath);
    }

    const durationMs = Date.now() - started;
    await db.backupRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        method: "custom-full",
        fileName,
        filePath: finalPath,
        fileSize: size,
        tgMessageId: tg.data!.messageIds[0],
        tgMessageIds: JSON.stringify(tg.data!.messageIds),
        durationMs,
      },
    });

    try {
      await enforceLocalRetention(cfg, "custom");
    } catch { /* retention is best-effort */ }

    outcome = {
      runId: run.id,
      panel: "custom",
      status: "success",
      method: "custom-full",
      fileName,
      fileSize: size,
      tgMessageId: tg.data!.messageIds[0],
      durationMs,
    };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    const errBi = errorBiOf(e);
    const durationMs = Date.now() - started;
    await db.backupRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: storeBi(errBi, error), durationMs },
    });
    await log("error", bi(`[Custom:${label}] the backup failed: ${errBi?.en ?? error}`, `[Custom:${label}] the backup failed: ${errBi?.en ?? error}`));
    outcome = { runId: run.id, panel: "custom", status: "failed", error, errorBi: errBi, durationMs };
  }

  return outcome;
}

/** Keep only the newest N Telegram backup messages per panel (0 = disabled). */
async function cleanupTelegramOld(cfg: Awaited<ReturnType<typeof getConfig>>) {
  const keep = cfg.tgAutoDeleteKeep;
  if (!keep || keep < 1) return;
  for (const panel of ALL_PANELS) {
    const candidates = await db.backupRun.findMany({
      where: { status: "success", panel, tgMessageId: { not: null }, tgDeleted: false },
      orderBy: { startedAt: "desc" },
      skip: keep,
      take: 50,
    });
    for (const row of candidates) {
      // multi-part sends store every message id; older rows only have the first one
      let ids: number[] = [];
      try {
        if (row.tgMessageIds) ids = JSON.parse(row.tgMessageIds) as number[];
      } catch { /* fall back below */ }
      if (ids.length === 0) ids = [row.tgMessageId!];
      let allDeleted = true;
      for (const id of ids) {
        const res = await deleteMessage(cfg, id);
        if (res.ok) continue;
        if (/message to delete not found|message can'?t be deleted/i.test(res.error ?? "")) continue;
        allDeleted = false;
        break; // stop on unexpected errors this cycle
      }
      if (allDeleted) {
        await db.backupRun.update({ where: { id: row.id }, data: { tgDeleted: true } });
        await log("info", bi(`Old Telegram backup deleted (message ${ids[0]})`, `Old Telegram backup deleted (message ${ids[0]})`));
      } else {
        break;
      }
    }
  }
}

/**
 * Per-panel local retention — keep only the newest N local backups of THIS
 * panel (0 = unlimited). Enforced after every successful backup, fully
 * dynamic: N is read fresh from the config each time. Ordering is by the
 * REAL time (DB startedAt), never by file name. The backup that was just
 * created is always the newest row, so it can never be deleted. Deleted
 * backups are removed from the Backup History too, so the history always
 * matches the files actually on disk.
 */
async function enforceLocalRetention(
  cfg: Awaited<ReturnType<typeof getConfig>>,
  panel: PanelId
): Promise<void> {
  const keep = cfg.localRetention;
  if (!keep || keep < 1) return; // 0 = unlimited
  const runs = await db.backupRun.findMany({
    where: { panel, filePath: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { id: true, filePath: true },
  });
  for (const run of runs.slice(keep)) {
    try {
      if (run.filePath && fs.existsSync(run.filePath)) fs.unlinkSync(run.filePath);
    } catch { /* best-effort */ }
    await db.backupRun.delete({ where: { id: run.id } });
  }
}

/**
 * Orphan sweep — archives left on disk by a cycle that crashed after writing
 * the file (they belong to no history row). One hour of grace in case a cycle
 * is still running. Runs once per cycle; retention itself is per-panel above.
 *
 * Also reaps the .staging/ directory: a cycle that died mid-download leaves a
 * half-written archive there. Staging files get a SHORT grace (10 min) since
 * they can never be a finished backup.
 */
async function sweepOrphanFiles(cfg: Awaited<ReturnType<typeof getConfig>>) {
  const dir = backupDir();
  const KNOWN = /(-backup-|_full_|\.db$|\.json$|\.tar\.gz$|\.tgz$|\.zip$|\.rbbackup$)/;
  const referenced = new Set(
    (await db.backupRun.findMany({ where: { filePath: { not: null } }, select: { filePath: true } }))
      .map((r) => r.filePath)
  );
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!KNOWN.test(f) || referenced.has(full)) continue;
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(full);
    } catch { /* best-effort */ }
  }

  const staging = path.join(dir, ".staging");
  try {
    for (const f of fs.readdirSync(staging)) {
      const full = path.join(staging, f);
      try {
        // a run in flight holds this file; only reap the stale ones
        if (Date.now() - fs.statSync(full).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(full);
      } catch { /* best-effort */ }
    }
  } catch { /* staging dir does not exist yet — nothing to sweep */ }
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
