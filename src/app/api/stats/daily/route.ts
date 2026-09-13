import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuthOrCli } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-day backup activity for the dashboard chart — the last 14 days,
 * zero-filled so the window always has exactly 14 columns.
 * Only the fields the chart needs are selected, keeping the query cheap
 * even with months of history in the table.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  const DAYS = 14;
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (DAYS - 1));

  const runs = await db.backupRun.findMany({
    where: { startedAt: { gte: start } },
    select: { startedAt: true, status: true, fileSize: true },
  });

  // index = 0 → oldest day, index = DAYS-1 → today
  const buckets = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      success: 0,
      failed: 0,
      bytes: 0,
    };
  });
  const byDay = new Map(buckets.map((b) => [b.day, b]));

  for (const r of runs) {
    const d = new Date(r.startedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const b = byDay.get(key);
    if (!b) continue;
    if (r.status === "success") {
      b.success += 1;
      b.bytes += r.fileSize ?? 0;
    } else if (r.status === "failed") {
      b.failed += 1;
    }
  }

  return NextResponse.json({
    days: buckets,
    // server-local calendar day for the "today" highlight — the buckets are
    // built on the same clock, so client and server can never disagree
    today: buckets[buckets.length - 1].day,
  });
}
