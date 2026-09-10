import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * Telegram Bot API helper (sendDocument / deleteMessage / sendMessage).
 * Uses native fetch + FormData — works on Node 18+ and Bun.
 * apiBase is configurable so users behind filtered networks can point to a mirror.
 *
 * SIZE POLICY — backups are sent NO MATTER HOW BIG they are:
 * the Bot API hard-caps one sendDocument at 50 MB, so larger backups are
 * SPLIT into 45 MB parts and every part is delivered (filename.partNNofNN).
 * There is no "file too large" rejection anywhere in the pipeline anymore.
 */

export interface TgResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

/** One sendDocument may carry at most 50 MB — stay safely below it. */
const PART_LIMIT = 45 * 1024 * 1024;

function tgUrl(cfg: AppConfig, method: string): string {
  const base = cfg.telegramApiBase.trim().replace(/\/+$/, "") || "https://api.telegram.org";
  return `${base}/bot${cfg.telegramBotToken.trim()}/${method}`;
}

function captionFor(fileName: string, size: number, method: string, panel: string, premium = false): string {
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
  const sizeStr = size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : `${(size / 1024).toFixed(1)} KB`;
  const isHm = panel === "hmpanel" || method === "hm-full";
  const isPg = panel === "pasarguard" || method === "pg-full";
  const isRb = panel === "rebecca" || method === "rb-full";
  const methodEn = isPg
    ? "Full backup (users + hosts + nodes + cores + groups + settings)"
    : isHm
      ? (premium ? "Full backup (database + config + uploads + premium modules)" : "Full backup (database + config + uploads)")
      : isRb
        ? "Full backup (database + configuration)"
        : method === "db"
          ? "Database file"
          : method === "local"
            ? "Database file (local copy)"
            : "JSON export";
  const title = isPg
    ? "🗄 PasarGuard automatic backup"
    : isHm
      ? "🗄 HM Panel automatic backup"
      : isRb
        ? "🗄 Rebecca automatic backup"
        : "🗄 3X-UI automatic backup";
  const lines = [
    title,
    `🕒 ${now}`,
    `💾 ${fileName}`,
    `📦 ${sizeStr}`,
    `🔧 Type: ${methodEn}`,
  ];
  if (isHm && premium) lines.push(`⭐ Edition: Premium (full premium data included)`);
  return lines.join("\n");
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

/** Live progress message — one message per backup, edited through the cycle. */
export async function sendProgressMessage(cfg: AppConfig, text: string): Promise<TgResult<{ messageId: number }>> {
  if (!cfg.telegramBotToken.trim() || !cfg.telegramChatId.trim()) {
    return fail("توکن بات یا آیدی چت تلگرام تنظیم نشده است", "The Telegram bot token or chat ID is not configured");
  }
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
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (res.ok && body?.ok && body.result?.message_id) return { ok: true, data: { messageId: body.result.message_id } };
    return { ok: false, error: body?.description ?? `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Edit a progress message in place — failures are non-fatal by design. */
export async function editProgressMessage(cfg: AppConfig, messageId: number, text: string): Promise<void> {
  try {
    await fetch(tgUrl(cfg, "editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId.trim(),
        ...(cfg.telegramThreadId.trim() ? { message_thread_id: cfg.telegramThreadId.trim() } : {}),
        message_id: messageId,
        text,
      }),
    });
  } catch { /* progress edits must never break the backup flow */ }
}

export type TgPanel = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";

/**
 * Send a backup to Telegram — ANY size. Files above the Bot API single-file
 * limit are split into ≤45 MB parts and every part is sent with its own
 * "part i of N" caption. Returns ALL message ids (for auto-cleanup).
 */
export async function sendBackupDocument(
  cfg: AppConfig,
  buf: Buffer,
  fileName: string,
  method: string,
  panel: TgPanel = "3x-ui"
): Promise<TgResult<{ messageIds: number[]; parts: number; deliveredSingleFile?: boolean }>> {
  if (!cfg.telegramBotToken.trim()) return fail("توکن بات تلگرام تنظیم نشده است", "The Telegram bot token is not configured");
  if (!cfg.telegramChatId.trim()) return fail("آیدی چت تلگرام تنظیم نشده است", "The Telegram chat ID is not configured");

  const premium = panel === "hmpanel" && Boolean((cfg as { hmPremium?: boolean }).hmPremium);

  // ALWAYS attempt one complete file first — no splitting by default. Only if
  // the endpoint itself rejects the size (the public Bot API caps at 50 MB)
  // does the automatic multi-part fallback below kick in.
  const single = await sendOneDocument(cfg, buf, fileName, captionFor(fileName, buf.length, method, panel, premium));
  if (single.ok) {
    return { ok: true, data: { messageIds: [single.data!.messageId], parts: 1, deliveredSingleFile: true } };
  }
  const sizeRejected = /too (big|large)|entity too large|file is too big|413/i.test(single.errorBi?.en ?? single.error ?? "");
  if (!sizeRejected) return { ok: false, error: single.error, errorBi: single.errorBi };

  // split into parts — every part WILL be delivered
  const total = Math.ceil(buf.length / PART_LIMIT);
  const width = String(total).padStart(2, "0");
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const messageIds: number[] = [];
  for (let i = 0; i < total; i++) {
    const part = buf.subarray(i * PART_LIMIT, Math.min((i + 1) * PART_LIMIT, buf.length));
    const partName = `${stem}.part${String(i + 1).padStart(2, "0")}of${width}${ext}`;
    const caption =
      captionFor(partName, part.length, method, panel, premium) +
      `\n🧩 Part ${i + 1} of ${total} — rejoin with: cat ${stem}.part*of*${ext} > ${fileName}`;
    const r = await sendOneDocument(cfg, part, partName, caption);
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        errorBi: r.errorBi,
        ...(messageIds.length ? { data: { messageIds, parts: messageIds.length } } : {}),
      };
    }
    messageIds.push(r.data!.messageId);
  }
  return { ok: true, data: { messageIds, parts: messageIds.length, deliveredSingleFile: false } };
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

/** Send a plain text message — used by the "Test Telegram" button. */
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
