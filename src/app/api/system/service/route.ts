import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { requireAuth } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Service control (start / stop / restart) for the web panel System tab.
 * Only fixed systemctl verbs are allowed — no user input reaches the shell.
 * When systemd is unavailable (containers), reports unsupported.
 */

// Current unit name — bkup; legacy installs (pre-4.0) still use autobackup-xui.
const SERVICE_CANDIDATES = ["bkup", "autobackup-xui"] as const;

async function resolveService(): Promise<string> {
  for (const s of SERVICE_CANDIDATES) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile("systemctl", ["list-unit-files", `${s}.service`], (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.includes(`${s}.service`));
      });
    });
    if (ok) return s;
  }
  return "bkup"; // default for fresh installs / non-systemd hosts
}

async function hasUnit(): Promise<boolean> {
  const svc = await resolveService();
  return new Promise((resolve) => {
    execFile("systemctl", ["list-unit-files", `${svc}.service`], (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.includes(`${svc}.service`));
    });
  });
}

async function run(action: "start" | "stop" | "restart"): Promise<{ ok: boolean; error?: string }> {
  const svc = await resolveService();
  return new Promise((resolve) => {
    execFile("systemctl", [action, svc], (err, _stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String(stderr || err.message) });
      resolve({ ok: true });
    });
  });
}

async function state(): Promise<string> {
  const svc = await resolveService();
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", svc], (err, stdout) => {
      resolve(err ? "inactive" : String(stdout).trim());
    });
  });
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const unit = await hasUnit();
  return NextResponse.json({
    supported: unit,
    state: unit ? await state() : "unknown",
  });
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = (await req.json()) as { action?: string };
    const action = body.action;
    if (!action || !["start", "stop", "restart"].includes(action)) {
      return NextResponse.json({ error: "action must be start | stop | restart" }, { status: 400 });
    }
    if (!(await hasUnit())) {
      return NextResponse.json(
        { error: "systemd unit not found on this host" },
        { status: 400 }
      );
    }
    const res = await run(action as "start" | "stop" | "restart");
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? "systemctl failed" }, { status: 500 });
    }
    await log("info", bi(`سرویس با دستور «${action}» از پنل وب کنترل شد`, `The service was controlled from the web panel with the "${action}" command`));
    return NextResponse.json({ ok: true, state: await state() });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
