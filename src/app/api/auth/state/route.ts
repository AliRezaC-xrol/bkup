import { NextResponse } from "next/server";
import { isAuthenticated, isPasswordSet } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight state probe used by the SPA to decide login/setup screens. */
export async function GET() {
  const [passwordSet, authenticated] = await Promise.all([isPasswordSet(), isAuthenticated()]);
  return NextResponse.json({ passwordSet, authenticated });
}
