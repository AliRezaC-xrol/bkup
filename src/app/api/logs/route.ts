import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live log stream (incremental via ?after=<id>). */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const after = Number(req.nextUrl.searchParams.get("after")) || 0;
  const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 100));

  const rows = await db.appLog.findMany({
    where: after ? { id: { gt: after } } : undefined,
    orderBy: { id: "asc" },
    take: limit,
  });

  const last = await db.appLog.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
  return NextResponse.json({ rows, cursor: last?.id ?? 0 });
}

/** Clear all logs. */
export async function DELETE(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  await db.appLog.deleteMany();
  return NextResponse.json({ ok: true });
}
