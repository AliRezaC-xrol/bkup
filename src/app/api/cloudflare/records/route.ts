import { NextResponse } from "next/server";
import { listDnsRecords } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, email, globalKey, zoneId, type } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
      zoneId: string;
      type?: string;
    };

    if (!zoneId) {
      return NextResponse.json({ ok: false, error: "zoneId required" }, { status: 400 });
    }
    if (!token && !(email && globalKey)) {
      return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
    }

    const creds = { token: token?.trim(), email: email?.trim(), globalKey: globalKey?.trim() };
    const records = await listDnsRecords(creds, zoneId, { type: type || "A", perPage: 100 });
    return NextResponse.json({ ok: true, records });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to list records" }, { status: 400 });
  }
}
