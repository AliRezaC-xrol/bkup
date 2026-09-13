import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrCli } from "@/lib/auth";
import { getConfig, maskConfig } from "@/lib/config-service";
import { APP_VERSION } from "@/lib/version";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/config/export            → credentials MASKED (safe to share/store)
 * GET /api/config/export?full=1     → REAL credentials included (server migration)
 *
 * The payload round-trips through POST /api/config/import. Masked secrets are
 * understood by the importer as "keep the current value", so a masked export
 * still restores every non-credential setting on a fresh install.
 */
export async function GET(req: NextRequest) {
  const denied = await requireAuthOrCli(req);
  if (denied) return denied;

  const full = req.nextUrl.searchParams.get("full") === "1";
  const cfg = await getConfig();
  const config = full ? cfg : maskConfig(cfg);

  await log(
    "info",
    bi(
      full ? "Settings were exported to a file (with credentials)" : "Settings were exported to a file",
      full ? "تنظیمات در فایلی ذخیره شد (همراه اعتبارنامه‌ها)" : "تنظیمات در فایلی ذخیره شد"
    )
  );

  return NextResponse.json(
    {
      _bkupExport: 1,
      version: 1,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      credentialsIncluded: full,
      config,
    },
    {
      headers: full
        ? { "Content-Disposition": "inline" } // the UI names the file; never cache this
        : undefined,
    }
  );
}
