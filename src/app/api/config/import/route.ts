import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { maskConfig } from "@/lib/config-service";
import { applyConfigPatch, CONFIG_ALLOWED, isMasked, hasRealSecrets } from "@/lib/config-apply";
import { SECRET_FIELDS } from "@/lib/config-service";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_KEYS: readonly string[] = SECRET_FIELDS;

/**
 * POST /api/config/import — restore a settings file produced by
 * GET /api/config/export. Accepts either the wrapped export payload
 * ({ _bkupExport, config }) or a flat config object. Only known keys are
 * applied; masked secrets (•••) mean "keep the current value". The applied
 * rules are EXACTLY the Settings-form rules (shared applyConfigPatch).
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const raw = (body && typeof body === "object" && body.config && typeof body.config === "object"
      ? body.config
      : body) as Record<string, unknown>;

    // Only ALLOWED keys participate; masked secrets are dropped by applyConfigPatch.
    const flat: Record<string, unknown> = {};
    let applied = 0;
    let keptMasked = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (!CONFIG_ALLOWED.has(k)) continue;
      if (SECRET_KEYS.includes(k) && isMasked(v)) {
        keptMasked += 1;
        continue; // mask = keep current value — never persisted
      }
      flat[k] = v;
      applied += 1;
    }
    if (applied === 0 && keptMasked === 0) {
      const err = bi("No recognizable settings found in this file", "No recognizable settings found in this file");
      return NextResponse.json({ error: err.fa, errorBi: err }, { status: 400 });
    }

    const res = await applyConfigPatch(flat, { source: "import" });
    if (!res.ok) {
      return NextResponse.json({ error: res.error.fa, errorBi: res.error }, { status: res.status });
    }
    return NextResponse.json({
      ...maskConfig(res.updated),
      importedFields: applied,
      credentialsInFile: hasRealSecrets(flat),
    });
  } catch {
    const err = bi("The file could not be read as settings JSON", "The file could not be read as settings JSON");
    return NextResponse.json({ error: err.fa, errorBi: err }, { status: 400 });
  }
}
