import { NextResponse } from "next/server";
import { verifyCloudflare } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, email, globalKey } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
    };

    if (!token && !(email && globalKey)) {
      return NextResponse.json(
        { ok: false, error: "Provide API Token or Email + Global API Key" },
        { status: 400 }
      );
    }

    const creds = {
      token: token?.trim(),
      email: email?.trim(),
      globalKey: globalKey?.trim(),
    };

    const result = await verifyCloudflare(creds);
    return NextResponse.json({ ok: true, zones: result.zones });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e.message || "Cloudflare verification failed" },
      { status: 400 }
    );
  }
}
