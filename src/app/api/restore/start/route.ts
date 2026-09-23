import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { startRestore, startCustomRestore, type RestoreRequest, type CustomRestoreRequest, type PanelId } from "@/lib/restore-service";
import { normalizeRestoreTargetPath, validateRestoreTargetPath } from "@/lib/restore-target-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/restore/start — start a restore job.
 * Body: {
 *   sshHost, sshPort, sshUser, sshPassword?, sshPrivateKey?, sshPassphrase?,
 *   backupId, backupSource: "backup-run" | "reassembled",
 *   panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca"
 * }
 */
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Partial<RestoreRequest>;

  // Validate required fields
  const host = String(body.sshHost ?? "").trim();
  const port = Number(body.sshPort ?? 22);
  const user = String(body.sshUser ?? "").trim();
  const password = body.sshPassword ? String(body.sshPassword) : undefined;
  const privateKey = body.sshPrivateKey ? String(body.sshPrivateKey) : undefined;
  const passphrase = body.sshPassphrase ? String(body.sshPassphrase) : undefined;
  const backupId = Number(body.backupId);
  const backupSource = body.backupSource === "reassembled" ? "reassembled" : "backup-run";
  const panel = String(body.panel ?? "") as PanelId | "custom";

  if (!host) return NextResponse.json({ error: "SSH_HOST_REQUIRED" }, { status: 400 });
  if (!port || port < 1 || port > 65535) return NextResponse.json({ error: "INVALID_PORT" }, { status: 400 });
  if (!user) return NextResponse.json({ error: "SSH_USER_REQUIRED" }, { status: 400 });
  if (!password && !privateKey) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 400 });
  if (!backupId || backupId < 1) return NextResponse.json({ error: "BACKUP_ID_REQUIRED" }, { status: 400 });
  if (!["3x-ui", "hmpanel", "pasarguard", "rebecca", "custom"].includes(panel)) {
    return NextResponse.json({ error: "INVALID_PANEL" }, { status: 400 });
  }

  // Custom-path restore: a directory archive is unpacked into targetPath.
  // No panel install, no SSL, no Cloudflare — those fields are ignored.
  if (panel === "custom") {
    const targetPath = normalizeRestoreTargetPath(String((body as { targetPath?: string }).targetPath ?? ""));
    const targetErr = validateRestoreTargetPath(targetPath);
    if (targetErr) return NextResponse.json({ error: targetErr }, { status: 400 });

    const result = await startCustomRestore({
      sshHost: host,
      sshPort: port,
      sshUser: user,
      sshPassword: password,
      sshPrivateKey: privateKey,
      sshPassphrase: passphrase,
      backupId,
      backupSource,
      targetPath,
    } satisfies CustomRestoreRequest);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true, jobId: result.jobId });
  }

  const sslMode = ["none", "domain", "ip", "custom"].includes(String(body.sslMode)) ? String(body.sslMode) as any : "none";
  const sslDomain = body.sslDomain ? String(body.sslDomain).trim() : undefined;
  let sslDomains: string[] | undefined = undefined;
  if (Array.isArray((body as any).sslDomains)) {
    sslDomains = (body as any).sslDomains.map((d: any) => String(d).trim()).filter(Boolean);
  } else if (typeof (body as any).sslDomains === "string") {
    sslDomains = String((body as any).sslDomains)
      .split(/[\s,;]+/)
      .map((d) => d.trim())
      .filter(Boolean);
  }
  // Also support comma-separated in sslDomain itself
  if (sslDomain && sslDomain.includes(",") && !sslDomains?.length) {
    sslDomains = sslDomain
      .split(/[\s,;]+/)
      .map((d) => d.trim())
      .filter(Boolean);
  }
  const sslIp = body.sslIp ? String(body.sslIp).trim() : undefined;
  const sslCertPath = body.sslCertPath ? String(body.sslCertPath).trim() : undefined;
  const sslKeyPath = body.sslKeyPath ? String(body.sslKeyPath).trim() : undefined;

  const result = await startRestore({
    sshHost: host,
    sshPort: port,
    sshUser: user,
    sshPassword: password,
    sshPrivateKey: privateKey,
    sshPassphrase: passphrase,
    backupId,
    backupSource,
    panel,
    installNode: Boolean(body.installNode),
    sslMode,
    sslDomain,
    sslDomains,
    sslIp,
    sslCertPath,
    sslKeyPath,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, jobId: result.jobId });
}
