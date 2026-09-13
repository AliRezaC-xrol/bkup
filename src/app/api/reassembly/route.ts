import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import { backupDir } from "@/lib/backup-service";
import { compareParts, detectPanel, findPartGaps, parsePartIndex, stripPartFromName } from "@/lib/reassembly";

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
 *  Also accepts JSON { backupId } or { backupIds: [...] } to merge one or more
 *  of the existing Backups-section files (the parts of the same file) into a
 *  complete reassembled backup (the originals stay untouched). */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  // ── JSON mode: merge existing backup runs into one reassembled file ──
  if ((req.headers.get("content-type") || "").includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as {
      backupId?: number | string;
      backupIds?: (number | string)[];
    };
    // { backupId } (single) and { backupIds } (parts) both accepted, ids deduped
    const ids: number[] = [];
    for (const raw of body.backupIds ?? [body.backupId]) {
      const id = Number(raw);
      if (id && id >= 1 && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) {
      return NextResponse.json({ error: "BACKUP_ID_REQUIRED" }, { status: 400 });
    }
    if (ids.length > 64) {
      return NextResponse.json({ error: "TOO_MANY_PARTS" }, { status: 400 });
    }

    const runs = await db.backupRun.findMany({ where: { id: { in: ids } } });
    // verify every selected run: exists, complete, file still on disk —
    // `usable` keeps only the verified (non-null) fields for the merge below
    const usable: { id: number; fileName: string; filePath: string }[] = [];
    for (const id of ids) {
      const run = runs.find((r) => r.id === id);
      if (!run) return NextResponse.json({ error: "BACKUP_NOT_FOUND" }, { status: 404 });
      if (run.status !== "success" || !run.filePath) {
        return NextResponse.json({ error: "BACKUP_NOT_COMPLETE" }, { status: 409 });
      }
      try {
        fs.statSync(run.filePath);
      } catch {
        return NextResponse.json({ error: "BACKUP_FILE_GONE" }, { status: 409 });
      }
      usable.push({ id: run.id, fileName: run.fileName ?? "", filePath: run.filePath });
    }

    // refuse incomplete part sets: merging them would silently produce a
    // corrupt "complete" backup. The picker warns and offers a fix first;
    // this is the last line of defense so a bad file can never be stored.
    const gaps = findPartGaps(usable.map((r) => r.fileName));
    if (gaps.length > 0) {
      return NextResponse.json({ error: "MISSING_PARTS", gaps }, { status: 409 });
    }

    const dir = path.join(backupDir(), "reassembled");
    fs.mkdirSync(dir, { recursive: true });

    // merge order: by parsed part number when EVERY selected file carries one —
    // never by selection order; otherwise keep the order the picker sent
    const withParts = usable.map((r) => ({ run: r, part: parsePartIndex(r.fileName) }));
    const ordered = withParts.every((x) => x.part)
      ? [...withParts].sort((a, b) => compareParts(a.run.fileName, b.run.fileName))
      : withParts;

    // name: the stripped base all parts share, else the first part's own name
    const bases = ordered.map((x) => stripPartFromName(x.run.fileName.split(/[\\/]/).pop() || ""));
    const shared = bases[0] && bases.every((b) => b === bases[0]);
    const rawName = (shared ? bases[0] : ordered[0].run.fileName || `backup-${ordered[0].run.id}`);
    const base = (rawName.split(/[\\/]/).pop() || rawName).replace(/[^\w.@ -]/g, "_") || "backup";
    const outPath = path.join(dir, `${Date.now()}-${base}`);

    // byte-exact merge: read every part in order and append — nothing else
    // touches the bytes, so the result is identical to `cat` over the parts
    let size = 0;
    try {
      for (const { run: part } of ordered) {
        const buf = fs.readFileSync(part.filePath);
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
      data: {
        name: base,
        panel: detectPanel(base),
        parts: ordered.length,
        size,
        filePath: outPath,
      },
    });
    await log("info", bi(
      ordered.length > 1
        ? `${ordered.length} stored backup parts were picked in the web panel and merged into one complete file: ${base} (${size} bytes)`
        : `The stored backup "${base}" was picked in the web panel and stored as one complete reassembled file (${size} bytes)`,
      ordered.length > 1
        ? `${ordered.length} پارت از بکاپ‌های ذخیره‌شده در پنل وب انتخاب و به یک فایل کامل چسبانده شد: ${base} (${size} بایت)`
        : `بکاپ ذخیره‌شدهٔ "${base}" در پنل وب انتخاب و به‌صورت یک فایل کامل ذخیره شد (${size} بایت)`
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
