import axios, { type AxiosInstance } from "axios";
import https from "node:https";
import http from "node:http";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * 3x-ui panel API client.
 *
 * Verified against MHSanaei/3x-ui source:
 *  - v2.x: POST {base}/login (no CSRF)                 -> session cookie "3x-ui"
 *  - v3.x: GET {base}/csrf-token -> POST {base}/login  -> session cookie "3x-ui"
 *          (login POST requires header "X-CSRF-Token")
 *  - Both: GET {base}/panel/api/server/getDb           -> raw DB file (octet-stream)
 *  - Both: GET {base}/panel/api/inbounds/list          -> { success, obj: [...] }
 *  - Both: POST {base}/panel/setting/all               -> { success, obj: {...} }
 *  - v3.x additionally supports "Authorization: Bearer <api-token>" (admin scope)
 */

export interface PanelSession {
  cookie: string;
  flavor: "v3" | "v2" | "unknown";
  loggedInAt: number;
}

export interface PanelRequestResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

const SESSION_TTL_MS = 10 * 60 * 1000; // reuse session cookie for 10 minutes

const g = globalThis as unknown as { __xuiPanelSession?: PanelSession | null };

/** Normalize panel URL + base path into a clean origin + path prefix. */
export function buildBaseUrl(cfg: Pick<AppConfig, "panelUrl" | "panelBasePath">): string {
  let url = cfg.panelUrl.trim().replace(/\/+$/, "");
  let base = cfg.panelBasePath.trim().replace(/\/+$/, "");
  if (base && !base.startsWith("/")) base = "/" + base;
  return url + base;
}

function axiosFor(cfg: AppConfig, timeout = 15000): AxiosInstance {
  const insecure = cfg.skipTlsVerify;
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ rejectUnauthorized: !insecure, keepAlive: true });
  return axios.create({
    timeout,
    httpAgent,
    httpsAgent,
    maxRedirects: 5,
    validateStatus: () => true, // handle status codes ourselves
    headers: { "User-Agent": "bkup/1.0" },
  });
}

function setCookieFromResponse(ax: AxiosInstance, cookie: string) {
  // keep cookies on the instance for subsequent calls (axios has no jar; we do it manually)
  ax.defaults.headers.common["Cookie"] = cookie;
}

/** Clear the cached panel session (e.g. after 401 or config change). */
export function invalidateSession() {
  g.__xuiPanelSession = null;
}

/** Login to the panel and cache the session cookie. Handles v2 & v3 flows. */
export async function login(cfg: AppConfig, force = false): Promise<PanelRequestResult<PanelSession>> {
  if (!force) {
    const cached = g.__xuiPanelSession;
    if (cached && Date.now() - cached.loggedInAt < SESSION_TTL_MS) {
      return { ok: true, data: cached };
    }
  }

  const base = buildBaseUrl(cfg);
  if (!base) return fail("آدرس پنل تنظیم نشده است", "Panel URL is not configured");

  const ax = axiosFor(cfg);
  let flavor: PanelSession["flavor"] = "unknown";

  try {
    if (cfg.authMode === "bearer") {
      // v3 admin API token — no login needed
      const session: PanelSession = { cookie: "", flavor: "v3", loggedInAt: Date.now() };
      g.__xuiPanelSession = session;
      return { ok: true, data: session };
    }

    // v3 flow first: fetch CSRF token (v2 panels return 404 here)
    const csrfRes = await ax.get(`${base}/csrf-token`, { headers: { Accept: "application/json" } });
    let csrfToken: string | null = null;
    if (csrfRes.status === 200 && csrfRes.data?.success && csrfRes.data?.obj) {
      csrfToken = String(csrfRes.data.obj);
      flavor = "v3";
      const rawCookies = csrfRes.headers["set-cookie"];
      if (rawCookies?.length) setCookieFromResponse(ax, rawCookies.map(splitCookie).join("; "));
    } else {
      flavor = "v2";
    }

    const loginHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (csrfToken) loginHeaders["X-CSRF-Token"] = csrfToken;

    const loginRes = await ax.post(
      `${base}/login`,
      { username: cfg.panelUsername, password: cfg.panelPassword },
      { headers: loginHeaders }
    );

    const body = loginRes.data as { success?: boolean; msg?: string } | string | undefined;
    const success = typeof body === "object" && body !== null && body.success === true;

    if (loginRes.status !== 200 || !success) {
      const msg =
        typeof body === "object" && body?.msg
          ? body.msg
          : `HTTP ${loginRes.status}`;
      invalidateSession();
      return { ...fail(`ورود به پنل ناموفق بود: ${msg}`, `Panel login failed: ${msg}`), status: loginRes.status };
    }

    const rawCookies = loginRes.headers["set-cookie"];
    if (!rawCookies?.length) {
      return fail("پنل کوکی سشن برنگرداند", "The panel did not return a session cookie");
    }
    const cookie = rawCookies.map(splitCookie).join("; ");

    const session: PanelSession = { cookie, flavor, loggedInAt: Date.now() };
    g.__xuiPanelSession = session;
    return { ok: true, data: session };
  } catch (e: unknown) {
    invalidateSession();
    const m = errMsg(e);
    return fail(`خطای اتصال به پنل: ${m.fa}`, `Panel connection error: ${m.en}`);
  }
}

function splitCookie(raw: string): string {
  return raw.split(";")[0].trim();
}

/** Auth headers for an authenticated request using the cached session. */
function authHeaders(cfg: AppConfig, session: PanelSession): Record<string, string> {
  if (cfg.authMode === "bearer") {
    return { Authorization: `Bearer ${cfg.apiToken.trim()}` };
  }
  return session.cookie ? { Cookie: session.cookie } : {};
}

/** Download the raw panel database file. Returns binary Buffer. */
export async function getDb(
  cfg: AppConfig,
  session: PanelSession
): Promise<PanelRequestResult<{ buf: Buffer; filename: string }>> {
  const base = buildBaseUrl(cfg);
  const ax = axiosFor(cfg, 60000);
  try {
    const res = await ax.get(`${base}/panel/api/server/getDb`, {
      headers: authHeaders(cfg, session),
      responseType: "arraybuffer",
    });
    if (res.status === 401 || res.status === 404) {
      return { ...fail(`احراز هویت نامعتبر است (HTTP ${res.status})`, `Invalid authentication (HTTP ${res.status})`), status: res.status };
    }
    if (res.status !== 200) {
      return { ...fail(`دانلود دیتابیس ناموفق (HTTP ${res.status})`, `Database download failed (HTTP ${res.status})`), status: res.status };
    }
    const buf = Buffer.from(res.data);
    // Some panels return JSON errors with 200 — detect and reject
    const ct = String(res.headers["content-type"] ?? "");
    if (ct.includes("application/json") || (buf.length > 0 && buf[0] === 0x7b && buf[1] === 0x22)) {
      let msg = bi("پاسخ JSON به‌جای فایل دیتابیس", "The panel answered with JSON instead of the database file");
      try {
        const j = JSON.parse(buf.toString("utf8"));
        if (j?.msg) msg = bi(String(j.msg), String(j.msg));
      } catch { /* ignore */ }
      return { ok: false, error: msg.fa, errorBi: msg };
    }
    if (buf.length === 0) return fail("فایل دیتابیس خالی بود", "The database file was empty");
    const cd = String(res.headers["content-disposition"] ?? "");
    const m = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    return { ok: true, data: { buf, filename: m?.[1] ?? "x-ui.db" } };
  } catch (e: unknown) {
    const m = errMsg(e);
    return fail(`خطای دانلود دیتابیس: ${m.fa}`, `Database download error: ${m.en}`);
  }
}

/** Fetch full inbounds + panel settings and build a JSON config backup. */
export async function getJsonExport(
  cfg: AppConfig,
  session: PanelSession
): Promise<PanelRequestResult<{ json: string }>> {
  const base = buildBaseUrl(cfg);
  const ax = axiosFor(cfg);
  const headers = authHeaders(cfg, session);
  try {
    const inb = await ax.get(`${base}/panel/api/inbounds/list`, { headers });
    if (inb.status !== 200 || inb.data?.success !== true) {
      return fail(`دریافت اینباندها ناموفق بود (HTTP ${inb.status})`, `Fetching inbounds failed (HTTP ${inb.status})`);
    }
    const st = await ax.post(`${base}/panel/setting/all`, null, { headers });
    const settings = st.status === 200 && st.data?.success === true ? st.data.obj : null;

    const payload = {
      _meta: {
        source: "bkup",
        panelUrl: cfg.panelUrl,
        exportedAt: new Date().toISOString(),
        note: "Config export. Inbounds can be re-imported from panel UI; settings are for reference.",
      },
      inbounds: inb.data.obj ?? [],
      settings,
    };
    return { ok: true, data: { json: JSON.stringify(payload, null, 2) } };
  } catch (e: unknown) {
    const m = errMsg(e);
    return fail(`خطای ساخت خروجی JSON: ${m.fa}`, `JSON export error: ${m.en}`);
  }
}

/** Lightweight connection test used by the "تست اتصال" button. */
export async function testConnection(
  cfg: AppConfig
): Promise<PanelRequestResult<{ inboundCount: number; flavor: string }>> {
  const base = buildBaseUrl(cfg);
  if (!cfg.panelUrl.trim()) return fail("آدرس پنل را وارد کنید", "Enter the panel URL");

  if (cfg.authMode === "bearer") {
    if (!cfg.apiToken.trim()) return fail("توکن API را وارد کنید", "Enter the API token");
    const ax = axiosFor(cfg);
    try {
      const res = await ax.get(`${base}/panel/api/inbounds/list`, {
        headers: { Authorization: `Bearer ${cfg.apiToken.trim()}` },
      });
      if (res.status !== 200 || res.data?.success !== true) {
        return fail(`توکن API نامعتبر است (HTTP ${res.status})`, `Invalid API token (HTTP ${res.status})`);
      }
      return { ok: true, data: { inboundCount: (res.data.obj ?? []).length, flavor: "v3 (token)" } };
    } catch (e: unknown) {
      const m = errMsg(e);
      return fail(`خطای اتصال: ${m.fa}`, `Connection error: ${m.en}`);
    }
  }

  if (!cfg.panelUsername.trim() || !cfg.panelPassword) {
    return fail("نام کاربری و رمز عبور پنل را وارد کنید", "Enter the panel username and password");
  }
  const loginRes = await login(cfg, true);
  if (!loginRes.ok || !loginRes.data) return { ok: false, error: loginRes.error, errorBi: loginRes.errorBi };

  const ax = axiosFor(cfg);
  try {
    const res = await ax.get(`${base}/panel/api/inbounds/list`, {
      headers: authHeaders(cfg, loginRes.data),
    });
    if (res.status === 401 || res.status === 404) {
      return fail("سشن پذیرفته نشد — مسیر پایه یا مشخصات را بررسی کنید", "Session was rejected — check the base path or credentials");
    }
    if (res.status !== 200 || res.data?.success !== true) {
      return fail(`اتصال برقرار شد ولی دریافت داده ناموفق بود (HTTP ${res.status})`, `Connected, but fetching data failed (HTTP ${res.status})`);
    }
    return {
      ok: true,
      data: { inboundCount: (res.data.obj ?? []).length, flavor: loginRes.data.flavor },
    };
  } catch (e: unknown) {
    const m = errMsg(e);
    return fail(`خطای اتصال: ${m.fa}`, `Connection error: ${m.en}`);
  }
}

/** Bilingual axios error text. */
function errMsg(e: unknown): Bi {
  if (axios.isAxiosError(e)) {
    if (e.code === "ECONNREFUSED") return bi("اتصال رد شد (پنل در دسترس نیست)", "Connection refused (panel is unreachable)");
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
