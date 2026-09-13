import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { backupDir } from "@/lib/backup-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DirStat = { count: number; bytes: number };

function statDir(dir: string): DirStat {
  const out: DirStat = { count: 0, bytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile()) {
      try {
        out.bytes += fs.statSync(path.join(dir, e.name)).size;
        out.count += 1;
      } catch { /* raced with a delete — skip */ }
    }
  }
  return out;
}

function dbFileBytes(): number {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/^file:(.+)$/);
  if (!m) return 0;
  const p = path.resolve(process.cwd(), m[1]);
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Local disk usage of everything bkup stores: backup copies, reassembled
 *  files and the settings database — powers the System → Storage card. */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  const dir = backupDir();
  const reassembledDir = path.join(dir, "reassembled");

  // reassembled lives INSIDE the backup dir — count it separately so the
  // card can show the split without double counting
  const reassembled = statDir(reassembledDir);
  const whole = statDir(dir);
  const backups: DirStat = {
    count: whole.count - reassembled.count,
    bytes: whole.bytes - reassembled.bytes,
  };
  const database = { bytes: dbFileBytes() };

  return NextResponse.json({
    backups,
    reassembled,
    database,
    totalBytes: backups.bytes + reassembled.bytes + database.bytes,
    dir,
  });
}
