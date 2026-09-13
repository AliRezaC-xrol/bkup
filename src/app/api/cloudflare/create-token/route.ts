import { NextResponse } from "next/server";
import { createApiToken } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, globalKey, name, zoneIds } = body as {
      email: string;
      globalKey: string;
      name?: string;
      zoneIds?: string[];
    };

    if (!email || !globalKey) {
      return NextResponse.json(
        { ok: false, error: "Email and Global API Key required to create token" },
        { status: 400 }
      );
    }

    const creds = { email: email.trim(), globalKey: globalKey.trim() };
    const result = await createApiToken(creds, name || `bkup-${Date.now()}`, { zoneIds });

    return NextResponse.json({ ok: true, token: result.token, id: result.id });
  } catch (e: any) {
    // Provide helpful fallback message
    const msg = e.message || "Failed to create API token";
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        hint: "You can manually create a token at https://dash.cloudflare.com/profile/api-tokens with Zone:Read and DNS:Edit permissions",
      },
      { status: 400 }
    );
  }
}
