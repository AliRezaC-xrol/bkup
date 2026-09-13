/**
 * On-demand disk cleanup — powers System → Storage "Clean now".
 *
 * Two reclamation sources:
 *  1. Orphans — files sitting in the backup dir (or its reassembled/ subdir)
 *     that belong to NO history row (BackupRun / ReassembledBackup). These
 *     appear when a cycle crashes after writing the file. The same sweep the
 *     nightly-ish cycle runs gets exposed here, on demand, with a preview.
 *  2. Retention excess — when cfg.localRetention is N>0, per-panel backups
 *     beyond the newest N are removed (file + history row), exactly like
 *     enforceLocalRetention() does after each cycle — just without waiting
 *     for the next cycle.
 *
 * A one-hour grace window protects files a still-running cycle just wrote.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { backupDir, formatSize } from "@/lib/backup-service";
import { getConfig } from "@/lib/config-service";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

const KNOWN = /(-backup-|_full_|\.db$|\.json$|\.tar\.gz$|\.tgz$|\.zip$|\.rbbackup$)/;
const GRACE_MS = 60 * 60 * 1000;

export interface FileGroup {
  count: number;
  bytes: number;
  files: string[];
}

export interface CleanupPreview {
  orphans: FileGroup;
  retention: { keep: number; excess: FileGroup };
}

async function referencedPaths(): Promise<Set<string>> {
  const [runs, reassembled] = await Promise.all([
    db.backupRun.findMany({ where: { filePath: { not: null } }, select: { filePath: true } }),
    db.reassembledBackup.findMany({ select: { filePath: true } }),
  ]);
  const set = new Set<string>();
  for (const r of runs) if (r.filePath) set.add(r.filePath);
  for (const r of reassembled) set.add(r.filePath);
  return set;
}

function listOldUnreferenced(dir: string, referenced: Set<string>, out: FileGroup): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !KNOWN.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (referenced.has(full)) continue;
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs <= GRACE_MS) continue; // a live cycle may still need it
      out.count += 1;
      out.bytes += st.size;
      out.files.push(e.name);
    } catch { /* raced with a delete — skip */ }
  }
}

/** What WOULD be cleaned right now — no disk writes. */
export async function previewCleanup(): Promise<CleanupPreview> {
  const dir = backupDir();
  const referenced = await referencedPaths();

  const orphans: FileGroup = { count: 0, bytes: 0, files: [] };
  listOldUnreferenced(dir, referenced, orphans);
  listOldUnreferenced(path.join(dir, "reassembled"), referenced, orphans);
  orphans.files.sort();

  // retention excess (mirrors enforceLocalRetention, preview only)
  const cfg = await getConfig();
  const keep = cfg.localRetention;
  const excess: FileGroup = { count: 0, bytes: 0, files: [] };
  if (keep >= 1) {
    const panels = ["3x-ui", "hmpanel", "pasarguard", "rebecca"];
    for (const panel of panels) {
      const runs = await db.backupRun.findMany({
        where: { panel, filePath: { not: null } },
        orderBy: { startedAt: "desc" },
        select: { filePath: true, fileSize: true },
      });
      for (const run of runs.slice(keep)) {
        if (!run.filePath) continue;
        excess.count += 1;
        excess.bytes += run.fileSize ?? 0;
        excess.files.push(path.basename(run.filePath));
      }
    }
  }

  return { orphans, retention: { keep, excess } };
}

export interface CleanupResult {
  orphansDeleted: number;
  orphanBytesFreed: number;
  retentionDeleted: number;
  retentionBytesFreed: number;
}

/** Execute the cleanup: unlink orphans + enforce retention (file + row). */
export async function runCleanup(): Promise<CleanupResult> {
  const dir = backupDir();
  const referenced = await referencedPaths();

  const result: CleanupResult = {
    orphansDeleted: 0,
    orphanBytesFreed: 0,
    retentionDeleted: 0,
    retentionBytesFreed: 0,
  };

  const removeOrphans = (subdir?: string): void => {
    const target = subdir ? path.join(dir, subdir) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !KNOWN.test(e.name)) continue;
      const full = path.join(target, e.name);
      if (referenced.has(full)) continue;
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs <= GRACE_MS) continue;
        fs.unlinkSync(full);
        result.orphansDeleted += 1;
        result.orphanBytesFreed += st.size;
      } catch { /* best-effort */ }
    }
  };
  removeOrphans();
  removeOrphans("reassembled");

  // retention enforcement — identical semantics to enforceLocalRetention
  const cfg = await getConfig();
  const keep = cfg.localRetention;
  if (keep >= 1) {
    const panels = ["3x-ui", "hmpanel", "pasarguard", "rebecca"];
    for (const panel of panels) {
      const runs = await db.backupRun.findMany({
        where: { panel, filePath: { not: null } },
        orderBy: { startedAt: "desc" },
        select: { id: true, filePath: true, fileSize: true },
      });
      for (const run of runs.slice(keep)) {
        if (!run.filePath) continue;
        try {
          if (fs.existsSync(run.filePath)) fs.unlinkSync(run.filePath);
        } catch { /* best-effort */ }
        await db.backupRun.delete({ where: { id: run.id } });
        result.retentionDeleted += 1;
        result.retentionBytesFreed += run.fileSize ?? 0;
      }
    }
  }

  if (result.orphansDeleted || result.retentionDeleted) {
    const en = `Disk cleanup — ${result.orphansDeleted} orphan file(s) and ${result.retentionDeleted} over-retention backup(s) removed, ${formatSize(result.orphanBytesFreed + result.retentionBytesFreed)} freed`;
    const fa = `پاک‌سازی دیسک — ${result.orphansDeleted} فایل یتیم و ${result.retentionDeleted} بکاپ اضافه‌بر حد نگه‌داری حذف شد، ${formatSize(result.orphanBytesFreed + result.retentionBytesFreed)} آزاد شد`;
    await log("info", bi(fa, en));
  }

  return result;
}
