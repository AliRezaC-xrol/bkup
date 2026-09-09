import { NextResponse } from "next/server";
import { runBackup } from "@/lib/backup-service";
import { requireAuthOrCli } from "@/lib/auth";

import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Manual one-shot backup cycle — runs ALL enabled panels (3x-ui + HM Panel). */
export async function POST(req: Request) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  await log("info", bi("بکاپ دستی توسط کاربر آغاز شد", "A manual backup was started by the user"));
  const result = await runBackup("manual");
  return NextResponse.json(result, { status: 200 });
}
