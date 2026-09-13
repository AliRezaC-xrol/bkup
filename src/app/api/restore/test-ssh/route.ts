import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { SshClient, SshError } from "@/lib/restore-ssh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/restore/test-ssh — test SSH connection without starting a restore.
 * Body: { sshHost, sshPort, sshUser, sshPassword?, sshPrivateKey?, sshPassphrase? }
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const host = String(body.sshHost ?? "").trim();
  const port = Number(body.sshPort ?? 22);
  const user = String(body.sshUser ?? "").trim();
  const password = body.sshPassword ? String(body.sshPassword) : undefined;
  const privateKey = body.sshPrivateKey ? String(body.sshPrivateKey) : undefined;
  const passphrase = body.sshPassphrase ? String(body.sshPassphrase) : undefined;

  if (!host) return NextResponse.json({ ok: false, error: "SSH host is required" }, { status: 400 });
  if (!user) return NextResponse.json({ ok: false, error: "SSH username is required" }, { status: 400 });
  if (!password && !privateKey) return NextResponse.json({ ok: false, error: "Password or private key is required" }, { status: 400 });

  const ssh = new SshClient();
  try {
    await ssh.connect({
      host,
      port: port || 22,
      username: user,
      password,
      privateKey,
      passphrase,
      timeout: 15000,
    });

    // Run a quick command to verify the connection works
    const res = await ssh.exec("echo BKUP_SSH_OK && uname -a");
    const output = res.stdout.trim();

    ssh.disconnect();

    if (output.includes("BKUP_SSH_OK")) {
      const uname = output.split("\n").slice(1).join(" ").trim();
      return NextResponse.json({
        ok: true,
        detail: `Connected — ${uname.slice(0, 100)}`,
      });
    }

    return NextResponse.json({
      ok: true,
      detail: "Connected to server",
    });
  } catch (e: unknown) {
    ssh.disconnect();
    if (e instanceof SshError) {
      return NextResponse.json({
        ok: false,
        error: e.message,
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg });
  }
}
