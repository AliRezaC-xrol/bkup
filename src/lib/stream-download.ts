import fs from "node:fs";
import path from "node:path";
import type { AxiosInstance } from "axios";
import { bi, type Bi } from "@/lib/messages";

/**
 * Stream-to-disk download helpers.
 *
 * The panel archives can be several hundred MB (HMPanel's full backup carries
 * the database PLUS the uploads/ directory). Pulling one into a Buffer and
 * then handing that Buffer to FormData duplicated the whole payload in RAM —
 * under systemd's MemoryMax that OOM-killed the service mid-backup, which is
 * why a single-panel HMPanel backup looked like it "froze" the panel.
 *
 * These helpers write the response straight to a file and return the path, so
 * the archive only ever exists on disk and the Telegram upload streams it back
 * off disk. Peak RAM stays flat regardless of backup size.
 */

export interface StreamedFile {
  filePath: string;
  fileName: string;
  size: number;
}

export interface StreamResult {
  ok: boolean;
  data?: StreamedFile;
  /** set when a JSON/HTML error body was captured instead of a file */
  errorBody?: string;
  error?: string;
  errorBi?: Bi;
}

/**
 * GET an URL with responseType "stream" and pipe it to destPath.
 * On HTTP error the (small) body is captured into errorBody so the caller can
 * report the panel's own message. The file is created only for 2xx + a
 * non-empty body, so a failed download never leaves a truncated file behind.
 */
export async function streamDownload(
  ax: AxiosInstance,
  url: string,
  destPath: string,
  opts: { params?: Record<string, string>; headers?: Record<string, string> } = {}
): Promise<StreamResult> {
  let res;
  try {
    res = await ax.get(url, {
      responseType: "stream",
      params: opts.params,
      headers: opts.headers,
      maxRedirects: 5,
    });
  } catch (e: unknown) {
    return { ok: false, ...errBi(e) };
  }

  if (res.status < 200 || res.status >= 300) {
    const body = await drainStream(res.data);
    return { ok: false, errorBody: body };
  }

  // the destination filename comes from the panel's own response — a hostile
  // or broken panel could send "../../something". Never let it escape the
  // directory the caller chose.
  const safe = safeJoin(destPath);
  if (!safe) {
    return {
      ok: false,
      error: "The panel returned an unsafe backup file name",
      errorBi: bi("The panel returned an unsafe backup file name", "The panel returned an unsafe backup file name"),
    };
  }

  await fs.promises.mkdir(path.dirname(safe), { recursive: true });
  let bytes = 0;
  let aborted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(safe);
      const stream = res.data as NodeJS.ReadableStream;
      out.on("error", reject);
      out.on("finish", () => resolve());
      stream.on("error", (e: unknown) => {
        aborted = true;
        out.destroy();
        reject(e);
      });
      // count bytes as they flow — the response may not carry Content-Length
      stream.on("data", (c: Buffer) => { bytes += c.length; });
      stream.pipe(out);
    });
  } catch (e: unknown) {
    // a partial file is useless — never leave one behind for retention to
    // mistake for a real backup
    try { await fs.promises.unlink(safe); } catch { /* already gone */ }
    const r = errBi(e);
    return { ok: false, error: r.error, errorBi: r.errorBi };
  }

  if (aborted || bytes === 0) {
    try { await fs.promises.unlink(safe); } catch { /* best-effort */ }
    return { ok: false, error: "The backup file was empty", errorBi: bi("The backup file was empty", "The backup file was empty") };
  }

  const fileName = path.basename(safe);
  return { ok: true, data: { filePath: safe, fileName, size: bytes } };
}

/**
 * Reject any destination that resolves OUTSIDE its own directory tree — the
 * file name arrives from the remote panel and is not trusted. Also rejects
 * absolute paths and drive letters (Windows).
 */
function safeJoin(destPath: string): string | null {
  const dir = path.dirname(destPath);
  const resolved = path.resolve(destPath);
  const resolvedDir = path.resolve(dir);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return resolved;
}

/** Read a whole (short) stream into a string — used for error bodies only. */
async function drainStream(stream: NodeJS.ReadableStream): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    // pull the panel's own message out of a JSON error envelope
    try {
      const j = JSON.parse(raw) as { message?: string | string[]; error?: string };
      if (Array.isArray(j.message)) return j.message.join("; ");
      if (typeof j.message === "string") return j.message;
      if (typeof j.error === "string") return j.error;
    } catch { /* plain body — return as-is */ }
    return raw.slice(0, 500);
  } catch {
    return "";
  }
}

function errBi(e: unknown): { error: string; errorBi: Bi } {
  const t = e instanceof Error ? e.message : String(e);
  return { error: t, errorBi: bi(t, t) };
}
