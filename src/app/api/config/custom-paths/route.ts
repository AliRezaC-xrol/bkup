import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { getConfig } from "@/lib/config-service";
import { parseCustomPaths } from "@/lib/custom-path-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The custom-path list for the Settings UI. Paths are validated live so the
 * form can mark a missing folder before the admin ever saves.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;
  const cfg = await getConfig();
  const entries = parseCustomPaths(cfg.customPaths);
  return NextResponse.json({
    paths: entries,
    rootDir: process.cwd(),
    maxPaths: 16,
  });
}
