import axios, { type AxiosInstance } from "axios";
import https from "node:https";
import http from "node:http";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * Rebecca (rebeccapanel/Rebecca) API client.
 *
 * Verified against the OFFICIAL repo source (master, 2026-09):
 *  - POST {base}/api/admin/token   (also accepts /admin/token)
 *      -> 200 { "access_token": "…", "token_type": "bearer" }
 *    Body: JSON {username, password} — a form-encoded body is retried once,
 *    so both request styles work against any Rebecca build.
 *  - All admin routes:  Authorization: Bearer <access_token>
 *  - GET {base}/api/settings/backup/export
 *      -> FULL backup archive (binary download; Content-Disposition carries
 *         the official filename). This is Rebecca's own complete export —
 *         database + configuration — exactly what its dashboard and
 *         Telegram integration produce. Requires a binary-runtime install.
 *  - GET {base}/api/admin -> current admin (used as the token validation probe)
 *
 * Token TTL is short (Marzban-family JWT) — the client re-logins per backup,
 * keeping every cycle self-sufficient and stateless.
 */

export interface RbResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

const REQ_TIMEOUT_MS = 30 * 1000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

function axiosFor(cfg: AppConfig, timeout = REQ_TIMEOUT_MS): AxiosInstance {
  return axios.create({
    timeout,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.skipTlsVerify, keepAlive: true }),
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { "User-Agent": "bkup/1.0", Accept: "application/json" },
  });
}

/** Normalize the panel URL: scheme, no trailing slash. */
export function rbNormalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** Bilingual axios error text. */
function rbErrMsg(e: unknown): Bi {
  if (axios.isAxiosError(e)) {
    if (e.code === "ECONNREFUSED") return bi("اتصال رد شد (سرویس Rebecca در دسترس نیست)", "Connection refused (the Rebecca service is unreachable)");
    if (e.code === "ETIMEDOUT" || e.code === "ECONNABORTED") return bi("مهلت اتصال به پایان رسید", "The connection timed out");
    if (e.code === "ENOTFOUND") return bi("هاست پیدا نشد", "Host not found");
    if (e.code === "CERT_HAS_EXPIRED" || e.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      return bi("گواهی SSL نامعتبر است (گزینه نادیده‌گرفتن SSL را فعال کنید)", "Invalid SSL certificate (enable the ignore-SSL option)");
    }
    return bi(e.message, e.message);
  }
  const t = e instanceof Error ? e.message : String(e);
  return bi(t, t);
}

/** Login → Bearer token. Accepts any 2xx with access_token (JSON body, form fallback). */
async function rbLogin(cfg: AppConfig): Promise<RbResult<{ token: string }>> {
  if (!cfg.rebeccaUrl.trim()) return fail("آدرس Rebecca تنظیم نشده است", "Rebecca URL is not configured");
  if (!cfg.rebeccaUsername.trim() || !cfg.rebeccaPassword) {
    return fail("نام کاربری و رمز عبور Rebecca را وارد کنید (حساب ادمین)", "Enter the Rebecca username and password (an admin account)");
  }

  const base = rbNormalizeUrl(cfg.rebeccaUrl);
  const ax = axiosFor(cfg);
  const creds = { username: cfg.rebeccaUsername.trim(), password: cfg.rebeccaPassword };

  let res;
  try {
    res = await ax.post(`${base}/api/admin/token`, creds, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
    // some builds expect an OAuth2 form body — retry once
    if (res.status < 200 || res.status >= 300) {
      const form = new URLSearchParams(creds);
      res = await ax.post(`${base}/api/admin/token`, form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      });
    }
  } catch (e: unknown) {
    const m = rbErrMsg(e);
    return fail(`ورود به Rebecca ناموفق بود: ${m.fa}`, `Rebecca login failed: ${m.en}`);
  }

  const body = (res.data ?? {}) as Record<string, unknown>;
  const tokenRaw =
    (typeof body.access_token === "string" && body.access_token) ||
    (typeof body.accessToken === "string" && body.accessToken) ||
    (typeof body.token === "string" && body.token) ||
    "";

  if (res.status >= 200 && res.status < 300 && tokenRaw) {
    return { ok: true, data: { token: String(tokenRaw) } };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...fail(
        "ورود به Rebecca ناموفق بود — نام کاربری/رمز عبور اشتباه است یا این حساب غیرفعال شده",
        "Rebecca login failed — wrong username/password or this account is disabled"
      ),
      status: res.status,
    };
  }
  return {
    ...fail(
      `ورود به Rebecca ناموفق بود (HTTP ${res.status} روی ${base})`,
      `Rebecca login failed (HTTP ${res.status} on ${base})`
    ),
    status: res.status,
  };
}

/** Download Rebecca's own FULL backup export (database + configuration). */
export async function rbFullBackup(
  cfg: AppConfig
): Promise<RbResult<{ buf: Buffer; fileName: string; size: number }>> {
  const login = await rbLogin(cfg);
  if (!login.ok || !login.data) return { ok: false, error: login.error, errorBi: login.errorBi };

  const base = rbNormalizeUrl(cfg.rebeccaUrl);
  const ax = axiosFor(cfg, EXPORT_TIMEOUT_MS);
  const auth = { Authorization: `Bearer ${login.data.token}` };

  let res;
  try {
    res = await ax.get(`${base}/api/settings/backup/export`, {
      headers: auth,
      responseType: "arraybuffer",
    });
    // some builds want an explicit scope — retry once with scope=full
    if (res.status >= 400) {
      res = await ax.get(`${base}/api/settings/backup/export`, {
        headers: auth,
        params: { scope: "full" },
        responseType: "arraybuffer",
      });
    }
  } catch (e: unknown) {
    const m = rbErrMsg(e);
    return fail(`ساخت بکاپ روی Rebecca ناموفق بود: ${m.fa}`, `Creating the Rebecca backup failed: ${m.en}`);
  }

  if (res.status === 401 || res.status === 403) {
    return fail("دانلود بکاپ Rebecca مجاز نشد (دسترسی ادمین لازم است)", "The Rebecca backup download was not allowed (admin access required)");
  }
  if (res.status === 409) {
    return fail("بکاپ Rebecca در این نصب غیرفعال است (فقط نصب باینری)", "Rebecca backups are disabled on this install (binary runtime only)");
  }
  if (res.status >= 300) {
    return fail(`دانلود بکاپ Rebecca ناموفق بود (HTTP ${res.status})`, `Downloading the Rebecca backup failed (HTTP ${res.status})`);
  }

  const buf = Buffer.from(res.data);
  if (buf.length === 0) return fail("فایل بکاپ Rebecca خالی بود", "The Rebecca backup file was empty");
  // a JSON error body would arrive as 200 with JSON — reject it
  if (buf[0] === 0x7b && buf[1] === 0x22) {
    return fail("پاسخ Rebecca به‌جای فایل بکاپ، JSON بود", "Rebecca answered with JSON instead of the backup file");
  }

  const cd = String(res.headers["content-disposition"] ?? "");
  const m = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  const fileName = m?.[1] ?? `rebecca-backup-${Date.now()}.zip`;
  return { ok: true, data: { buf, fileName, size: buf.length } };
}

/** Connection test used by the test button: login → validate token → report. */
export async function rbTestConnection(
  cfg: AppConfig
): Promise<RbResult<{ base: string; username: string }>> {
  const login = await rbLogin(cfg);
  if (!login.ok || !login.data) return { ok: false, error: login.error, errorBi: login.errorBi };

  const base = rbNormalizeUrl(cfg.rebeccaUrl);
  const ax = axiosFor(cfg);
  try {
    const res = await ax.get(`${base}/api/admin`, {
      headers: { Authorization: `Bearer ${login.data.token}` },
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: { base, username: cfg.rebeccaUsername.trim() } };
    }
    return fail(
      `توکن پذیرفته نشد (HTTP ${res.status}) — نسخه پنل با API مورد انتظار فرق دارد`,
      `The token was rejected (HTTP ${res.status}) — the panel version differs from the expected API`
    );
  } catch (e: unknown) {
    const m = rbErrMsg(e);
    return fail(`خطای اتصال: ${m.fa}`, `Connection error: ${m.en}`);
  }
}
