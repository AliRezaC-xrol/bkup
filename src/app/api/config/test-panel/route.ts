import { NextRequest, NextResponse } from "next/server";
import { saveConfig } from "@/lib/config-service";
import { testConnection } from "@/lib/panel-client";
import { hmTestConnection } from "@/lib/hmpanel-client";
import { pgTestConnection } from "@/lib/pasarguard-client";
import { rbTestConnection } from "@/lib/rebecca-client";
import { requireAuthOrCli } from "@/lib/auth";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tests ONE panel connection with the submitted form values (without saving
 * them first). The three panels are fully independent:
 *   body.panel = "3x-ui"     → tests the 3x-ui card fields
 *   body.panel = "hmpanel"   → tests the HM Panel card fields
 *   body.panel = "pasarguard" → tests the PasarGuard card fields
 * If `save: true` is passed, values are persisted after a successful test.
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as {
      config?: Record<string, unknown>;
      save?: boolean;
      panel?: string;
    };
    const current = await saveConfig({}); // ensure row exists
    const merged = { ...current } as unknown as Record<string, unknown>;

    if (body.config) {
      for (const [k, v] of Object.entries(body.config)) {
        if (typeof v === "string" && /^•+$/.test(v)) continue; // masked = unchanged
        merged[k] = v;
      }
    }

    const cfg = merged as Parameters<typeof testConnection>[0];
    const panel =
      body.panel === "hmpanel"
        ? "hmpanel"
        : body.panel === "pasarguard"
          ? "pasarguard"
          : body.panel === "rebecca"
            ? "rebecca"
            : "3x-ui";

    if (panel === "rebecca") {
      const res = await rbTestConnection(cfg);
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: res.error, errorBi: res.errorBi }, { status: 200 });
      }
      if (body.save && body.config) await saveConfig(keepUnmasked(body.config!));
      return NextResponse.json({
        ok: true,
        ...okMsg(bi(
          `اتصال به Rebecca موفق بود ✔ (${res.data!.username} @ ${res.data!.base}) — بکاپ کامل (دیتابیس + تنظیمات) در چرخه بعدی گرفته می‌شود`,
          `Connected to Rebecca successfully ✔ (${res.data!.username} @ ${res.data!.base}) — a full export (database + configuration) will be pulled on the next cycle`
        )),
      });
    }

    if (panel === "pasarguard") {
      const res = await pgTestConnection(cfg);
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: res.error, errorBi: res.errorBi }, { status: 200 });
      }
      if (body.save && body.config) await saveConfig(keepUnmasked(body.config!));
      const v = res.data!.pgVersion ? ` — ${res.data!.pgVersion}` : "";
      return NextResponse.json({
        ok: true,
        ...okMsg(bi(
          `اتصال به PasarGuard موفق بود ✔ (${res.data!.username} @ ${res.data!.base}${v}) — بکاپ کامل (کاربران + هاست‌ها + نودها + کورها + گروه‌ها + تنظیمات) در چرخه بعدی گرفته می‌شود`,
          `Connected to PasarGuard successfully ✔ (${res.data!.username} @ ${res.data!.base}${v}) — a full snapshot (users + hosts + nodes + cores + groups + settings) will be pulled on the next cycle`
        )),
      });
    }

    if (panel === "hmpanel") {
      const res = await hmTestConnection(cfg);
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: res.error, errorBi: res.errorBi }, { status: 200 });
      }
      // persist the DETECTED edition next to the saved credentials
      if (body.save && body.config) {
        await saveConfig({ ...keepUnmasked(body.config!), hmPremium: Boolean(res.data!.premium) });
      }
      const v = res.data!.hmVersion ? ` — ${res.data!.hmVersion}` : "";
      const prem = res.data!.premium ? " — Premium edition detected" : "";
      return NextResponse.json({
        ok: true,
        ...okMsg(bi(
          `اتصال به HMPanel موفق بود ✔ (${res.data!.username} @ ${res.data!.base}${v})${prem} — بکاپ کامل (دیتابیس + تنظیمات + آپلودها) در چرخه بعدی گرفته می‌شود`,
          `Connected to HMPanel successfully ✔ (${res.data!.username} @ ${res.data!.base}${v})${prem} — a full archive (database + config + uploads) will be pulled on the next cycle`
        )),
      });
    }

    const res = await testConnection(cfg);
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: res.error, errorBi: res.errorBi }, { status: 200 });
    }

    if (body.save && body.config) await saveConfig(keepUnmasked(body.config!));

    return NextResponse.json({
      ok: true,
      ...okMsg(bi(
        `اتصال موفق! نسخه پنل: ${res.data!.flavor} — تعداد اینباندها: ${res.data!.inboundCount}`,
        `Connection successful! Panel flavor: ${res.data!.flavor} — inbound count: ${res.data!.inboundCount}`
      )),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "خطای نامشخص", errorBi: bi(e instanceof Error ? e.message : "خطای نامشخص", e instanceof Error ? e.message : "Unknown error") },
      { status: 200 }
    );
  }
}

/** Shape a bilingual success message for an API response. */
function okMsg(m: { fa: string; en: string }) {
  return { message: m.fa, messageBi: m };
}

function keepUnmasked(config: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && /^•+$/.test(v)) continue; // masked = unchanged
    patch[k] = v;
  }
  return patch;
}
