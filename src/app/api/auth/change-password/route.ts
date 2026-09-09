import { NextRequest, NextResponse } from "next/server";
import { changePassword, requireAuth } from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Change the web-panel password (current session required). */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const { current, next } = (await req.json()) as { current?: string; next?: string };
    if (!next || next.length < 4) {
      return NextResponse.json({ error: "PASSWORD_TOO_SHORT" }, { status: 400 });
    }
    await changePassword(String(current || ""), String(next));
    await log("success", bi("پسورد پنل وب تغییر کرد", "The web panel password was changed"));
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "CHANGE_FAILED";
    const status = msg === "WRONG_PASSWORD" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
