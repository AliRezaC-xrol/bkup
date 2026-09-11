import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

// Force IPv4-first DNS (broken IPv6 routes on some hosts cause silent
// "fetch failed") and apply a hard timeout so a stuck connection can never
// spin the UI forever. Control calls get a short guard; uploads get a
// generous one (they can carry a 2GB single file via a local Bot API server).
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
const TG_FETCH_TIMEOUT = 15000;

/**
 * Telegram Bot API helper (sendDocument / deleteMessage / sendMessage).
 * Uses native fetch + FormData — works on Node 18+ and Bun.
 * apiBase is configurable so users behind filtered networks can point to a mirror.
 *
 * SIZE POLICY — a backup is ALWAYS delivered as ONE complete file.
 * The archive is never split into parts and never rebuilt, no matter its
 * size. The official endpoint caps one sendDocument at 50 MB (and a local
 * Bot API server at 2 GB); a larger file is reported as an error instead
 * of being split — preserving the panel's original full backup exactly.
 */

export interface TgResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

/** Configured endpoint — the official API by default; the "Telegram API base"
 *  field in Settings may point at a local Bot API server (2GB single-file). */
function tgBase(cfg: AppConfig): string {
  return (cfg.telegramApiBase || "").trim().replace(/\/+$/, "") || "https://api.telegram.org";
}

function isLocalBase(cfg: AppConfig): boolean {
  return !/api\.telegram\.org$/.test(tgBase(cfg));
}

/** Uploads can be huge - 45MB parts on the official endpoint, up to a 2GB
 *  single file on a local Bot API server. Control calls keep the short 15s. */
function uploadTimeoutMs(cfg: AppConfig): number {
  return isLocalBase(cfg) ? 3_600_000 : 600_000;
}

function tgUrl(cfg: AppConfig, method: string): string {
  return `${tgBase(cfg)}/bot${cfg.telegramBotToken.trim()}/${method}`;
}

function captionFor(fileName: string, size: number, method: string, panel: string): string {
  const sizeStr = size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : `${(size / 1024).toFixed(1)} KB`;
  const title = panel === "hmpanel"
    ? "HM PANEL BACKUP"
    : panel === "pasarguard"
      ? "PASARGUARD BACKUP"
      : panel === "rebecca"
        ? "REBECCA BACKUP"
        : "3X-UI PANEL BACKUP";
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
  const date = `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
  return [
    `<b>${title}</b>`,
    `File: <code>${esc(fileName)}</code>`,
    `Size: ${sizeStr}`,
    `Date: ${date}`,
  ].join("\n");
}

/** One sendDocument call — no size check here, callers go through sendBackupDocument. */
async function sendOneDocument(
  cfg: AppConfig,
  buf: Buffer,
  fileName: string,
  caption: string
): Promise<TgResult<{ messageId: number }>> {
  let lastError: Bi | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 3000));
    try {
      const fd = new FormData();
      fd.append("chat_id", cfg.telegramChatId.trim());
      if (cfg.telegramThreadId.trim()) fd.append("message_thread_id", cfg.telegramThreadId.trim());
      fd.append("caption", caption);
      fd.append("parse_mode", "HTML");
      fd.append(
        "document",
        new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }),
        fileName
      );

      const res = await fetch(tgUrl(cfg, "sendDocument"), {
      signal: AbortSignal.timeout(uploadTimeoutMs(cfg)), method: "POST", body: fd });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: { message_id?: number }; description?: string }
        | null;

      if (res.status === 429) {
        lastError = bi(
          `محدودیت نرخ تلگرام (429)${body?.description ? ": " + body.description : ""}`,
          `Telegram rate limit (429)${body?.description ? ": " + body.description : ""}`
        );
        continue;
      }
      if (res.ok && body?.ok && body.result?.message_id) {
        return { ok: true, data: { messageId: body.result.message_id } };
      }
      lastError = body?.description
        ? bi(`تلگرام: ${body.description}`, `Telegram: ${body.description}`)
        : bi(`HTTP ${res.status}`, `HTTP ${res.status}`);
      // 4xx (except 429) are permanent — do not retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e: unknown) {
      const t = e instanceof Error ? e.message : String(e);
      const code = (e as { cause?: { code?: string } })?.cause?.code ?? "";
      // retry ONLY when the upload certainly never reached Telegram (DNS,
      // refused connection). Anything ambiguous — a timeout or a reset
      // mid-upload — may already be delivered; retrying would send the SAME
      // file twice, so fail the cycle instead.
      if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
        lastError = bi(t, t);
        continue;
      }
      const ambiguous = /timeout|abort|reset|ETIMEDOUT|ECONNABORTED|ECONNRESET|socket/i.test(t) || /timeout|abort/i.test(code);
      lastError = ambiguous
        ? bi(
            "ارسال قطع شد — فایل ممکن است رسیده باشد؛ برای جلوگیری از ارسال تکراری، دوباره تلاش نشد",
            "The upload was interrupted - the file may have been delivered; not retrying to avoid a duplicate"
          )
        : bi(t, t);
      break;
    }
  }
  return lastError
    ? { ok: false, error: lastError.fa, errorBi: lastError }
    : fail("ارسال به تلگرام ناموفق بود", "Sending to Telegram failed");
}

/** Translate low-level fetch failures into a plain English cause. */
function fetchCause(e: unknown): string | null {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const cause = (e as { cause?: { code?: string } })?.cause?.code ?? "";
  if (raw.includes("fetch failed") || cause === "ENOTFOUND") return "the Telegram endpoint is unreachable from this server - check the server's internet/DNS";
  if (cause === "ECONNREFUSED" || raw.includes("ECONNREFUSED")) return "the connection to the Telegram endpoint was refused - check the firewall/outbound access";
  if (cause === "ETIMEDOUT" || cause === "ECONNABORTED" || raw.includes("timeout")) return "the connection to api.telegram.org timed out";
  return null;
}

export type TgPanel = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";

/**
 * Send a backup to Telegram — ONE complete file, ALWAYS.
 * The archive is never split into .part files and never re-packed: the exact
 * buffer produced by the panel's full backup is delivered as one sendDocument.
 */
export async function sendBackupDocument(
  cfg: AppConfig,
  buf: Buffer,
  fileName: string,
  method: string,
  panel: TgPanel = "3x-ui"
): Promise<TgResult<{ messageIds: number[] }>> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام تنظیم نشده است", "The Telegram bot token is not configured");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام تنظیم نشده است", "The Telegram chat ID is not configured");

  const r = await sendOneDocument(cfg, buf, fileName, captionFor(fileName, buf.length, method, panel));
  if (!r.ok) return { ok: false, error: r.error, errorBi: r.errorBi };
  return { ok: true, data: { messageIds: [r.data!.messageId] } };
}

/** Send a single document (compat helper — used for small ad-hoc files). */
export async function sendDocument(
  cfg: AppConfig,
  buf: Buffer,
  fileName: string,
  method: string,
  panel: TgPanel = "3x-ui"
): Promise<TgResult<{ messageId: number }>> {
  const r = await sendBackupDocument(cfg, buf, fileName, method, panel);
  if (!r.ok || !r.data) return { ok: false, error: r.error, errorBi: r.errorBi };
  return { ok: true, data: { messageId: r.data.messageIds[0] } };
}

/** Delete a previously sent backup message (for auto-cleanup). */
export async function deleteMessage(cfg: AppConfig, messageId: number): Promise<TgResult> {
  try {
    const res = await fetch(tgUrl(cfg, "deleteMessage"), {
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId.trim(), message_id: messageId }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (res.ok && body?.ok) return { ok: true };
    return body?.description
      ? { ok: false, error: body.description }
      : { ok: false, error: `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: fetchCause(e) ?? (e instanceof Error ? e.message : String(e)) };
  }
}

/** Send an arbitrary text message (update notices, etc.). */
export async function sendMessage(cfg: AppConfig, text: string): Promise<TgResult> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام تنظیم نشده است", "The Telegram bot token is not configured");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام تنظیم نشده است", "The Telegram chat ID is not configured");
  try {
    const res = await fetch(tgUrl(cfg, "sendMessage"), {
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId.trim(),
        ...(cfg.telegramThreadId.trim() ? { message_thread_id: cfg.telegramThreadId.trim() } : {}),
        text,
      }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (res.ok && body?.ok) return { ok: true };
    return { ok: false, error: body?.description ?? `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: fetchCause(e) ?? (e instanceof Error ? e.message : String(e)) };
  }
}

/** Send a plain text message — used by the "Test Telegram" button. */
export async function sendTestMessage(cfg: AppConfig): Promise<TgResult> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام را وارد کنید", "Enter the Telegram bot token");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام را وارد کنید", "Enter the Telegram chat ID");
  try {
    const res = await fetch(tgUrl(cfg, "sendMessage"), {
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId.trim(),
        ...(cfg.telegramThreadId.trim() ? { message_thread_id: cfg.telegramThreadId.trim() } : {}),
        text: "✅ bkup bot connection is live.\nBackups will be delivered to this chat from now on.",
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;
    if (res.ok && body?.ok) return { ok: true };
    return body?.description
      ? { ok: false, error: body.description }
      : { ok: false, error: `HTTP ${res.status}` };
  } catch (e: unknown) {
    const t = e instanceof Error ? e.message : String(e);
    return fail(`خطای اتصال به تلگرام: ${t}`, `Telegram connection error: ${t}`);
  }
}
