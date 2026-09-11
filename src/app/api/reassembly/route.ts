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

/** Upload part files and merge them back into the one complete original backup. */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

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
  await log("info", bi(
    `پارت‌های بکاپ در وب‌پنل به یک فایل کامل برگردانده شد: ${safeName} (${ordered.length} قطعه)`,
    `Backup parts were reassembled in the web panel into one complete file: ${safeName} (${ordered.length} parts)`
  ));
  return NextResponse.json(row, { status: 201 });
}
