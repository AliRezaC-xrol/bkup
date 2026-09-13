import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import { backupDir } from "@/lib/backup-service";
import { compareParts, detectPanel, stripPartFromName } from "@/lib/reassembly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** History of reassembled backups — newest first. */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const rows = await db.reassembledBackup.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(rows);
}

/** Upload part files and merge them back into the one complete original backup.
 *  Also accepts JSON { backupId } to store one of the existing Backups-section
 *  files as a complete reassembled backup (the original stays untouched). */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  // ── JSON mode: register an existing backup run as a reassembled file ──
  if ((req.headers.get("content-type") || "").includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { backupId?: number | string };
    const backupId = Number(body.backupId);
    if (!backupId || backupId < 1) {
      return NextResponse.json({ error: "BACKUP_ID_REQUIRED" }, { status: 400 });
    }
    const run = await db.backupRun.findUnique({ where: { id: backupId } });
    if (!run) return NextResponse.json({ error: "BACKUP_NOT_FOUND" }, { status: 404 });
    if (run.status !== "success" || !run.filePath) {
      return NextResponse.json({ error: "BACKUP_NOT_COMPLETE" }, { status: 409 });
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(run.filePath);
    } catch {
      return NextResponse.json({ error: "BACKUP_FILE_GONE" }, { status: 409 });
    }

    const dir = path.join(backupDir(), "reassembled");
    fs.mkdirSync(dir, { recursive: true });
    const rawName = run.fileName || `backup-${run.id}`;
    const base = (rawName.split(/[\\/]/).pop() || rawName).replace(/[^\w.@ -]/g, "_");
    const outPath = path.join(dir, `${Date.now()}-${base}`);
    try {
      fs.copyFileSync(run.filePath, outPath);
    } catch (e: unknown) {
      try { fs.unlinkSync(outPath); } catch { /* best-effort */ }
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "COPY_FAILED" },
        { status: 500 }
      );
    }

    const row = await db.reassembledBackup.create({
      data: {
        name: base,
        panel: detectPanel(base),
        parts: 1,
        size: st.size,
        filePath: outPath,
      },
    });
    await log("info", bi(
      `The stored backup "${base}" was picked in the web panel and stored as one complete reassembled file`,
      `The stored backup "${base}" was picked in the web panel and stored as one complete reassembled file`
    ));
    return NextResponse.json(row, { status: 201 });
  }

  // ── Upload mode: merge part files ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_UPLOAD" }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "NO_FILES" }, { status: 400 });
  }

  // merge order is decided by the parsed part index — never by upload order
  const ordered = [...files].sort((a, b) => compareParts(a.name, b.name));

  // the original name comes from the FIRST part with the ".partNNofMM" bit stripped
  const rawName = (ordered[0].name || "backup").split(/[\\/]/).pop() || "backup";
  const name = stripPartFromName(rawName) || rawName;
  const panel = detectPanel(name);

  const dir = path.join(backupDir(), "reassembled");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = name.replace(/[^\w.@ -]/g, "_");
  const outPath = path.join(dir, `${Date.now()}-${safeName}`);

  let size = 0;
  try {
    for (const part of ordered) {
      const buf = Buffer.from(await part.arrayBuffer());
      fs.appendFileSync(outPath, buf);
      size += buf.length;
    }
  } catch (e: unknown) {
    try { fs.unlinkSync(outPath); } catch { /* best-effort */ }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "MERGE_FAILED" },
      { status: 500 }
    );
  }

  const row = await db.reassembledBackup.create({
    data: { name: safeName, panel, parts: ordered.length, size, filePath: outPath },
  });
  await log("info", bi(`Backup parts were reassembled in the web panel into one complete file: ${safeName} (${ordered.length} parts)`, `Backup parts were reassembled in the web panel into one complete file: ${safeName} (${ordered.length} parts)`));
  return NextResponse.json(row, { status: 201 });
}
