import axios, { type AxiosInstance } from "axios";
import path from "node:path";
import { sharedHttpAgent, sharedHttpsAgent } from "@/lib/http-agents";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";
import { streamDownload } from "@/lib/stream-download";

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
    httpAgent: sharedHttpAgent(),
    httpsAgent: sharedHttpsAgent(cfg.skipTlsVerify),
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
    if (e.code === "ECONNREFUSED") return bi("Connection refused (the Rebecca service is unreachable)", "Connection refused (the Rebecca service is unreachable)");
    if (e.code === "ETIMEDOUT" || e.code === "ECONNABORTED") return bi("The connection timed out", "The connection timed out");
    if (e.code === "ENOTFOUND") return bi("Host not found", "Host not found");
    if (e.code === "CERT_HAS_EXPIRED" || e.code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      return bi("Invalid SSL certificate (enable the ignore-SSL option)", "Invalid SSL certificate (enable the ignore-SSL option)");
    }
    return bi(e.message, e.message);
  }
  const t = e instanceof Error ? e.message : String(e);
  return bi(t, t);
}

/** Login → Bearer token. Accepts any 2xx with access_token (JSON body, form fallback). */
async function rbLogin(cfg: AppConfig): Promise<RbResult<{ token: string }>> {
  if (!cfg.rebeccaUrl.trim()) return fail("Rebecca URL is not configured", "Rebecca URL is not configured");
  if (!cfg.rebeccaUsername.trim() || !cfg.rebeccaPassword) {
    return fail("Enter the Rebecca username and password (an admin account)", "Enter the Rebecca username and password (an admin account)");
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
    return fail(`Rebecca login failed: ${m.en}`, `Rebecca login failed: ${m.en}`);
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
      ...fail("Rebecca login failed — wrong username/password or this account is disabled", "Rebecca login failed — wrong username/password or this account is disabled"),
      status: res.status,
    };
  }
  return {
    ...fail(`Rebecca login failed (HTTP ${res.status} on ${base})`, `Rebecca login failed (HTTP ${res.status} on ${base})`),
    status: res.status,
  };
}

/** Download Rebecca's own FULL backup export (database + configuration). */
export async function rbFullBackup(
  cfg: AppConfig,
  destDir: string
): Promise<RbResult<{ filePath: string; fileName: string; size: number }>> {
  const login = await rbLogin(cfg);
  if (!login.ok || !login.data) return { ok: false, error: login.error, errorBi: login.errorBi };

  const base = rbNormalizeUrl(cfg.rebeccaUrl);
  const ax = axiosFor(cfg, EXPORT_TIMEOUT_MS);
  const auth = { Authorization: `Bearer ${login.data.token}` };

  // the filename comes from Content-Disposition when the panel sends one;
  // fall back to a timestamped name so the stream target is known up-front
  const probe = await ax
    .head(`${base}/api/settings/backup/export`, { headers: auth, params: { scope: "full" } })
    .catch(() => null);
  const cd = String(probe?.headers?.["content-disposition"] ?? "");
  const m = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  // the file name comes from the panel — keep only the base name so it can
  // never escape the staging directory
  const rawName = m?.[1] ?? `rebecca-backup-${Date.now()}.rbbackup`;
  const fileName = path.basename(rawName) || `rebecca-backup-${Date.now()}.rbbackup`;
  const destPath = path.join(destDir, fileName);

  const exportUrl = `${base}/api/settings/backup/export`;
  let res = await streamDownload(ax, exportUrl, destPath, { headers: auth });
  // some builds want an explicit scope — retry once with scope=full
  if (!res.ok && res.errorBody) {
    res = await streamDownload(ax, exportUrl, destPath, {
      headers: auth,
      params: { scope: "full" },
    });
  }

  if (!res.ok) {
    const detail = res.errorBody || res.error || "download failed";
    // a JSON error body would arrive as 200 with JSON — reject it
    if (detail.startsWith("{") || detail.startsWith("<")) {
      return fail("Rebecca answered with an error instead of the backup file", "Rebecca answered with an error instead of the backup file");
    }
    return fail(`Downloading the Rebecca backup failed (${detail})`, `Downloading the Rebecca backup failed (${detail})`);
  }

  return { ok: true, data: { filePath: res.data!.filePath, fileName: res.data!.fileName, size: res.data!.size } };
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
    return fail(`The token was rejected (HTTP ${res.status}) — the panel version differs from the expected API`, `The token was rejected (HTTP ${res.status}) — the panel version differs from the expected API`);
  } catch (e: unknown) {
    const m = rbErrMsg(e);
    return fail(`Connection error: ${m.en}`, `Connection error: ${m.en}`);
  }
}
