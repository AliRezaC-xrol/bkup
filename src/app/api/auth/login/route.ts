import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  isPasswordSet,
  issueSession,
  setupPassword,
  verifyPassword,
  getSystem,
} from "@/lib/auth";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One endpoint, two phases:
 *  - POST /api/auth/login {password}                 → login (password already set)
 *  - POST /api/auth/login {password, setup: true}    → first-time password creation
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string; setup?: boolean };
    const password = String(body.password || "");
    if (password.length < 4) {
      return NextResponse.json({ error: "PASSWORD_TOO_SHORT" }, { status: 400 });
    }

    if (body.setup) {
      if (await isPasswordSet()) {
        return NextResponse.json({ error: "PASSWORD_ALREADY_SET" }, { status: 400 });
      }
      const token = await setupPassword(password);
      const store = await cookies();
      store.set(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
      await log("success", bi("پسورد پنل وب ساخته شد (setup اولیه)", "The web panel password was created (initial setup)"));
      return NextResponse.json({ ok: true, setup: true });
    }

    const row = await getSystem();
    if (!row.passwordHash) {
      return NextResponse.json({ error: "SETUP_REQUIRED" }, { status: 400 });
    }
    if (!verifyPassword(password, row)) {
      await log("warn", bi("تلاش ناموفق برای ورود به پنل وب", "A failed sign-in attempt on the web panel"));
      return NextResponse.json({ error: "WRONG_PASSWORD" }, { status: 401 });
    }
    const token = await issueSession();
    const store = await cookies();
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 3600,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "LOGIN_FAILED" }, { status: 500 });
  }
}
