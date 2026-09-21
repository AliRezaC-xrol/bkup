import { NextResponse } from "next/server";
import { runBackup } from "@/lib/backup-service";
import { requireAuthOrCli } from "@/lib/auth";

import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full backup of a large panel (HMPanel carries uploads/) legitimately
// takes minutes: download + gzip + Telegram upload. The old 120s ceiling
// aborted the request mid-flight, leaving the run stuck in "running" and
// the panel looking frozen. The run itself is guarded by its own timeouts.
export const maxDuration = 1800;

/** Manual one-shot backup cycle — runs ALL enabled panels (3x-ui + HM Panel). */
export async function POST(req: Request) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  await log("info", bi("A manual backup was started by the user", "A manual backup was started by the user"));
  const result = await runBackup("manual");
  return NextResponse.json(result, { status: 200 });
}
