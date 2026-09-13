import { NextResponse } from "next/server";
import { listZones } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { token, email, globalKey, page } = body as {
      token?: string;
      email?: string;
      globalKey?: string;
      page?: number;
    };

    if (!token && !(email && globalKey)) {
      return NextResponse.json(
        { ok: false, error: "Missing Cloudflare credentials" },
        { status: 400 }
      );
    }

    const creds = { token: token?.trim(), email: email?.trim(), globalKey: globalKey?.trim() };
    const { zones, total } = await listZones(creds, page || 1, 50);
    return NextResponse.json({ ok: true, zones, total });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to list zones" }, { status: 400 });
  }
}
