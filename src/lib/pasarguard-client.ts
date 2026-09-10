import axios, { type AxiosInstance } from "axios";
import { sharedHttpAgent, sharedHttpsAgent } from "@/lib/http-agents";
import zlib from "node:zlib";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * PasarGuard (PasarGuard/panel) API client.
 *
 * Verified against the OFFICIAL repo source (v5.3.x, FastAPI/Marzban family):
 *  - POST {base}/api/admin/token   form-urlencoded (username,password)
 *      -> 200 { access_token, token_type: "bearer" }   |  401 bad creds | 403 disabled
 *      (OAuth2PasswordRequestForm — the body MUST be x-www-form-urlencoded, not JSON)
 *  - all admin routes:  Authorization: Bearer <access_token>
 *
 * PasarGuard ships NO native file-backup endpoint, so a FULL backup here is a
 * complete logical snapshot of the whole panel, fetched page-by-page:
 *   GET /api/settings          (panel settings incl. Telegram/env-backed fields)
 *   GET /api/hosts             GET /api/nodes        GET /api/cores
 *   GET /api/groups            GET /api/client_templates
 *   GET /api/users?offset&limit -> { users, total }  (paginated until total)
 *   GET /api/admins            (superadmin-only → optional, 403 tolerated)
 *   GET /api/system            (version/health header)
 * Everything is packed with a manifest into a tar.gz archive (same layout as
 * the HMPanel archive) and sent to Telegram.
 *
 * Token TTL is short (Marzban-family JWTs) — the client re-logins per backup
 * instead of caching, keeping every cycle self-sufficient and stateless.
 */

export interface PgResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string; // canonical fa text
  errorBi?: Bi;   // bilingual pair for the web panel
}

const REQ_TIMEOUT_MS = 30 * 1000;
const SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000;
const USER_PAGE = 200; // users per page during the snapshot

function axiosFor(cfg: AppConfig, timeout = REQ_TIMEOUT_MS): AxiosInstance {
  return axios.create({
    timeout,
    httpAgent: sharedHttpAgent(),
    httpsAgent: sharedHttpsAgent(cfg.skipTlsVerify),
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { "User-Agent": "bkup/1.0", Accept: "application/json" },
  });
}

/** Bilingual axios error text. */
function pgErrMsg(e: unknown): Bi {
  if (axios.isAxiosError(e)) {
    if (e.code === "ECONNREFUSED") return bi("اتصال رد شد (سرویس PasarGuard در دسترس نیست)", "Connection refused (the PasarGuard service is unreachable)");
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

/** Normalize the panel URL: scheme, no trailing slash. */
export function pgNormalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** Login → Bearer token. Accepts any 2xx with access_token. */
async function pgLogin(cfg: AppConfig): Promise<PgResult<{ token: string }>> {
  if (!cfg.pgUrl.trim()) return fail("آدرس PasarGuard تنظیم نشده است", "PasarGuard URL is not configured");
  if (!cfg.pgUsername.trim() || !cfg.pgPassword) {
    return fail("نام کاربری و رمز عبور PasarGuard را وارد کنید (حساب ادمین)", "Enter the PasarGuard username and password (an admin account)");
  }

  const base = pgNormalizeUrl(cfg.pgUrl);
  const ax = axiosFor(cfg);
  const form = new URLSearchParams({
    username: cfg.pgUsername.trim(),
    password: cfg.pgPassword,
  });

  let res;
  try {
    res = await ax.post(`${base}/api/admin/token`, form.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });
  } catch (e: unknown) {
    const m = pgErrMsg(e);
    return fail(`ورود به PasarGuard ناموفق بود: ${m.fa}`, `PasarGuard login failed: ${m.en}`);
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
  if (res.status >= 200 && res.status < 300 && !tokenRaw) {
    const keys = Object.keys(body).join(", ") || "—";
    return {
      ...fail(
        `PasarGuard ورود را تایید کرد (HTTP ${res.status}) ولی توکن در پاسخ نبود (کلیدهای دریافتی: ${keys})`,
        `PasarGuard accepted the login (HTTP ${res.status}) but no token was in the response (received keys: ${keys})`
      ),
      status: res.status,
    };
  }
  if (res.status === 401) {
    return {
      ...fail(
        "ورود به PasarGuard ناموفق بود — نام کاربری یا رمز عبور اشتباه است",
        "PasarGuard login failed — wrong username or password"
      ),
      status: 401,
    };
  }
  if (res.status === 403) {
    return {
      ...fail("این حساب PasarGuard غیرفعال شده است", "This PasarGuard account is disabled"),
      status: 403,
    };
  }
  if (res.status === 404) {
    return {
      ...fail(
        `مسیر ${base}/api/admin/token پیدا نشد — این آدرس یک پنل PasarGuard نیست (نسخه قدیمی یا سرویس دیگر)`,
        `The path ${base}/api/admin/token was not found — this address is not a PasarGuard panel (older version or another service)`
      ),
      status: 404,
    };
  }
  return {
    ...fail(
      `ورود به PasarGuard ناموفق بود (HTTP ${res.status} روی ${base})`,
      `PasarGuard login failed (HTTP ${res.status} on ${base})`
    ),
    status: res.status,
  };
}

interface PgSection {
  name: string;
  path: string;
  required: boolean; // required sections abort the backup; optional ones are skipped with a note
}

const SECTIONS: PgSection[] = [
  { name: "system", path: "/api/system", required: false },
  { name: "settings", path: "/api/settings", required: false },
  { name: "hosts", path: "/api/hosts", required: true },
  { name: "nodes", path: "/api/nodes", required: false },
  { name: "cores", path: "/api/cores", required: false },
  { name: "groups", path: "/api/groups", required: true },
  { name: "client_templates", path: "/api/client_templates", required: false },
  { name: "admins", path: "/api/admins", required: false }, // superadmin-only on some installs
];

/**
 * Fetch the complete logical snapshot of the panel and pack it into a tar.gz
 * (manifest.json + <section>.json files) — the PasarGuard equivalent of a
 * "full backup". Returns the archive buffer.
 */
export async function pgFullBackup(
  cfg: AppConfig
): Promise<PgResult<{ buf: Buffer; fileName: string; size: number; users: number; notes: string[] }>> {
  const auth = await pgLogin(cfg);
  if (!auth.ok || !auth.data) return { ok: false, error: auth.error, errorBi: auth.errorBi };

  const base = pgNormalizeUrl(cfg.pgUrl);
  const ax = axiosFor(cfg, SNAPSHOT_TIMEOUT_MS);
  const H = { Authorization: `Bearer ${auth.data.token}` };
  const notes: string[] = [];
  const files: { name: string; json: string }[] = [];

  let pgVersion = "";
  let usersTotal = -1;

  for (const sec of SECTIONS) {
    try {
      const res = await ax.get(`${base}${sec.path}`, { headers: H });
      if (res.status >= 200 && res.status < 300 && res.data !== undefined) {
        if (sec.name === "system") {
          const v = (res.data as Record<string, unknown>)?.version;
          if (typeof v === "string") pgVersion = v;
        }
        files.push({ name: `${sec.name}.json`, json: JSON.stringify(res.data, null, 2) });
      } else if (sec.required) {
        return {
          ...fail(
            `دریافت «${sec.name}» از PasarGuard ناموفق بود (HTTP ${res.status} روی ${sec.path})`,
            `Fetching "${sec.name}" from PasarGuard failed (HTTP ${res.status} on ${sec.path})`
          ),
          status: res.status,
        };
      } else {
        notes.push(`${sec.name}: HTTP ${res.status} - skipped`);
      }
    } catch (e: unknown) {
      if (sec.required) {
        const m = pgErrMsg(e);
        return fail(`دریافت «${sec.name}» ناموفق بود: ${m.fa}`, `Fetching "${sec.name}" failed: ${m.en}`);
      }
      notes.push(`${sec.name}: ${pgErrMsg(e).en} - skipped`);
    }
  }

  // users — paginated until total is covered
  try {
    const all: unknown[] = [];
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const res = await ax.get(`${base}/api/users`, { headers: H, params: { offset, limit: USER_PAGE } });
      if (!(res.status >= 200 && res.status < 300)) {
        throw new Error(`HTTP ${res.status}`);
      }
      const d = (res.data ?? {}) as { users?: unknown[]; total?: number };
      const rows = Array.isArray(d.users) ? d.users : [];
      all.push(...rows);
      if (typeof d.total === "number") usersTotal = d.total;
      offset += rows.length;
      if (rows.length < USER_PAGE || (usersTotal >= 0 && all.length >= usersTotal)) break;
    }
    files.push({ name: "users.json", json: JSON.stringify({ total: all.length, users: all }, null, 2) });
  } catch (e: unknown) {
    const m = pgErrMsg(e);
    return fail(`دریافت کاربران PasarGuard ناموفق بود: ${m.fa}`, `Fetching PasarGuard users failed: ${m.en}`);
  }

  const manifest = {
    product: "pasarguard-full-snapshot",
    by: "bkup — telegram backup bot (github.com/AliRezaC-xrol/bkup)",
    panel: "PasarGuard",
    panelVersion: pgVersion || "unknown",
    panelUrl: base,
    exportedAt: new Date().toISOString(),
    sections: files.map((f) => f.name),
    usersTotal: usersTotal >= 0 ? usersTotal : undefined,
    notes,
  };
  files.unshift({ name: "manifest.json", json: JSON.stringify(manifest, null, 2) });

  // pack as tar.gz (deterministic minimal tar writer)
  const tarBuf = buildTar(files.map((f) => ({ name: f.name, data: Buffer.from(f.json, "utf8") })));
  const gz = zlib.gzipSync(tarBuf, { level: 6 });

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const fileName = `pasarguard_full_${stamp}.tar.gz`;

  return { ok: true, data: { buf: gz, fileName, size: gz.length, users: usersTotal >= 0 ? usersTotal : -1, notes } };
}

/** Minimal ustar tar writer (512-byte headers, no extra fields needed). */
function buildTar(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(e.name.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100); // mode
    header.write("0000000\0", 108); // uid
    header.write("0000000\0", 116); // gid
    header.write(e.data.length.toString(8).padStart(11, "0") + "\0", 124); // size
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136); // mtime
    header.write("        ", 148); // checksum placeholder (spaces)
    header.write("0", 156); // type: regular file
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two empty blocks terminate the archive
  return Buffer.concat(blocks);
}

/** Connection test used by the «تست اتصال» button: login + version + user count. */
export async function pgTestConnection(
  cfg: AppConfig
): Promise<PgResult<{ base: string; username: string; pgVersion?: string }>> {
  const auth = await pgLogin(cfg);
  if (!auth.ok || !auth.data) return { ok: false, error: auth.error, errorBi: auth.errorBi };

  const base = pgNormalizeUrl(cfg.pgUrl);
  let pgVersion: string | undefined;
  try {
    const ax = axiosFor(cfg, 15000);
    const res = await ax.get(`${base}/api/system`, {
      headers: { Authorization: `Bearer ${auth.data.token}` },
    });
    const v = (res.data as Record<string, unknown> | undefined)?.version;
    if (typeof v === "string") pgVersion = v;
  } catch { /* version is cosmetic — ignore */ }

  return { ok: true, data: { base, username: cfg.pgUsername.trim(), pgVersion } };
}
