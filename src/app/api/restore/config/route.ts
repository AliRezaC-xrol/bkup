import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getRestoreConfig, saveRestoreConfig, maskRestoreConfig, RESTORE_SECRET_FIELDS } from "@/lib/restore-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/restore/config — restore settings (secrets masked). */
export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const cfg = await getRestoreConfig();
  return NextResponse.json(maskRestoreConfig(cfg));
}

/** PUT /api/restore/config — update restore settings. */
export async function PUT(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const patch: Record<string, unknown> = {};
  for (const key of ["xuiInstallScript", "hmInstallScript", "pgInstallScript", "rbInstallScript"] as const) {
    if (typeof body[key] === "string") patch[key] = String(body[key]).trim();
  }
  // GitHub token: skip update when the client sent the masked placeholder
  if (typeof body.githubToken === "string") {
    const v = String(body.githubToken);
    if (!RESTORE_SECRET_FIELDS.some((f) => v.includes("•"))) {
      patch.githubToken = v.trim();
    }
  }

  const cfg = await saveRestoreConfig(patch);
  return NextResponse.json(maskRestoreConfig(cfg));
}
