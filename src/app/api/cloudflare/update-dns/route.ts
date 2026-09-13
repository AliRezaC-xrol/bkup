import { NextResponse } from "next/server";
import { upsertDnsRecord } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      token,
      email,
      globalKey,
      zoneId,
      zoneName,
      subName,
      ip,
      proxied,
      type,
    } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
      zoneId: string;
      zoneName: string;
      subName: string;
      ip: string;
      proxied?: boolean;
      type?: string;
    };

    if (!zoneId || !zoneName || !subName || !ip) {
      return NextResponse.json(
        { ok: false, error: "zoneId, zoneName, subName, ip required" },
        { status: 400 }
      );
    }
    if (!token && !(email && globalKey)) {
      return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
    }

    // Basic IP validation
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(ip) && !ip.includes(":")) {
      return NextResponse.json({ ok: false, error: "Invalid IP address" }, { status: 400 });
    }

    const creds = { token: token?.trim(), email: email?.trim(), globalKey: globalKey?.trim() };
    const result = await upsertDnsRecord(creds, zoneId, zoneName, subName, ip, {
      proxied: proxied ?? false,
      type: type || "A",
    });

    return NextResponse.json({ ok: true, action: result.action, record: result.record });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to update DNS" }, { status: 400 });
  }
}
