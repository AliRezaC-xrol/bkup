import { NextRequest, NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/config-service";
import { sendTestMessage } from "@/lib/telegram";
import { requireAuthOrCli } from "@/lib/auth";
import { bi } from "@/lib/messages";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends a test message to the configured Telegram chat. */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { config?: Record<string, unknown>; save?: boolean };
    const current = await getConfig();
    const merged = { ...current } as unknown as Record<string, unknown>;

    if (body.config) {
      for (const [k, v] of Object.entries(body.config)) {
        if (typeof v === "string" && /^•+$/.test(v)) continue;
        merged[k] = v;
      }
    }

    const res = await sendTestMessage(merged as Parameters<typeof sendTestMessage>[0]);
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: res.error, errorBi: res.errorBi }, { status: 200 });
    }

    if (body.save && body.config) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body.config)) {
        if (typeof v === "string" && /^•+$/.test(v)) continue;
        patch[k] = v;
      }
      await saveConfig(patch);
    }

    return NextResponse.json({
      ok: true,
      message: "پیام تست با موفقیت به تلگرام ارسال شد",
      messageBi: bi("پیام تست با موفقیت به تلگرام ارسال شد", "The test message was sent to Telegram successfully"),
    });
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e ?? "unknown");
    const cause = (e as { cause?: { code?: string } })?.cause?.code ?? "";
    let en: string;
    if (raw.includes("fetch failed") || cause === "ENOTFOUND") {
      en = "Could not reach api.telegram.org from this server - check the server's internet/DNS (or run: curl -s https://api.telegram.org), then try again";
    } else if (cause === "ECONNREFUSED" || raw.includes("ECONNREFUSED")) {
      en = "The connection to api.telegram.org was refused - check the server's firewall/outbound access";
    } else if (cause === "ETIMEDOUT" || cause === "ECONNABORTED" || raw.includes("timeout")) {
      en = "The connection to api.telegram.org timed out - the server may be blocking Telegram or the route is unstable";
    } else {
      en = e instanceof Error ? e.message : "Unknown error";
    }
    return NextResponse.json({ ok: false, error: en, errorBi: bi(en, en) }, { status: 200 });
  }
}
