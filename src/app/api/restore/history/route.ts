import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { getRestoreHistory } from "@/lib/restore-service";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/restore/history — past restore jobs (newest first). */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
  const rows = await getRestoreHistory(limit);
  return NextResponse.json(rows);
}

/** DELETE /api/restore/history — delete single, multiple or all */
export async function DELETE(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  try {
    const url = req.nextUrl;
    const idParam = url.searchParams.get("id");
    const all = url.searchParams.get("all") === "true";

    if (all) {
      const result = await db.restoreJob.deleteMany({});
      return NextResponse.json({ ok: true, deleted: result.count });
    }

    if (idParam) {
      const id = Number(idParam);
      if (!Number.isFinite(id)) {
        return NextResponse.json({ ok: false, error: "INVALID_ID" }, { status: 400 });
      }
      await db.restoreJob.delete({ where: { id } }).catch(() => null);
      return NextResponse.json({ ok: true, deleted: 1 });
    }

    // Try body { ids: number[] } or { id: number }
    let body: any = null;
    try {
      body = await req.json();
    } catch {}

    if (body?.ids && Array.isArray(body.ids)) {
      const ids = body.ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n));
      if (ids.length === 0) {
        return NextResponse.json({ ok: false, error: "NO_IDS" }, { status: 400 });
      }
      const result = await db.restoreJob.deleteMany({ where: { id: { in: ids } } });
      return NextResponse.json({ ok: true, deleted: result.count });
    }

    if (body?.id) {
      const id = Number(body.id);
      await db.restoreJob.delete({ where: { id } }).catch(() => null);
      return NextResponse.json({ ok: true, deleted: 1 });
    }

    return NextResponse.json({ ok: false, error: "MISSING_ID" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "DELETE_FAILED" }, { status: 500 });
  }
}
