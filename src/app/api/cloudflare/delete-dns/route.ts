import { NextResponse } from "next/server";
import { deleteDnsRecord } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, zoneId, recordId } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
      zoneId: string;
      recordId: string;
    };

    if (!zoneId || !recordId) {
      return NextResponse.json(
        { ok: false, error: "zoneId and recordId required" },
        { status: 400 }
      );
    }
    if (!token && !(body.email && body.globalKey)) {
      return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
    }

    const creds = { token: token?.trim(), email: body.email?.trim(), globalKey: body.globalKey?.trim() };
    await deleteDnsRecord(creds, zoneId, recordId);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to delete DNS" }, { status: 400 });
  }
}
