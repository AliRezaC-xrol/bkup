import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readRestoreState, requestCancelRestore } from "@/lib/restore-service";
import { db } from "@/lib/db";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const state = readRestoreState();
    if (!state || state.status !== "running") {
      return NextResponse.json({ ok: true, message: "No running restore" });
    }

    // Request cancellation - sets flag file that runRestoreAsync checks
    requestCancelRestore();

    // Immediately mark as cancelled for UI responsiveness
    const cancelledState = {
      ...state,
      status: "cancelled" as const,
      error: "Cancelled by user",
      finishedAt: Date.now(),
      durationMs: Date.now() - state.startedAt,
      steps: state.steps.map((s: any) =>
        s.status === "running" ? { ...s, status: "failed" as const, error: "Cancelled by user", finishedAt: Date.now() } : s
      ),
    };

    const dataDir = path.join(process.cwd(), "data");
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    fs.writeFileSync(path.join(dataDir, "restore-state.json"), JSON.stringify(cancelledState, null, 2));

    // Also update DB job immediately so history shows Cancelled, not Running
    try {
      if (state.jobId) {
        await db.restoreJob.update({
          where: { id: state.jobId },
          data: {
            status: "cancelled",
            finishedAt: new Date(),
            error: "Cancelled by user",
            durationMs: cancelledState.durationMs,
            steps: JSON.stringify(cancelledState.steps),
          },
        });
      }
    } catch (e) {
      console.error("[restore/cancel] failed to update DB:", e);
    }

    // Clear global flag after short delay to let async loop exit
    setTimeout(() => {
      (globalThis as any).__restoreRunning = false;
    }, 500);

    return NextResponse.json({ ok: true, state: cancelledState });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
