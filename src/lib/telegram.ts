import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * Telegram Bot API helper (sendDocument / deleteMessage).
 * Uses native fetch + FormData — works on Node 18+ and Bun.
 * apiBase is configurable so users behind filtered networks can point to a mirror.
 */

export interface TgResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

function tgUrl(cfg: AppConfig, method: string): string {
  const base = cfg.telegramApiBase.trim().replace(/\/+$/, "") || "https://api.telegram.org";
  return `${base}/bot${cfg.telegramBotToken.trim()}/${method}`;
}

function captionFor(fileName: string, size: number, method: string, panel = "3x-ui"): string {
  const now = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(new Date());
  const sizeStr = size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} مگابایت`
    : `${(size / 1024).toFixed(1)} کیلوبایت`;
  const isHm = panel === "hmpanel" || method === "hm-full";
  const isPg = panel === "pasarguard" || method === "pg-full";
  const methodFa = isPg
    ? "بکاپ کامل (کاربران + هاست‌ها + نودها + کورها + گروه‌ها + تنظیمات)"
    : isHm
      ? "بکاپ کامل (دیتابیس + تنظیمات + آپلودها)"
      : method === "db"
        ? "فایل دیتابیس"
        : method === "local"
          ? "فایل دیتابیس (لوکال)"
          : "خروجی JSON";
  const title = isPg ? "🗄 بکاپ خودکار PasarGuard" : isHm ? "🗄 بکاپ خودکار HM Panel" : "🗄 بکاپ خودکار 3X-UI";
  return [
    title,
    `⏰ ${now}`,
    `💾 ${fileName}`,
    `📦 ${sizeStr}`,
    `🔧 نوع: ${methodFa}`,
  ].join("\n");
}

/** Send a file as a document message. Retries up to 2 times on transient failures. */
export async function sendDocument(
  cfg: AppConfig,
  buf: Buffer,
  fileName: string,
  method: string,
  panel: "3x-ui" | "hmpanel" | "pasarguard" = "3x-ui"
): Promise<TgResult<{ messageId: number }>> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام تنظیم نشده است", "The Telegram bot token is not configured");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام تنظیم نشده است", "The Telegram chat ID is not configured");
  if (buf.length > 48 * 1024 * 1024) {
    return fail("حجم فایل بیش از حد مجاز تلگرام (50MB) است", "The file exceeds the Telegram size limit (50MB)");
  }

  let lastError: Bi | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 3000));
    try {
      const fd = new FormData();
      fd.append("chat_id", cfg.telegramChatId.trim());
      if (cfg.telegramThreadId.trim()) fd.append("message_thread_id", cfg.telegramThreadId.trim());
      fd.append("caption", captionFor(fileName, buf.length, method, panel));
      fd.append(
        "document",
        new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }),
        fileName
      );

      const res = await fetch(tgUrl(cfg, "sendDocument"), { method: "POST", body: fd });
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
      lastError = bi(t, t);
    }
  }
  return lastError
    ? { ok: false, error: lastError.fa, errorBi: lastError }
    : fail("ارسال به تلگرام ناموفق بود", "Sending to Telegram failed");
}

/** Delete a previously sent backup message (for auto-cleanup). */
export async function deleteMessage(cfg: AppConfig, messageId: number): Promise<TgResult> {
  try {
    const res = await fetch(tgUrl(cfg, "deleteMessage"), {
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Send an arbitrary text message (update notices, etc.). */
export async function sendMessage(cfg: AppConfig, text: string): Promise<TgResult> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام تنظیم نشده است", "The Telegram bot token is not configured");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام تنظیم نشده است", "The Telegram chat ID is not configured");
  try {
    const res = await fetch(tgUrl(cfg, "sendMessage"), {
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Send a plain text message — used by the "تست تلگرام" button. */
export async function sendTestMessage(cfg: AppConfig): Promise<TgResult> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام را وارد کنید", "Enter the Telegram bot token");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام را وارد کنید", "Enter the Telegram chat ID");
  try {
    const res = await fetch(tgUrl(cfg, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId.trim(),
        ...(cfg.telegramThreadId.trim() ? { message_thread_id: cfg.telegramThreadId.trim() } : {}),
        text: "✅ اتصال بات bkup برقرار است.\nاز این پس بکاپ‌ها به این چت ارسال می‌شوند.",
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
