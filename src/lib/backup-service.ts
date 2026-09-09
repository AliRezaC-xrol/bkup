import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { getConfig } from "@/lib/config-service";
import { login, getDb, getJsonExport, invalidateSession } from "@/lib/panel-client";
import { hmFullBackup } from "@/lib/hmpanel-client";
import { pgFullBackup } from "@/lib/pasarguard-client";
import { sendDocument, deleteMessage } from "@/lib/telegram";
import { bi, fail, storeBi, throwBi, errorBiOf, type Bi } from "@/lib/messages";

export type PanelId = "3x-ui" | "hmpanel" | "pasarguard";

export interface BackupOutcome {
  runId: number;
  panel: PanelId;
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
 * x-ui and HM Panel are independent connections — each enabled panel gets its
 * own full backup, its own local file and its own Telegram document.
 * A failing panel never blocks the other one.
 */
export async function runBackup(trigger: "auto" | "manual"): Promise<CycleResult> {
  if (g.__xuiRunning) {
    const skipMsg = bi(
      "اجرای قبلی هنوز در حال انجام است — این چرخه رد شد",
      "The previous run is still in progress — this cycle was skipped"
    );
    const skip: BackupOutcome = {
      runId: -1,
      panel: "3x-ui",
      status: "skipped",
      error: skipMsg.fa,
      errorBi: skipMsg,
      durationMs: 0,
    };
    await log("warn", bi("چرخه قبلی هنوز تمام نشده؛ بکاپ این دوره رد شد", "The previous cycle has not finished yet; this backup cycle was skipped"));
    return { outcomes: [skip], ok: false, durationMs: 0 };
  }
  g.__xuiRunning = true;
  const cycleStart = Date.now();

  const cfg = await getConfig();

  const targets: PanelId[] = [];
  if (cfg.xuiEnabled) targets.push("3x-ui");
  if (cfg.hmEnabled) targets.push("hmpanel");
  if (cfg.pgEnabled) targets.push("pasarguard");

  if (targets.length === 0) {
    g.__xuiRunning = false;
    await log("warn", bi("هیچ پنلی فعال نیست — ابتدا اتصال 3x-ui، HMPanel یا PasarGuard را در تنظیمات فعال کنید", "No panel is enabled — first enable a 3x-ui, HMPanel or PasarGuard connection in Settings"));
    return { outcomes: [], ok: false, durationMs: 0 };
  }

  const outcomes: BackupOutcome[] = [];
  for (const panel of targets) {
    outcomes.push(await runPanelBackup(panel, cfg, trigger));
  }

  // post-cycle cleanup (non-fatal, once per cycle)
  try {
    await cleanupTelegramOld(cfg);
    await cleanupLocalFiles(cfg);
  } catch (e: unknown) {
    await log("warn", bi(
      `پاک‌سازی دوره‌ای با خطا مواجه شد: ${e instanceof Error ? e.message : String(e)}`,
      `Periodic cleanup hit an error: ${e instanceof Error ? e.message : String(e)}`
    ));
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
    await log("error", bi(`ثبت چرخه بکاپ ${panelTitle(panel)} ناموفق بود: ${error}`, `Could not create the ${panelTitle(panel)} backup run record: ${error}`));
    return { runId: -1, panel, status: "failed", error, durationMs: 0 };
  }

  let outcome: BackupOutcome;

  try {
    // 1) Obtain the backup payload
    let buf: Buffer;
    let fileName: string;
    let method: "db" | "json" | "local" | "hm-full" | "pg-full";
    let warnNoteBi: Bi | null = null;

    if (panel === "hmpanel") {
      // ── HMPanel: FULL archive via official API (db + config + uploads) ──
      const hm = await hmFullBackup(cfg);
      if (!hm.ok || !hm.data) throwBi(hm.error ?? "بکاپ HMPanel ناموفق بود", hm.errorBi?.en ?? "The HMPanel backup failed");
      buf = hm.data.buf;
      fileName = hm.data.fileName;
      method = "hm-full";
    } else if (panel === "pasarguard") {
      // ── PasarGuard: FULL logical snapshot via official API (users + hosts +
      //    nodes + cores + groups + settings + templates) packed as tar.gz ──
      const pg = await pgFullBackup(cfg);
      if (!pg.ok || !pg.data) throwBi(pg.error ?? "بکاپ PasarGuard ناموفق بود", pg.errorBi?.en ?? "The PasarGuard backup failed");
      buf = pg.data.buf;
      fileName = pg.data.fileName;
      method = "pg-full";
    } else {
      const mode = cfg.backupMode;
      if (mode === "local") {
        const res = readLocalDb(cfg.localDbPath);
        if (!res.ok) throwBi(res.error, res.errorBi.en);
        buf = res.buf!;
        fileName = timestampName("x-ui", "db");
        method = "local";
      } else {
        const sess = await login(cfg, cfg.authMode !== "bearer" && trigger === "manual");
        if (!sess.ok) throwBi(sess.error ?? "ورود به پنل ناموفق بود", sess.errorBi?.en ?? sess.error ?? "Panel login failed");

        let dbRes = mode === "json" ? null : await getDb(cfg, sess.data!);
        // One retry with a fresh session on auth failure
        if (dbRes && !dbRes.ok && (dbRes.status === 401 || dbRes.status === 404)) {
          invalidateSession();
          const relogin = await login(cfg, true);
          if (relogin.ok) dbRes = await getDb(cfg, relogin.data!);
        }

        if (dbRes && dbRes.ok && dbRes.data) {
          buf = dbRes.data.buf;
          fileName = timestampName("x-ui", "db");
          method = "db";
        } else if (mode === "db") {
          throwBi(dbRes?.error ?? "دانلود دیتابیس ناموفق بود", dbRes?.errorBi?.en ?? "The database download failed");
        } else {
          // auto mode: fall back to JSON export
          if (dbRes && !dbRes.ok) {
            warnNoteBi = bi(
              `فایل دیتابیس دریافت نشد (${dbRes.error}) — خروجی JSON جایگزین شد`,
              `The database file could not be fetched (${dbRes.errorBi?.en ?? dbRes.error}) — a JSON export was used instead`
            );
          }
          const js = await getJsonExport(cfg, sess.data!);
          if (!js.ok || !js.data) {
            throwBi(
              `بکاپ کامل ناموفق بود. دیتابیس: ${dbRes?.error ?? "نامشخص"} | JSON: ${js.error ?? "نامشخص"}`,
              `The full backup failed. Database: ${dbRes?.errorBi?.en ?? "unknown"} | JSON: ${js.errorBi?.en ?? "unknown"}`
            );
          }
          buf = Buffer.from(js.data.json, "utf8");
          fileName = timestampName("x-ui", "json");
          method = "json";
        }
      }
    }

    // 2) Persist locally
    const dir = backupDir();
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buf);
    await log("info", bi(
      `[${panelTitle(panel)}] فایل بکاپ ذخیره شد: ${fileName} (${formatSize(buf.length)})`,
      `[${panelTitle(panel)}] backup file saved: ${fileName} (${formatSize(buf.length)})`
    ));

    // 3) Send to Telegram
    const tg = await sendDocument(cfg, buf, fileName, method, panel);
    if (!tg.ok) {
      throwBi(`ارسال به تلگرام ناموفق بود: ${tg.error}`, `Sending to Telegram failed: ${tg.errorBi?.en ?? tg.error}`);
    }
    await log("success", bi(
      `[${panelTitle(panel)}] بکاپ کامل با موفقیت به تلگرام ارسال شد (چت ${cfg.telegramChatId})`,
      `[${panelTitle(panel)}] the full backup was sent to Telegram successfully (chat ${cfg.telegramChatId})`
    ));

    if (warnNoteBi) await log("warn", warnNoteBi);

    const durationMs = Date.now() - started;
    await db.backupRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        method,
        fileName,
        filePath,
        fileSize: buf.length,
        tgMessageId: tg.data!.messageId,
        durationMs,
      },
    });

    outcome = {
      runId: run.id,
      panel,
      status: "success",
      method,
      fileName,
      fileSize: buf.length,
      tgMessageId: tg.data!.messageId,
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
    await log("error", bi(`[${panelTitle(panel)}] بکاپ ناموفق بود: ${error}`, `[${panelTitle(panel)}] the backup failed: ${errBi?.en ?? error}`));
    outcome = { runId: run.id, panel, status: "failed", error, errorBi: errBi, durationMs };
  }

  return outcome;
}

function panelTitle(panel: PanelId): string {
  return panel === "hmpanel" ? "HMPanel" : panel === "pasarguard" ? "PasarGuard" : "3x-ui";
}

function readLocalDb(p: string): { ok: true; buf: Buffer } | { ok: false; error: string; errorBi: Bi } {
  try {
    if (!p.trim()) {
      return fail("مسیر فایل دیتابیس لوکال تنظیم نشده است", "The local database file path is not configured");
    }
    const resolved = p.trim();
    if (!fs.existsSync(resolved)) {
      return fail(
        `فایل در مسیر «${resolved}» پیدا نشد (اگر بات داخل Docker اجرا می‌شود، مسیر را mount کنید)`,
        `The file was not found at "${resolved}" (if the bot runs inside Docker, mount the path)`
      );
    }
    return { ok: true, buf: fs.readFileSync(resolved) };
  } catch (e: unknown) {
    const t = e instanceof Error ? e.message : String(e);
    return fail(`خواندن فایل لوکال ناموفق بود: ${t}`, `Reading the local file failed: ${t}`);
  }
}

/** Keep only the newest N Telegram backup messages per panel (0 = disabled). */
async function cleanupTelegramOld(cfg: Awaited<ReturnType<typeof getConfig>>) {
  const keep = cfg.tgAutoDeleteKeep;
  if (!keep || keep < 1) return;
  for (const panel of ["3x-ui", "hmpanel", "pasarguard"] as PanelId[]) {
    const candidates = await db.backupRun.findMany({
      where: { status: "success", panel, tgMessageId: { not: null }, tgDeleted: false },
      orderBy: { startedAt: "desc" },
      skip: keep,
      take: 50,
    });
    for (const row of candidates) {
      const res = await deleteMessage(cfg, row.tgMessageId!);
      if (res.ok) {
        await db.backupRun.update({ where: { id: row.id }, data: { tgDeleted: true } });
        await log("info", bi(`بکاپ قدیمی تلگرام حذف شد (پیام ${row.tgMessageId})`, `Old Telegram backup deleted (message ${row.tgMessageId})`));
      } else {
        // message probably already gone — mark deleted to avoid retry loops
        if (/message to delete not found|message can'?t be deleted/i.test(res.error ?? "")) {
          await db.backupRun.update({ where: { id: row.id }, data: { tgDeleted: true } });
        } else {
          break; // stop on unexpected errors this cycle
        }
      }
    }
  }
}

/** Keep only the newest N local backup files per panel prefix (0 = unlimited). */
async function cleanupLocalFiles(cfg: Awaited<ReturnType<typeof getConfig>>) {
  const keep = cfg.localRetention;
  if (!keep || keep < 1) return;
  const dir = backupDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) =>
      f.startsWith("x-ui-backup-") ||
      f.startsWith("hmpanel-backup-") ||
      f.startsWith("pasarguard_full_") ||
      f.startsWith("backup_")
    )
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch { /* ignore */ }
  }
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
