import { NextResponse } from "next/server";
import { updateDnsRecord } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, zoneId, recordId, ip, proxied, name } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
      zoneId: string;
      recordId: string;
      ip?: string;
      proxied?: boolean;
      name?: string;
    };

    if (!zoneId || !recordId) {
      return NextResponse.json({ ok: false, error: "zoneId and recordId required" }, { status: 400 });
    }
    if (!token && !(body.email && body.globalKey)) {
      return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
    }

    const creds = { token: token?.trim(), email: body.email?.trim(), globalKey: body.globalKey?.trim() };

    const updates: any = {};
    if (ip) updates.content = ip;
    if (typeof proxied === "boolean") updates.proxied = proxied;
    if (name) updates.name = name;
    updates.ttl = 1;

    const record = await updateDnsRecord(creds, zoneId, recordId, updates);

    return NextResponse.json({ ok: true, record });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to update record" }, { status: 400 });
  }
}
