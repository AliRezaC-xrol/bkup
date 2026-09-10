import axios, { type AxiosInstance } from "axios";
import { sharedHttpAgent, sharedHttpsAgent } from "@/lib/http-agents";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * HMPanel (neoauroraproject/hmpanel) API client.
 *
 * Verified against the OFFICIAL repo source + a live panel (2026-09):
 *  - GET  {base}/api/health   (NO auth) -> { status, version, mode, services }
 *  - POST {base}/api/auth/login  {username,password} -> HTTP **201** (!) { accessToken, refreshToken, admin }
 *    NestJS @Post default = 201 Created and the official auth controller has no
 *      @HttpCode(200) — so a SUCCESSFUL login answers 201, not 200. Any 2xx is
 *      accepted here (rejecting 201 was exactly the bug users saw in v3.2.0).
 *    (JWT Bearer; access token TTL 24h; login is rate-limited by nginx → cache the token)
 *  - POST {base}/api/backups  {"type":"full"} (Bearer, SUPER_ADMIN role)
 *    -> 201 { id, file, type, size }   (id IS the file name, e.g. backup_full_….tar.gz)
 *  - GET  {base}/api/backups/:id/download  (Bearer or ?token=) -> tar.gz bytes
 *
 * Deployment topologies:
 *  - standard install: nginx serves https://<host>/ and strips /api/ before the
 *    NestJS backend → public paths are /api/*
 *  - direct backend (port 4000, no nginx): paths live at the root, no /api
 *
 * Detection strategy (fixes the HTTP 404 users saw): BEFORE logging in we GET
 * /health on each candidate base — the correct base answers 200 unauthenticated,
 * wrong bases answer 404. Login then runs once, on the detected base only.
 */

export interface HmSession {
  token: string;
  base: string; // the base URL that works (…/api or bare backend)
  hmVersion?: string;
  premium?: boolean;
  loggedInAt: number;
}

export interface HmProbe {
  base: string;
  hmVersion?: string;
  premium?: boolean;
}

export interface HmResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

const TOKEN_TTL_MS = 23 * 3600 * 1000; // access tokens live 24h — re-login before expiry
const CREATE_TIMEOUT_MS = 15 * 60 * 1000; // full backup (pg_dumpall) can take minutes
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const g = globalThis as unknown as {
  __hmSession?: (HmSession & { key: string }) | null;
  __hmBase?: (HmProbe & { key: string }) | null;
};

/** Build candidate API bases to probe, most likely first. */
export function hmBaseCandidates(rawUrl: string): string[] {
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (!url) return [];
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const out: string[] = [];
  const hasPath = (() => {
    try {
      const u = new URL(url);
      return u.pathname !== "" && u.pathname !== "/";
    } catch {
      return false;
    }
  })();
  if (hasPath) {
    out.push(url);
    if (url.endsWith("/api")) out.push(url.slice(0, -4)); // strip /api → direct backend
    else out.push(`${url}/api`);
  } else {
    out.push(`${url}/api`); // nginx front (the standard install)
    out.push(url); // direct backend :4000
  }
  return [...new Set(out)];
}

function axiosFor(cfg: AppConfig, timeout = 20000): AxiosInstance {
  return axios.create({
    timeout,
    httpAgent: sharedHttpAgent(),
    httpsAgent: sharedHttpsAgent(cfg.skipTlsVerify),
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { "User-Agent": "bkup/1.0", Accept: "application/json" },
  });
}

/** Clear the cached HMPanel session (keeps the detected base). */
export function hmInvalidateSession() {
  g.__hmSession = null;
}

function cfgKey(cfg: AppConfig): string {
  return `${cfg.hmUrl}|${cfg.hmUsername}`;
}

/**
 * Detect which candidate base hosts the HMPanel API, via the unauthenticated
 * /health endpoint (200 → correct; 404 → wrong prefix). Result is cached.
 */
export async function hmDetectBase(cfg: AppConfig): Promise<HmResult<HmProbe>> {
  const key = cfgKey(cfg);
  if (g.__hmBase && g.__hmBase.key === key) return { ok: true, data: g.__hmBase };

  const candidates = hmBaseCandidates(cfg.hmUrl);
  if (candidates.length === 0) return fail("آدرس HMPanel تنظیم نشده است", "HMPanel URL is not configured");

  const ax = axiosFor(cfg, 12000);
  const tried: string[] = [];
  for (const base of candidates) {
    try {
      const res = await ax.get(`${base}/health`);
      // any 2xx + JSON object counts (a plain SPA would answer HTML string → rejected)
      if (res.status >= 200 && res.status < 300 && res.data && typeof res.data === "object") {
        const probe: HmProbe & { key: string } = {
          base,
          hmVersion: res.data.version ? String(res.data.version) : undefined,
          // Premium edition detection — the health payload carries mode/version
          premium: /premium/i.test(`${res.data.mode ?? ""} ${res.data.version ?? ""}`),
          key,
        };
        g.__hmBase = probe;
        return { ok: true, data: probe };
      }
      tried.push(`${base}/health → HTTP ${res.status}`);
    } catch (e: unknown) {
      tried.push(`${base}/health → ${hmErrMsg(e).fa}`);
    }
  }
  return fail(
    `اتصال به HMPanel برقرار نشد — هیچ‌کدام از مسیرهای API پیدا نشدند (${tried.join(" | ")})`,
    `Could not reach HMPanel — none of the API paths responded (${tried.join(" | ")})`
  );
}

/** Login to HMPanel and cache the JWT. Uses the health-detected base. */
export async function hmLogin(
  cfg: AppConfig,
  force = false
): Promise<HmResult<HmSession>> {
  const cached = g.__hmSession;
  if (!force && cached && cached.key === cfgKey(cfg) && Date.now() - cached.loggedInAt < TOKEN_TTL_MS) {
    return { ok: true, data: cached }; // access token valid ~24h; login is rate-limited → reuse
  }

  if (!cfg.hmUrl.trim()) return fail("آدرس HMPanel تنظیم نشده است", "HMPanel URL is not configured");
  if (!cfg.hmUsername.trim() || !cfg.hmPassword) {
    return fail("نام کاربری و رمز عبور HMPanel را وارد کنید (حساب SUPER_ADMIN)", "Enter the HMPanel username and password (a SUPER_ADMIN account)");
  }

  const probe = await hmDetectBase(cfg);
  if (!probe.ok || !probe.data) return { ok: false, error: probe.error, errorBi: probe.errorBi };

  const ax = axiosFor(cfg);
  let res;
  try {
    res = await ax.post(`${probe.data.base}/auth/login`, {
      username: cfg.hmUsername.trim(),
      password: cfg.hmPassword,
    });
  } catch (e: unknown) {
    const m = hmErrMsg(e);
    return fail(`ورود به HMPanel ناموفق بود: ${m.fa}`, `HMPanel login failed: ${m.en}`);
  }

  // 2xx = success (official hmpanel answers **201** on login — NestJS default).
  // Token field is accessToken in the official repo; tolerate common variants.
  const body = (res.data ?? {}) as Record<string, unknown>;
  const nested = body.data as Record<string, unknown> | undefined;
  const tokenRaw =
    (typeof body.accessToken === "string" && body.accessToken) ||
    (typeof body.access_token === "string" && body.access_token) ||
    (typeof body.token === "string" && body.token) ||
    (typeof body.jwt === "string" && body.jwt) ||
    (nested && typeof nested.accessToken === "string" && nested.accessToken) ||
    (nested && typeof nested.token === "string" && nested.token) ||
    "";
  if (res.status >= 200 && res.status < 300 && tokenRaw) {
    const session: HmSession & { key: string } = {
      token: String(tokenRaw),
      base: probe.data.base,
      hmVersion: probe.data.hmVersion,
      premium: probe.data.premium,
      loggedInAt: Date.now(),
      key: cfgKey(cfg),
    };
    g.__hmSession = session;
    return { ok: true, data: session };
  }
  if (res.status >= 200 && res.status < 300 && !tokenRaw) {
    const keys = Object.keys(body).join(", ") || "—";
    return {
      ...fail(
        `HMPanel ورود را تایید کرد (HTTP ${res.status}) ولی توکن در پاسخ نبود (کلیدهای دریافتی: ${keys}) — نسخه پنل با API مورد انتظار فرق دارد`,
        `HMPanel accepted the login (HTTP ${res.status}) but no token was in the response (received keys: ${keys}) — the panel version differs from the expected API`
      ),
      status: res.status,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...fail(
        "ورود به HMPanel ناموفق بود — نام کاربری/رمز عبور اشتباه است یا این حساب ادمین کل (SUPER_ADMIN) نیست",
        "HMPanel login failed — wrong username/password or this account is not a SUPER_ADMIN"
      ),
      status: res.status,
    };
  }
  if (res.status === 429) {
    return {
      ...fail(
        "تعداد تلاش‌های ورود زیاد است (محدودیت سرور پنل) — یک دقیقه بعد دوباره امتحان کنید",
        "Too many login attempts (panel rate limit) — try again in a minute"
      ),
      status: 429,
    };
  }
  return {
    ...fail(
      `ورود به HMPanel ناموفق بود (HTTP ${res.status} روی ${probe.data.base})`,
      `HMPanel login failed (HTTP ${res.status} on ${probe.data.base})`
    ),
    status: res.status,
  };
}

/** Create a full backup archive on the HMPanel host and download it. */
export async function hmFullBackup(
  cfg: AppConfig
): Promise<HmResult<{ buf: Buffer; fileName: string; size: number }>> {
  let sess = await hmLogin(cfg);
  if (!sess.ok || !sess.data) return { ok: false, error: sess.error, errorBi: sess.errorBi };

  const ax = axiosFor(cfg, CREATE_TIMEOUT_MS);
  const auth = (s: HmSession): Record<string, string> => ({
    Authorization: `Bearer ${s.token}`,
    "Content-Type": "application/json",
  });

  // 1) create the archive (synchronous, may take a while)
  let createRes;
  try {
    createRes = await ax.post(`${sess.data.base}/backups`, { type: "full" }, {
      headers: auth(sess.data),
    });
  } catch (e: unknown) {
    const m = hmErrMsg(e);
    return fail(`ساخت بکاپ روی HMPanel ناموفق بود: ${m.fa}`, `Creating the HMPanel backup failed: ${m.en}`);
  }

  // token expired mid-flight → re-login once and retry
  if (createRes.status === 401 || createRes.status === 403) {
    hmInvalidateSession();
    sess = await hmLogin(cfg, true);
    if (!sess.ok || !sess.data) return { ok: false, error: sess.error, errorBi: sess.errorBi };
    try {
      createRes = await ax.post(`${sess.data.base}/backups`, { type: "full" }, {
        headers: auth(sess.data),
      });
    } catch (e: unknown) {
      const m = hmErrMsg(e);
      return fail(`ساخت بکاپ روی HMPanel ناموفق بود: ${m.fa}`, `Creating the HMPanel backup failed: ${m.en}`);
    }
  }

  if (createRes.status < 200 || createRes.status >= 300) {
    const detail =
      (createRes.data && (createRes.data.message as string | string[] | undefined)) || "";
    const d = Array.isArray(detail) ? detail.join("; ") : detail;
    return {
      ...fail(
        `ساخت بکاپ روی HMPanel ناموفق بود (HTTP ${createRes.status})${d ? ` — ${d}` : ""}`,
        `Creating the HMPanel backup failed (HTTP ${createRes.status})${d ? ` — ${d}` : ""}`
      ),
      status: createRes.status,
    };
  }

  const id = String(createRes.data?.id ?? createRes.data?.file ?? "");
  if (!id) return fail("پاسخ HMPanel فاقد شناسه فایل بکاپ بود", "The HMPanel response had no backup file id");

  // 2) download the archive (?token= works for file streams — official jwt strategy)
  const dax = axiosFor(cfg, DOWNLOAD_TIMEOUT_MS);
  try {
    const dl = await dax.get(`${sess.data.base}/backups/${encodeURIComponent(id)}/download`, {
      params: { token: sess.data.token },
      responseType: "arraybuffer",
    });
    if (dl.status === 401 || dl.status === 403) {
      return fail("دانلود بکاپ مجاز نشد (دسترسی SUPER_ADMIN لازم است)", "Backup download was not allowed (SUPER_ADMIN access required)");
    }
    if (dl.status >= 300) {
      return fail(`دانلود فایل بکاپ ناموفق بود (HTTP ${dl.status})`, `Downloading the backup file failed (HTTP ${dl.status})`);
    }
    const buf = Buffer.from(dl.data);
    if (buf.length === 0) return fail("فایل بکاپ خالی بود", "The backup file was empty");
    const fileName = id.endsWith(".tar.gz") ? id : `${id}.tar.gz`;
    return { ok: true, data: { buf, fileName, size: buf.length } };
  } catch (e: unknown) {
    const m = hmErrMsg(e);
    return fail(`خطای دانلود بکاپ: ${m.fa}`, `Backup download error: ${m.en}`);
  }
}

/** Connection test used by the «تست اتصال» button: detect base → login → report version. */
export async function hmTestConnection(
  cfg: AppConfig
): Promise<HmResult<{ base: string; username: string; hmVersion?: string; premium?: boolean }>> {
  const sess = await hmLogin(cfg, true); // force → also re-detects the base after URL edits
  if (!sess.ok || !sess.data) return { ok: false, error: sess.error, errorBi: sess.errorBi };
  return {
    ok: true,
    data: {
      base: sess.data.base,
      username: cfg.hmUsername.trim(),
      hmVersion: sess.data.hmVersion,
      premium: Boolean(sess.data.premium),
    },
  };
}

/** Bilingual axios error text. */
function hmErrMsg(e: unknown): Bi {
  if (axios.isAxiosError(e)) {
    if (e.code === "ECONNREFUSED") return bi("اتصال رد شد (سرویس HMPanel در دسترس نیست)", "Connection refused (the HMPanel service is unreachable)");
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
