import { NextRequest, NextResponse } from "next/server";
import { getConfig, maskConfig } from "@/lib/config-service";
import { requireAuthOrCli } from "@/lib/auth";
import { applyConfigPatch } from "@/lib/config-apply";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const res = await applyConfigPatch(body, { source: "ui" });
    if (!res.ok) {
      return NextResponse.json({ error: res.error.fa, errorBi: res.error }, { status: res.status });
    }
    return NextResponse.json(maskConfig(res.updated));
  } catch (e: unknown) {
    return NextResponse.json(
      {
        ...failMsg(bi(
          e instanceof Error ? e.message : "Unknown error while saving settings",
          e instanceof Error ? e.message : "Unknown error while saving settings"
        )),
      },
      { status: 500 }
    );
  }
}

/** Shape a bilingual error for an API response: fa text + pair. */
function failMsg(m: { fa: string; en: string }) {
  return { error: m.fa, errorBi: m };
}
