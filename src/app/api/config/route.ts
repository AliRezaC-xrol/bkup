import { NextRequest, NextResponse } from "next/server";
import { getConfig, saveConfig, maskConfig, SECRET_FIELDS } from "@/lib/config-service";
import { requireAuthOrCli } from "@/lib/auth";
import { restartScheduler } from "@/lib/scheduler";
import { invalidateSession } from "@/lib/panel-client";
import { hmInvalidateSession } from "@/lib/hmpanel-client";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_MASKABLE: readonly string[] = SECRET_FIELDS;

const ALLOWED = new Set([
  "panelType", // legacy v3.0 — accepted but ignored by v3.1 logic
  "xuiEnabled",
  "panelUrl",
  "panelBasePath",
  "panelUsername",
  "panelPassword",
  "authMode",
  "apiToken",
  "skipTlsVerify",
  "hmEnabled",
  "hmUrl",
  "hmUsername",
  "hmPassword",
  "pgEnabled",
  "pgUrl",
  "pgUsername",
  "pgPassword",
  "telegramApiBase",
  "telegramBotToken",
  "telegramChatId",
  "telegramThreadId",
  "intervalSeconds",
  "enabled",
  "backupMode",
  "localDbPath",
  "localRetention",
  "tgAutoDeleteKeep",
]);

function isMasked(v: unknown): boolean {
  return typeof v === "string" && /^•+$/.test(v);
}

function validateUrl(v: unknown, label: string): { fa: string; en: string } | null {
  const url = String(v ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) {
    return bi(`آدرس ${label} باید با http:// یا https:// شروع شود`, `The ${label} URL must start with http:// or https://`);
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const cfg = await getConfig();
  return NextResponse.json(maskConfig(cfg));
}

export async function PUT(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED.has(k)) continue;
      // Client sends masked secrets (•••) to mean "unchanged"
      if (SECRET_MASKABLE.includes(k) && isMasked(v)) continue;
      patch[k] = v;
    }

    // coerce & validate
    if (patch.intervalSeconds !== undefined) {
      const n = Number(patch.intervalSeconds);
      if (!Number.isFinite(n) || n < 10 || n > 86400) {
        return NextResponse.json(
          {
            ...failMsg(bi(
              "فاصله بکاپ باید بین ۱۰ ثانیه تا ۲۴ ساعت باشد",
              "The backup interval must be between 10 seconds and 24 hours"
            )),
          },
          { status: 400 }
        );
      }
      patch.intervalSeconds = Math.floor(n);
    }
    if (patch.localRetention !== undefined) {
      patch.localRetention = Math.max(0, Math.floor(Number(patch.localRetention) || 0));
    }
    if (patch.tgAutoDeleteKeep !== undefined) {
      patch.tgAutoDeleteKeep = Math.max(0, Math.floor(Number(patch.tgAutoDeleteKeep) || 0));
    }
    if (patch.authMode !== undefined && !["session", "bearer"].includes(String(patch.authMode))) {
      return NextResponse.json({ ...failMsg(bi("حالت احراز هویت نامعتبر است", "Invalid authentication mode")) }, { status: 400 });
    }
    if (patch.backupMode !== undefined && !["auto", "db", "json", "local"].includes(String(patch.backupMode))) {
      return NextResponse.json({ ...failMsg(bi("حالت بکاپ نامعتبر است", "Invalid backup mode")) }, { status: 400 });
    }
    if (patch.panelUrl !== undefined) {
      const err = validateUrl(patch.panelUrl, "پنل 3x-ui");
      if (err) return NextResponse.json({ ...failMsg(err) }, { status: 400 });
      patch.panelUrl = String(patch.panelUrl).trim().replace(/\/+$/, "");
    }
    if (patch.hmUrl !== undefined) {
      const err = validateUrl(patch.hmUrl, "HMPanel");
      if (err) return NextResponse.json({ ...failMsg(err) }, { status: 400 });
      patch.hmUrl = String(patch.hmUrl).trim().replace(/\/+$/, "");
    }
    if (patch.pgUrl !== undefined) {
      const err = validateUrl(patch.pgUrl, "PasarGuard");
      if (err) return NextResponse.json({ ...failMsg(err) }, { status: 400 });
      patch.pgUrl = String(patch.pgUrl).trim().replace(/\/+$/, "");
    }

    const updated = await saveConfig(patch);
    invalidateSession();
    hmInvalidateSession();
    restartScheduler();
    await log("info", bi("تنظیمات به‌روزرسانی شد", "Settings were updated"));
    return NextResponse.json(maskConfig(updated));
  } catch (e: unknown) {
    return NextResponse.json(
      { ...failMsg(bi(
        e instanceof Error ? e.message : "خطای نامشخص در ذخیره تنظیمات",
        e instanceof Error ? e.message : "Unknown error while saving settings"
      )) },
      { status: 500 }
    );
  }
}

/** Shape a bilingual error for an API response: fa text + pair. */
function failMsg(m: { fa: string; en: string }) {
  return { error: m.fa, errorBi: m };
}
