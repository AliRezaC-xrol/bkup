import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { exec } from "node:child_process";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/system/change-port {port}
 * Writes the new PORT into the env file, preserving every other line
 * (especially DATABASE_URL), then schedules a detached service restart
 * ~2s later. The response is sent before the restart.
 * Restarts the CURRENT unit name: bkup (v4+) or legacy autobackup-xui.
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  const { port } = (await req.json().catch(() => ({}))) as { port?: number };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return NextResponse.json({ error: "INVALID_PORT" }, { status: 400 });
  }
  if (p === Number(process.env.PORT || 3000)) {
    return NextResponse.json({ error: "SAME_PORT" }, { status: 400 });
  }

  try {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const envFile = process.env.ABX_ENV_FILE || process.env.BKUP_ENV_FILE || path.join(process.cwd(), ".env");
    let content = "";
    try {
      content = fs.readFileSync(envFile, "utf8");
    } catch {
      /* new file */
    }
    // replace ONLY the PORT line — everything else (DATABASE_URL, BACKUP_DIR,
    // TZ, …) must survive untouched or the database would be lost on restart
    const lines = content
      .split("\n")
      .filter((l) => l.trim() && !/^PORT=/i.test(l.trim()));
    lines.push(`PORT=${p}`);
    if (!lines.some((l) => /^DATABASE_URL=/i.test(l.trim()))) {
      lines.push(`DATABASE_URL=file:${path.join(process.cwd(), "db", "custom.db")}`);
    }
    fs.writeFileSync(envFile, lines.join("\n") + "\n");

    await log("info", bi(`درخواست تغییر پورت وب‌پنل به ${p} — سرویس ظرف چند ثانیه ری‌استارت می‌شود`, `A web panel port change to ${p} was requested — the service restarts within a few seconds`));

    // schedule detached restart: current unit first (bkup), then the legacy one
    const restart = spawn(
      "bash",
      [
        "-c",
        [
          "sleep 2",
          'if command -v systemctl >/dev/null 2>&1; then',
          "  if systemctl list-unit-files 2>/dev/null | grep -q '^bkup.service'; then systemctl restart bkup;",
          "  elif systemctl list-unit-files 2>/dev/null | grep -q '^autobackup-xui.service'; then systemctl restart autobackup-xui;",
          "  fi",
          "fi",
        ].join("; "),
      ],
      { detached: true, stdio: "ignore" }
    );
    restart.unref();
    void exec; // keep import used

    return NextResponse.json({ ok: true, port: p });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "PORT_CHANGE_FAILED" },
      { status: 500 }
    );
  }
}
