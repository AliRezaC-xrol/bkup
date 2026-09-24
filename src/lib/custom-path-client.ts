import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { AppConfig } from "@/lib/config-service";
import { bi, fail, type Bi } from "@/lib/messages";

/**
 * Custom-path backups — arbitrary DIRECTORIES ON THIS SERVER, packaged as a
 * tar.gz and delivered to Telegram exactly like a panel backup.
 *
 * Use case (issue #2): a folder such as /opt/folder that lives next to a
 * panel and holds config, docker-compose files or app data the panel's own
 * backup never covers.
 *
 * Security posture: the paths are entered by the authenticated panel admin
 * and are read-only here. They are validated against a hard allow-list of
 * ancestors — the app's own directory (which holds secrets, the database and
 * the backups themselves) is ALWAYS refused, as are paths outside the root.
 */

/**
 * System files that must NEVER be packaged and uploaded, even when the admin
 * points a custom path at a system directory (e.g. `/etc/nginx` or a home
 * directory). Telegram is not a secret store: /etc/shadow, sudoers, private
 * host keys and user private keys would leak full server access.
 * Project files such as `/opt/myapp/.env` are deliberately NOT in this list —
 * backing those up is the whole point of the feature.
 */
function isSystemSecret(absolute: string): boolean {
  const base = path.basename(absolute);
  const parent = path.basename(path.dirname(absolute));
  const grand = path.basename(path.dirname(path.dirname(absolute)));
  // any private SSH key of any user (never the .pub half)
  if (parent === ".ssh" && base.startsWith("id_") && !base.endsWith(".pub")) return true;
  if (parent === ".ssh" && base === "authorized_keys") return false; // not a secret, keep it
  // credential stores
  if (base === ".git-credentials" || base === ".netrc" || base === "credentials") {
    if (base !== "credentials" || grand === ".aws" || parent === ".aws") return true;
  }
  // classic shadow files and sudoers — only where they actually live
  if ((parent === "etc") && (base === "shadow" || base === "gshadow" || base === "sudoers")) return true;
  if (parent === "sudoers.d" && grand === "etc") return true;
  return false;
}

export interface CustomResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorBi?: Bi;
}

export interface CustomPath {
  path: string;
  label: string;
}

const MAX_PATHS = 16;
const MAX_LABEL = 40;

/** Parse the JSON array of custom paths from the config string. */
export function parseCustomPaths(raw: string): CustomPath[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((v) => (typeof v === "string" ? { path: v, label: "" } : v))
      .filter((v): v is CustomPath => v && typeof v.path === "string")
      .map((v) => ({
        path: v.path.trim(),
        label: (v.label ?? "").trim().slice(0, MAX_LABEL),
      }))
      .filter((v) => v.path !== "");
  } catch {
    return [];
  }
}

/**
 * Paths the bot must NEVER offer to back up — they hold the bot's own
 * secrets (the .env with tokens, the .cli-secret, the SQLite database with
 * password hashes and every panel credential) or its own output. Backing
 * them up would leak all of that into a Telegram chat.
 */
function isForbidden(rootDir: string, target: string): boolean {
  const resolved = path.resolve(target);
  if (resolved === rootDir) return true;
  if (resolved.startsWith(rootDir + path.sep)) return true;
  // the app's own secrets and data, wherever they ended up
  const banned = [".env", ".cli-secret", ".github-token"];
  if (banned.includes(path.basename(resolved))) return true;
  return false;
}

/**
 * Validate one candidate path the admin wants to back up.
 * Returns the failure reason (bilingual) or null when the path is usable.
 */
export function validateCustomPath(
  candidate: string,
  rootDir: string
): Bi | null {
  const p = candidate.trim();
  if (!p) return bi("Enter a directory path", "Enter a directory path");
  if (!path.isAbsolute(p)) {
    return bi("The path must be absolute (start with / or a drive letter)", "The path must be absolute (start with / or a drive letter)");
  }
  if (p.includes("..")) {
    return bi("The path must not contain ..", "The path must not contain ..");
  }
  if (isForbidden(rootDir, p)) {
    return bi(
      "This directory holds the bot itself (settings, secrets and the backup database) and cannot be backed up",
      "This directory holds the bot itself (settings, secrets and the backup database) and cannot be backed up"
    );
  }
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) {
      return bi("The path is not a directory", "The path is not a directory");
    }
  } catch {
    return bi("The directory does not exist on this server", "The directory does not exist on this server");
  }
  return null;
}

/**
 * Back up one custom directory to destDir as a tar.gz.
 * Streams to disk — a directory can hold any amount of data, and buffering
 * it would OOM the service exactly like the panel backups used to.
 */
export async function customPathBackup(
  cfg: AppConfig,
  entry: CustomPath,
  destDir: string,
  rootDir: string
): Promise<CustomResult<{ filePath: string; fileName: string; size: number; files: number }>> {
  const problem = validateCustomPath(entry.path, rootDir);
  if (problem) return { ok: false, error: problem.en, errorBi: problem };

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*$/, "$1_$2$3$4");
  const slug =
    entry.label ||
    path.basename(entry.path).replace(/[^a-zA-Z0-9._-]+/g, "_") ||
    "custom";
  const fileName = `custom_${slug.replace(/[^a-zA-Z0-9._-]+/g, "_")}_${stamp}.tar.gz`;
  const filePath = path.join(destDir, fileName);

  await fs.promises.mkdir(destDir, { recursive: true });
  const out = fs.createWriteStream(filePath);
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);

  const header = (name: string, size: number, type: string, mode = 0o644, linkname = "") => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write((mode & 0o7777).toString(8).padStart(7, "0") + "\0", 100); // mode
    h.write("0000000\0", 108); // uid
    h.write("0000000\0", 116); // gid
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148); // checksum placeholder
    h.write(type, 156); // "0" regular file, "2" symlink, "5" directory
    if (linkname) h.write(linkname.slice(0, 100), 157, "utf8"); // symlink target
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };

  const writeMember = (name: string, data: Buffer, mode = 0o644) => {
    gz.write(header(name, data.length, "0", mode));
    gz.write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) gz.write(Buffer.alloc(pad, 0));
  };

  /** A symlink header: ustar stores the link target in the 100-byte linkname
   *  field (offset 157) and the entry has NO data — size MUST be 0. Writing
   *  the target as data produced an invalid member that GNU tar refused
   *  ("Unexpected EOF"), so symlinks silently vanished on restore. */
  const writeSymlink = (name: string, target: string) => {
    gz.write(header(name, 0, "2", 0o777, target));
  };

  let fileCount = 0;
  let totalBytes = 0;
  let skippedSecrets = 0;
  // hard ceiling so a runaway directory cannot fill the disk
  const MAX_FILES = 20000;
  const MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

  try {
    const stack: string[] = [entry.path];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        // unreadable subdirectory — skip it, keep the rest of the backup
        continue;
      }
      for (const ent of entries) {
        if (fileCount >= MAX_FILES) break;
        const full = path.join(dir, ent.name);
        const rel = path.relative(entry.path, full).split(path.sep).join("/");
        // symlinks are stored as themselves, never followed — following one
        // could pull in the whole filesystem or the bot's secrets
        if (ent.isSymbolicLink()) {
          let target = "";
          try { target = await fs.promises.readlink(full); } catch { continue; }
          writeSymlink(rel, target);
          fileCount++;
          continue;
        }
        if (isSystemSecret(full)) {
          // never archive /etc/shadow, sudoers, id_rsa, .git-credentials…
          skippedSecrets++;
          continue;
        }
        if (ent.isDirectory()) {
          // record the directory's real mode too — a hardcoded 0755 would
          // silently open a private directory (e.g. 0700) back to the world
          // on restore, which is exactly what "permissions preserved" must not do
          let dirMode = 0o755;
          try { dirMode = (await fs.promises.stat(full)).mode & 0o7777; } catch { /* fall back to 0755 */ }
          gz.write(header(rel + "/", 0, "5", dirMode));
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        // a file that happens to be named like our manifest would otherwise be
        // overwritten by the real manifest written at the end of the archive
        if (rel === "backup-manifest.json") continue;
        try {
          const st = await fs.promises.stat(full);
          if (totalBytes + st.size > MAX_BYTES) continue;
          totalBytes += st.size;
          // stream the file — readFile() would buffer a multi-GB file in RAM
          // and OOM the service exactly the way panel backups used to
          await new Promise<void>((resolve, reject) => {
            const src = fs.createReadStream(full, { highWaterMark: 1024 * 1024 });
            src.on("error", reject);
            gz.write(header(rel, st.size, "0", st.mode & 0o7777));
            src.on("data", (chunk) => {
              if (!gz.write(chunk)) {
                src.pause();
                gz.once("drain", () => src.resume());
              }
            });
            src.on("end", () => {
              const pad = (512 - (st.size % 512)) % 512;
              if (pad) gz.write(Buffer.alloc(pad, 0));
              resolve();
            });
          });
          fileCount++;
        } catch {
          // a file that vanished or is not readable — skip, keep going
        }
      }
    }
    writeMember("backup-manifest.json", Buffer.from(
      JSON.stringify({
        product: "custom-path-backup",
        by: "bkup — telegram backup bot (github.com/AliRezaC-xrol/bkup)",
        source: entry.path,
        label: entry.label || undefined,
        exportedAt: new Date().toISOString(),
        files: fileCount,
        bytes: totalBytes,
        skippedSecrets,
      }, null, 2),
      "utf8"
    ));
  } catch (e: unknown) {
    gz.destroy();
    out.destroy();
    try { await fs.promises.unlink(filePath); } catch { /* best-effort */ }
    const t = e instanceof Error ? e.message : String(e);
    return { ok: false, error: t, errorBi: bi(t, t) };
  }

  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", () => resolve());
    gz.write(Buffer.alloc(1024, 0)); // two empty blocks terminate the archive
    gz.end();
  });

  const size = (await fs.promises.stat(filePath)).size;
  return { ok: true, data: { filePath, fileName, size, files: fileCount } };
}

export { MAX_PATHS, MAX_LABEL };
