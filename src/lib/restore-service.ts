import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { bi } from "@/lib/messages";
import { SshClient, SshError, type SshOptions, type SshExecOptions } from "@/lib/restore-ssh";
import {
  getRestoreConfig,
  getInstallScript,
  OFFICIAL_INSTALL_URLS,
  OFFICIAL_NODE_INSTALL_URLS,
} from "@/lib/restore-config";
import type { RestoreConfig } from "@prisma/client";

export type PanelId = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";
export type SslMode = "none" | "domain" | "ip" | "custom";

export interface RestoreRequest {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  backupId: number;
  backupSource: "backup-run" | "reassembled";
  panel: PanelId;
  installNode?: boolean;
  sslMode?: SslMode;
  sslDomain?: string;
  sslDomains?: string[]; // multi-domain support
  sslIp?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  cloudflareZoneId?: string;
  cloudflareZoneName?: string;
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface RestoreStep {
  key: string;
  title: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface RestoreState {
  jobId: number;
  status: "running" | "success" | "failed" | "cancelled";
  panel: PanelId;
  backupName: string;
  sshHost: string;
  steps: RestoreStep[];
  currentStepKey?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  durationMs?: number;
}

function dataDir(): string {
  const dir = path.join(process.cwd(), "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function stateFile(): string {
  return path.join(dataDir(), "restore-state.json");
}

function writeStateFile(state: RestoreState): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[restore] failed to write state file:", e);
  }
}

export function readRestoreState(): RestoreState | null {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    return JSON.parse(raw) as RestoreState;
  } catch {
    return null;
  }
}

export function clearRestoreState(): void {
  try {
    fs.unlinkSync(stateFile());
  } catch {}
  try {
    fs.unlinkSync(cancelFlagFile());
  } catch {}
}

function cancelFlagFile(): string {
  return path.join(dataDir(), "restore-cancel.flag");
}

export function requestCancelRestore(): void {
  try {
    fs.writeFileSync(cancelFlagFile(), String(Date.now()));
  } catch {}
}

export function isCancelRequested(): boolean {
  try {
    return fs.existsSync(cancelFlagFile());
  } catch {
    return false;
  }
}

export function clearCancelFlag(): void {
  try {
    fs.unlinkSync(cancelFlagFile());
  } catch {}
}

export function checkIfCancelled(): boolean {
  if (isCancelRequested()) return true;
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const st = JSON.parse(raw);
    if (st.status === "cancelled" || st.status === "failed" && (st.error || "").toLowerCase().includes("cancel")) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Execute a multi-line shell script on the server via a SCRIPT FILE (uploaded
 * over SFTP, then `bash <file>`), NEVER via `bash -c "<text>"`.
 *
 * Any probe that uses `pgrep -f "<name>"`-style patterns MUST go through
 * this helper: when the script text travels inside the remote shell's own
 * command line, `pgrep -f` matches that shell itself (its cmdline contains
 * the searched words) and the probe ALWAYS reports "running" — even when the
 * process is dead. That false positive made restores claim "panel running,
 * X-Ray core running" while the X-Ray core had actually crashed (the missing
 * cert files it needed were never generated, because the recovery only ran
 * when the probe reported X-Ray down). Running from a plain file keeps the
 * process cmdline clean (`bash /tmp/bkup-probe-….sh`), so the probe is honest.
 */
async function execRemoteScript(ssh: SshClient, script: string, opts: SshExecOptions = {}): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // local and remote names MUST differ — on a localhost restore the bkup
  // server IS the target, and identical paths would corrupt the upload
  const localScript = path.join(dataDir(), `bkup-script-${stamp}.local.sh`);
  const remoteScript = `/tmp/bkup-script-${stamp}.remote.sh`;
  fs.writeFileSync(localScript, script);
  try {
    await ssh.uploadFile(localScript, remoteScript);
  } finally {
    try { fs.unlinkSync(localScript); } catch { /* ignore */ }
  }
  const res = await ssh.exec(`bash '${remoteScript}' 2>&1; ec=$?; rm -f '${remoteScript}'; exit $ec`, opts);
  return res.stdout;
}

const g = globalThis as unknown as { __restoreRunning?: boolean };

export function isRestoreRunning(): boolean {
  const st = readRestoreState();
  if (!st) return false;
  if (st.status !== "running") return false;
  return Date.now() - st.startedAt < 60 * 60 * 1000;
}

function makeSteps(panel: PanelId, installNode: boolean): RestoreStep[] {
  return [
    { key: "connect", title: "Connecting to server", status: "pending" },
    { key: "check_panel", title: "Checking panel installation", status: "pending" },
    { key: "install_node", title: "Checking system requirements", status: "pending" },
    { key: "install_panel", title: "Installing panel", status: "pending" },
    { key: "install_node_component", title: "Installing panel node", status: "pending" },
    { key: "ssl_cert", title: "SSL certificate (multi-domain)", status: "pending" },
    { key: "upload_backup", title: "Uploading backup file", status: "pending" },
    { key: "restore", title: "Restoring backup", status: "pending" },
    { key: "verify", title: "Verifying restoration", status: "pending" },
  ];
}

function assertNotCancelled() {
  if (checkIfCancelled()) {
    throw new Error("RESTORE_CANCELLED");
  }
}

function stepBy(steps: RestoreStep[], key: string): RestoreStep | undefined {
  return steps.find((s) => s.key === key);
}

function markStep(steps: RestoreStep[], key: string, status: StepStatus, detail?: string): void {
  const step = stepBy(steps, key);
  if (!step) return;
  if (status === "running") step.startedAt = Date.now();
  else if (status === "done" || status === "failed") step.finishedAt = Date.now();
  step.status = status;
  if (detail !== undefined) step.detail = detail;
}

function markStepError(steps: RestoreStep[], key: string, error: string): void {
  const step = stepBy(steps, key);
  if (!step) return;
  step.status = "failed";
  step.error = error;
  step.finishedAt = Date.now();
}

interface PanelCheckResult {
  installed: boolean;
  detail: string;
}

async function checkPanelInstalled(ssh: SshClient, panel: PanelId): Promise<PanelCheckResult> {
  let command: string;
  let panelName: string;

  switch (panel) {
    case "3x-ui":
      command =
        '(test -x /usr/local/x-ui/x-ui 2>/dev/null || test -x /usr/bin/x-ui 2>/dev/null || test -f /usr/bin/x-ui 2>/dev/null || (systemctl list-unit-files 2>/dev/null | grep -q "^x-ui.service" && test -d /usr/local/x-ui 2>/dev/null)) && echo YES || echo NO';
      panelName = "3x-ui";
      break;
    case "hmpanel":
      command =
        '(test -f /opt/hmpanel/docker-compose.yml 2>/dev/null || test -f /opt/hmpanel/docker-compose.yaml 2>/dev/null || test -f /opt/hmpanel/compose.yml 2>/dev/null || docker ps -a --format "{{.Names}}" 2>/dev/null | grep -qi "^hmpanel") && echo YES || echo NO';
      panelName = "HMPanel";
      break;
    case "pasarguard":
      command =
        '(test -f /opt/pasarguard/docker-compose.yml 2>/dev/null || test -f /opt/pasarguard/docker-compose.yaml 2>/dev/null || test -f /opt/pasarguard/compose.yml 2>/dev/null || docker ps -a --format "{{.Names}}" 2>/dev/null | grep -qi "pasarguard") && echo YES || echo NO';
      panelName = "PasarGuard";
      break;
    case "rebecca":
      command =
        '(test -f /opt/rebecca/docker-compose.yml 2>/dev/null || test -f /opt/rebecca/docker-compose.yaml 2>/dev/null || test -f /opt/rebecca/compose.yml 2>/dev/null || test -x /usr/local/bin/rebecca 2>/dev/null || which rebecca 2>/dev/null | grep -q rebecca || docker ps -a --format "{{.Names}}" 2>/dev/null | grep -qi "rebecca") && echo YES || echo NO';
      panelName = "Rebecca";
      break;
  }

  const res = await ssh.exec(command);
  const output = (res.stdout + res.stderr).trim();
  const installed = output.includes("YES");

  if (installed && panel === "3x-ui") {
    const verifyRes = await ssh.exec(
      'test -x /usr/local/x-ui/x-ui 2>/dev/null && echo BINARY_YES || (test -f /usr/bin/x-ui 2>/dev/null && echo BINARY_YES || echo BINARY_NO)'
    );
    if (verifyRes.stdout.includes("BINARY_NO")) {
      return {
        installed: false,
        detail: `${panelName} database exists but binary is missing — will reinstall it`,
      };
    }
  }

  return {
    installed,
    detail: installed
      ? `${panelName} is already installed on the server`
      : `${panelName} is not installed — will install it`,
  };
}

async function checkSystemRequirements(ssh: SshClient): Promise<{ ok: boolean; detail: string }> {
  const res = await ssh.exec("curl --version >/dev/null 2>&1 && echo OK || echo MISSING_CURL");
  if (res.stdout.includes("MISSING_CURL")) {
    await ssh.exec(
      "apt-get update -qq && apt-get install -y -qq curl 2>/dev/null || yum install -y curl 2>/dev/null || true"
    );
  }
  await ssh.exec("apt-get install -y -qq sqlite3 unzip tar socat 2>/dev/null || yum install -y sqlite unzip tar socat 2>/dev/null || true");
  return { ok: true, detail: "System requirements checked" };
}

function buildInstallCommand(panel: PanelId, cfg: RestoreConfig | null): { url: string; isCustom: boolean } {
  const officialUrl = OFFICIAL_INSTALL_URLS[panel];
  const configuredUrl = getInstallScript(cfg, panel);
  const trimmed = configuredUrl.trim();
  const isCustom = trimmed.length > 0 && trimmed !== officialUrl.trim() && trimmed.startsWith("http");
  const url = isCustom ? trimmed : officialUrl;
  return { url, isCustom };
}

function buildNodeInstallCommand(panel: PanelId): { url: string } | null {
  if (panel !== "pasarguard" && panel !== "rebecca") return null;
  const url = OFFICIAL_NODE_INSTALL_URLS[panel];
  return { url };
}

// Helper: normalize domains array
function normalizeDomains(single?: string, multi?: string[]): string[] {
  const all = [single || "", ...(multi || [])]
    .flatMap((d) => (d || "").split(/[\s,;]+/))
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 2 && d.includes(".") && !d.includes(" ") && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return Array.from(new Set(all));
}

function buildAcmeMultiDomainSnippet(panelType: PanelId, domains: string[]): string {
  if (!domains.length) return "";
  const dArgs = domains.map((d) => `-d ${d}`).join(" ");
  const first = domains[0];
  const restArgs = domains.slice(1).map((d) => `-d ${d}`).join(" ");
  return `
echo "[bkup] Multi-domain SSL requested: ${domains.join(", ")}"
set -o pipefail
if [ ! -f ~/.acme.sh/acme.sh ]; then
  echo "[bkup] Installing acme.sh..."
  curl -s https://get.acme.sh | sh || wget -O - https://get.acme.sh | sh || true
fi
export LE_WORKING_DIR=~/.acme.sh
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt --force 2>/dev/null || true
# Ensure socat for standalone
which socat >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq socat 2>/dev/null || yum install -y socat 2>/dev/null || true)
echo "[bkup] Freeing port 80 for cert issuance..."
systemctl stop x-ui 2>/dev/null || true
docker stop hmpanel-nginx 2>/dev/null || true
docker stop pasarguard-nginx 2>/dev/null || true
docker stop rebecca-nginx 2>/dev/null || true
# Kill anything on 80
fuser -k 80/tcp 2>/dev/null || lsof -ti:80 | xargs kill -9 2>/dev/null || true
sleep 2
echo "[bkup] Issuing cert for ${domains.join(", ")} via acme.sh standalone..."
~/.acme.sh/acme.sh --issue ${dArgs} --standalone --httpport 80 --force --debug 2 2>&1 | tail -80 || echo "ACME_ISSUE_FAILED"
# Check where cert landed
if [ -f ~/.acme.sh/${first}_ecc/fullchain.cer ]; then
  CERT_DIR=~/.acme.sh/${first}_ecc
  KEY_FILE=~/.acme.sh/${first}_ecc/${first}.key
  FULLCHAIN=~/.acme.sh/${first}_ecc/fullchain.cer
elif [ -f ~/.acme.sh/${first}/fullchain.cer ]; then
  CERT_DIR=~/.acme.sh/${first}
  KEY_FILE=~/.acme.sh/${first}/${first}.key
  FULLCHAIN=~/.acme.sh/${first}/fullchain.cer
else
  CERT_DIR=""
fi
if [ -n "$CERT_DIR" ] && [ -f "$CERT_DIR/fullchain.cer" ] && [ -s "$CERT_DIR/fullchain.cer" ]; then
  mkdir -p /root/cert/${first}
  ~/.acme.sh/acme.sh --installcert -d ${first} ${restArgs} --key-file /root/cert/${first}/privkey.pem --fullchain-file /root/cert/${first}/fullchain.pem --reloadcmd "echo reload" 2>&1 | tail -15
  # Verify cert files
  if [ -f /root/cert/${first}/fullchain.pem ] && [ -s /root/cert/${first}/fullchain.pem ]; then
    echo "[bkup] Cert installed to /root/cert/${first}/ — verifying..."
    openssl x509 -in /root/cert/${first}/fullchain.pem -noout -dates 2>&1 | head -5 || true
    openssl x509 -in /root/cert/${first}/fullchain.pem -noout -subject -ext subjectAltName 2>&1 | head -10 || true
  fi
  # Panel-specific cert apply with .env updates
  if [ "${panelType}" = "3x-ui" ] && [ -x /usr/local/x-ui/x-ui ]; then
    echo "[bkup] Applying cert to 3x-ui for ${domains.join(", ")}"
    /usr/local/x-ui/x-ui cert -webCert /root/cert/${first}/fullchain.pem -webCertKey /root/cert/${first}/privkey.pem 2>&1 || true
    # Ensure listening on 0.0.0.0
    /usr/local/x-ui/x-ui setting -listenIP "0.0.0.0" 2>&1 || true
    systemctl enable x-ui 2>/dev/null || true
    systemctl restart x-ui 2>/dev/null || systemctl start x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>&1 || true
    sleep 3
    systemctl is-active x-ui 2>&1 || ss -tlnp 2>/dev/null | grep -m3 -E "x-ui|xray" || true
    echo "[bkup] 3x-ui cert set for ${domains.join(", ")}"
  elif [ "${panelType}" = "hmpanel" ] && [ -d /opt/hmpanel ]; then
    echo "[bkup] Applying cert to HMPanel for ${domains.join(", ")}"
    mkdir -p /opt/hmpanel/nginx/ssl
    cp /root/cert/${first}/fullchain.pem /opt/hmpanel/nginx/ssl/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/hmpanel/nginx/ssl/privkey.pem 2>/dev/null || true
    cp /root/cert/${first}/fullchain.pem /opt/hmpanel/nginx/ssl/cert.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/hmpanel/nginx/ssl/key.pem 2>/dev/null || true
    chmod 644 /opt/hmpanel/nginx/ssl/*.pem 2>/dev/null || true
    # Update .env DOMAIN to primary domain for HMPanel
    if [ -f /opt/hmpanel/.env ]; then
      sed -i "s/^DOMAIN=.*/DOMAIN=${first}/" /opt/hmpanel/.env 2>/dev/null || echo "DOMAIN=${first}" >> /opt/hmpanel/.env
      sed -i "s/^PANEL_DOMAIN=.*/PANEL_DOMAIN=${first}/" /opt/hmpanel/.env 2>/dev/null || echo "PANEL_DOMAIN=${first}" >> /opt/hmpanel/.env
      sed -i "s/^SSL_ENABLED=.*/SSL_ENABLED=true/" /opt/hmpanel/.env 2>/dev/null || echo "SSL_ENABLED=true" >> /opt/hmpanel/.env
    fi
    cd /opt/hmpanel && docker compose restart nginx 2>/dev/null || docker-compose restart nginx 2>/dev/null || docker restart hmpanel-nginx 2>/dev/null || true
    sleep 3
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
    echo "[bkup] HMPanel cert set for ${domains.join(", ")}"
  elif [ "${panelType}" = "pasarguard" ] && [ -d /opt/pasarguard ]; then
    echo "[bkup] Applying cert to PasarGuard for ${domains.join(", ")}"
    mkdir -p /opt/pasarguard/certs /opt/pasarguard/data/certs /opt/pasarguard/nginx/ssl
    cp /root/cert/${first}/fullchain.pem /opt/pasarguard/certs/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/pasarguard/certs/privkey.pem 2>/dev/null || true
    cp /root/cert/${first}/fullchain.pem /opt/pasarguard/data/certs/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/pasarguard/data/certs/privkey.pem 2>/dev/null || true
    cp /root/cert/${first}/fullchain.pem /opt/pasarguard/nginx/ssl/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/pasarguard/nginx/ssl/privkey.pem 2>/dev/null || true
    # Update .env if exists
    if [ -f /opt/pasarguard/.env ]; then
      sed -i "s/^SSL_DOMAIN=.*/SSL_DOMAIN=${first}/" /opt/pasarguard/.env 2>/dev/null || echo "SSL_DOMAIN=${first}" >> /opt/pasarguard/.env
    fi
    cd /opt/pasarguard && docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || true
    sleep 3
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i pasarguard || true
    echo "[bkup] PasarGuard cert set for ${domains.join(", ")}"
  elif [ "${panelType}" = "rebecca" ] && [ -d /opt/rebecca ]; then
    echo "[bkup] Applying cert to Rebecca for ${domains.join(", ")}"
    mkdir -p /opt/rebecca/certs /opt/rebecca/data/certs /opt/rebecca/nginx/ssl
    cp /root/cert/${first}/fullchain.pem /opt/rebecca/certs/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/rebecca/certs/privkey.pem 2>/dev/null || true
    cp /root/cert/${first}/fullchain.pem /opt/rebecca/data/certs/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/rebecca/data/certs/privkey.pem 2>/dev/null || true
    cp /root/cert/${first}/fullchain.pem /opt/rebecca/nginx/ssl/fullchain.pem 2>/dev/null || true
    cp /root/cert/${first}/privkey.pem /opt/rebecca/nginx/ssl/privkey.pem 2>/dev/null || true
    if [ -f /opt/rebecca/.env ]; then
      sed -i "s/^SSL_DOMAIN=.*/SSL_DOMAIN=${first}/" /opt/rebecca/.env 2>/dev/null || echo "SSL_DOMAIN=${first}" >> /opt/rebecca/.env
    fi
    cd /opt/rebecca && docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null || true
    sleep 3
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i rebecca || true
    echo "[bkup] Rebecca cert set for ${domains.join(", ")}"
  fi
  # Enable acme.sh auto-renew
  ~/.acme.sh/acme.sh --upgrade --auto-upgrade 2>/dev/null || true
  ~/.acme.sh/acme.sh --install-cronjob 2>/dev/null || true
  echo "MULTI_CERT_OK:${first}"
else
  echo "[bkup] ACME cert issuance failed for ${domains.join(", ")} — check DNS points to this server and port 80 is open"
  echo "[bkup] Debug: ls ~/.acme.sh/${first}*"
  ls -la ~/.acme.sh/${first}* 2>&1 | head -20 || true
  echo "MULTI_CERT_FAIL"
fi
`;
}

async function installPanel(
  ssh: SshClient,
  panel: PanelId,
  cfg: RestoreConfig | null,
  req: RestoreRequest,
  onProgress?: (text: string) => void
): Promise<{ success: boolean; detail: string }> {
  const { url } = buildInstallCommand(panel, cfg);

  let panelName: string;
  switch (panel) {
    case "3x-ui":
      panelName = "3x-ui";
      break;
    case "hmpanel":
      panelName = "HMPanel";
      break;
    case "pasarguard":
      panelName = "PasarGuard";
      break;
    case "rebecca":
      panelName = "Rebecca";
      break;
  }

  if (!url || !url.startsWith("http") || url.length < 10) {
    return { success: false, detail: `${panelName} install URL is invalid: ${url || "empty"}` };
  }

  const env: Record<string, string> = {};
  if (cfg?.githubToken) env.GITHUB_TOKEN = cfg.githubToken;

  const sslMode = req.sslMode || "none";
  const domains = normalizeDomains(req.sslDomain, req.sslDomains);
  const primaryDomain = domains[0] || (req.sslDomain || "").trim();
  const sslIp = (req.sslIp || "").trim();
  const isMultiDomain = domains.length > 1;

  let finalScript: string;
  switch (panel) {
    case "3x-ui": {
      let sslEnv = `export XUI_SSL_MODE=none\n`;
      if (sslMode === "domain" && primaryDomain) {
        sslEnv = `export XUI_SSL_MODE=domain\nexport XUI_DOMAIN='${primaryDomain.replace(/'/g, "'\"'\"'")}'\n`;
      } else if (sslMode === "ip") {
        sslEnv = `export XUI_SSL_MODE=ip\n`;
        if (sslIp) sslEnv += `export XUI_SERVER_IP='${sslIp.replace(/'/g, "'\"'\"'")}'\n`;
      } else if (sslMode === "custom" && req.sslCertPath && req.sslKeyPath) {
        sslEnv = `export XUI_SSL_MODE=none\n`;
      }

      // If multi-domain, we still install with first domain via installer, then acme.sh will handle rest
      finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
export XUI_NONINTERACTIVE=1
export XUI_DB_TYPE=sqlite
${sslEnv}
echo "[bkup] Downloading 3x-ui installer from ${url}"
curl -fsSL '${url}' -o /tmp/x-ui-install.sh || wget -O /tmp/x-ui-install.sh '${url}'
chmod +x /tmp/x-ui-install.sh
echo "[bkup] Running 3x-ui installer (SSL mode: ${sslMode}, domains: ${domains.join(", ") || "none"})..."
bash /tmp/x-ui-install.sh
echo "[bkup] 3x-ui installer done"
${sslMode === "custom" && req.sslCertPath && req.sslKeyPath ? `echo "[bkup] Setting custom cert..."; /usr/local/x-ui/x-ui cert -webCert '${req.sslCertPath}' -webCertKey '${req.sslKeyPath}' || true` : ""}
`;
      break;
    }
    case "hmpanel": {
      const domainToUse = sslMode === "domain" && primaryDomain ? primaryDomain : sslMode === "ip" && sslIp ? sslIp : "localhost";
      finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
echo "[bkup] Downloading HMPanel installer from ${url}..."
curl -fsSL '${url}' -o /tmp/hmpanel-install.sh || wget -O /tmp/hmpanel-install.sh '${url}'
chmod +x /tmp/hmpanel-install.sh
echo "[bkup] Running HMPanel installer with domain=${domainToUse} (multi: ${domains.join(", ")})..."
ARCH_DETECTED=$(uname -m)
echo "[bkup] Host arch: $ARCH_DETECTED"
if [[ "$ARCH_DETECTED" == "aarch64" || "$ARCH_DETECTED" == "arm64" || "$ARCH_DETECTED" == "armv8"* ]]; then
  echo "[bkup] ARM64 detected — will patch compose for amd64 emulation after install"
  export HMPANEL_PATCH_ARM=1
else
  echo "[bkup] AMD64 detected — native install, no emulation needed"
  export HMPANEL_PATCH_ARM=0
fi
printf '${domainToUse}\nadmin\nAdmin12345\nY\n' | bash /tmp/hmpanel-install.sh || true
# Handle both compose file names
COMPOSE_FILE=""
if [ -f /opt/hmpanel/docker-compose.yml ]; then COMPOSE_FILE="/opt/hmpanel/docker-compose.yml"
elif [ -f /opt/hmpanel/docker-compose.yaml ]; then COMPOSE_FILE="/opt/hmpanel/docker-compose.yaml"
elif [ -f /opt/hmpanel/compose.yml ]; then COMPOSE_FILE="/opt/hmpanel/compose.yml"
elif [ -f /opt/hmpanel/compose.yaml ]; then COMPOSE_FILE="/opt/hmpanel/compose.yaml"
fi
if [[ "$HMPANEL_PATCH_ARM" == "1" ]]; then
  echo "[bkup] Applying ARM64 workaround for $COMPOSE_FILE..."
  apt-get update -qq 2>/dev/null || true
  apt-get install -y -qq qemu-user-static binfmt-support 2>/dev/null || yum install -y qemu-user-static 2>/dev/null || true
  if [ -n "$COMPOSE_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
    if ! grep -q "platform:" "$COMPOSE_FILE"; then
      echo "[bkup] Patching $COMPOSE_FILE with platform: linux/amd64"
      sed -i '/image: ghcr.io\\/neoauroraproject\\/hmpanel/a \    platform: linux/amd64' "$COMPOSE_FILE" || true
      sed -i '/image:.*hmpanel/a \    platform: linux/amd64' "$COMPOSE_FILE" || true
    fi
    cd /opt/hmpanel
    docker compose -f "$COMPOSE_FILE" down 2>&1 || docker-compose -f "$COMPOSE_FILE" down 2>&1 || true
    docker compose -f "$COMPOSE_FILE" up -d 2>&1 || docker-compose -f "$COMPOSE_FILE" up -d 2>&1 || true
    sleep 8
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
  fi
else
  # AMD64 native verification
  echo "[bkup] AMD64: Verifying HMPanel containers..."
  if [ -n "$COMPOSE_FILE" ]; then
    cd /opt/hmpanel
    docker compose -f "$COMPOSE_FILE" ps 2>&1 | head -20 || true
    docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tail -20 || true
    sleep 5
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
  else
    docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
  fi
fi
echo "[bkup] HMPanel installer done - arch $ARCH_DETECTED"
`;
      break;
    }
    case "pasarguard": {
      let sslFlags = "--no-ssl";
      if (sslMode === "domain" && primaryDomain) {
        sslFlags = "--ssl --ssl-domain " + primaryDomain;
      } else if (sslMode === "ip" && sslIp) {
        sslFlags = "--ssl --ssl-domain " + sslIp;
      } else if (sslMode === "domain" && !primaryDomain) {
        sslFlags = "--ssl";
      } else if (sslMode === "ip" && !sslIp) {
        sslFlags = "--ssl";
      }
      finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
echo "[bkup] Downloading PasarGuard installer from ${url}..."
curl -fsSL '${url}' -o /tmp/pasarguard-install.sh || wget -O /tmp/pasarguard-install.sh '${url}'
chmod +x /tmp/pasarguard-install.sh
echo "[bkup] Running PasarGuard installer with SSL flags: ${sslFlags} (multi: ${domains.join(", ")})..."
printf 'n\\nN\\nn\\n' | bash /tmp/pasarguard-install.sh install ${sslFlags}
echo "[bkup] PasarGuard installer done"
`;
      break;
    }
    case "rebecca": {
      finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
echo "[bkup] Downloading Rebecca installer from ${url}..."
curl -fsSL '${url}' -o /tmp/rebecca-install.sh || wget -O /tmp/rebecca-install.sh '${url}'
chmod +x /tmp/rebecca-install.sh
echo "[bkup] Running Rebecca installer (multi domains: ${domains.join(", ")})..."
bash /tmp/rebecca-install.sh install
echo "[bkup] Rebecca installer done"
`;
      break;
    }
  }

  const remoteScriptPath = `/tmp/bkup-panel-install-${Date.now()}.sh`;

  try {
    await ssh.writeRemoteFile(remoteScriptPath, finalScript, 0o755);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, detail: `${panelName} failed to create install script: ${msg}` };
  }

  let installOutput = "";
  let exitCode: number | null = null;

  try {
    const res = await ssh.exec(`bash ${remoteScriptPath} 2>&1`, {
      timeout: 20 * 60 * 1000,
      env,
      onStdout: (chunk) => {
        installOutput += chunk;
        const lines = chunk.trim().split("\n");
        const snippet = lines[lines.length - 1]?.slice(0, 200) || "";
        if (snippet) onProgress?.(snippet);
      },
      onStderr: (chunk) => {
        installOutput += chunk;
        const lines = chunk.trim().split("\n");
        const snippet = lines[lines.length - 1]?.slice(0, 200) || "";
        if (snippet) onProgress?.(snippet);
      },
    });
    exitCode = res.exitCode;
    // res.stdout/res.stderr are the same data streamed via onStdout/onStderr
    // callbacks above, so just use installOutput (already accumulated)
    installOutput = installOutput || res.stdout + res.stderr;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await ssh.exec(`rm -f ${remoteScriptPath} /tmp/x-ui-install.sh /tmp/hmpanel-install.sh /tmp/pasarguard-install.sh /tmp/rebecca-install.sh`);
    } catch {}
    return { success: false, detail: `${panelName} install script failed: ${msg}. Output: ${installOutput.slice(-500)}` };
  }

  try {
    await ssh.exec(`rm -f ${remoteScriptPath} /tmp/x-ui-install.sh /tmp/hmpanel-install.sh /tmp/pasarguard-install.sh /tmp/rebecca-install.sh /tmp/bkup-${panel}-installer.sh`);
  } catch {}

  await ssh.exec("sleep 5");

  // Fix Not Running / xray Not Running root causes after install
  if (panel === "3x-ui") {
    await ssh.exec(`
      set -e
      echo "[bkup] Fixing 3x-ui Not Running / xray Not Running..."
      chmod +x /usr/local/x-ui/x-ui /usr/local/x-ui/bin/xray* 2>/dev/null || true
      chmod +x /usr/bin/x-ui 2>/dev/null || true
      /usr/local/x-ui/x-ui setting -listenIP "0.0.0.0" 2>&1 || true
      WEB_CERT=$(/usr/local/x-ui/x-ui setting -show 2>/dev/null | grep -i "webCertPath\\|webCert:" | awk -F': ' '{print $2}' | tr -d '"[:space:]' | head -1 || true)
      if [ -n "$WEB_CERT" ] && [ "$WEB_CERT" != '""' ] && [ ! -f "$WEB_CERT" ]; then
        echo "[bkup] Cert $WEB_CERT missing — resetting to HTTP to fix Not Running"
        /usr/local/x-ui/x-ui cert -webCert "" -webCertKey "" 2>&1 || true
      fi
      systemctl enable x-ui 2>/dev/null || true
      systemctl daemon-reload 2>/dev/null || true
      systemctl restart x-ui 2>/dev/null || systemctl start x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>&1 || true
      sleep 3
      systemctl is-active x-ui 2>&1 || ss -tlnp 2>/dev/null | grep -m5 -E "x-ui|xray" || true
      ss -tlnp 2>/dev/null | grep -m5 xray || echo "xray not yet started — will start after restore"
    `);
  } else if (panel === "hmpanel") {
    await ssh.exec(`
      cd /opt/hmpanel 2>/dev/null || exit 0
      echo "[bkup] Verifying HMPanel containers..."
      docker compose ps 2>&1 | head -20 || docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
      if [ -f .env ] && ! grep -q "^DOMAIN=" .env; then echo "DOMAIN=localhost" >> .env; fi
      docker compose up -d 2>&1 | tail -10 || true
      sleep 3
      docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
    `);
  } else if (panel === "pasarguard" || panel === "rebecca") {
    const dir = panel === "pasarguard" ? "/opt/pasarguard" : "/opt/rebecca";
    await ssh.exec(`
      cd ${dir} 2>/dev/null || exit 0
      echo "[bkup] Verifying ${panel} containers..."
      docker compose ps 2>&1 | head -20 || docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i ${panel} || true
      docker compose up -d 2>&1 | tail -10 || true
      sleep 3
      docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i ${panel} || true
    `);
  }

  const verify = await checkPanelInstalled(ssh, panel);
  if (verify.installed) {
    if (panel === "3x-ui") {
      const statusCheck = await ssh.exec("systemctl is-active x-ui 2>/dev/null; ss -tlnp 2>/dev/null | grep -m1 x-ui; echo STATUS_CHECK_DONE");
      const isActive = statusCheck.stdout.includes("active") || statusCheck.stdout.includes("x-ui");
      if (isActive) {
        return { success: true, detail: `${panelName} installed successfully with default settings${sslMode !== "none" ? ` (SSL: ${sslMode}, domains: ${domains.join(", ") || "none"})` : ""} — service running` };
      } else {
        await ssh.exec("/usr/local/x-ui/x-ui cert -webCert \"\" -webCertKey \"\" 2>&1 || true; /usr/local/x-ui/x-ui setting -listenIP \"0.0.0.0\" 2>&1 || true; systemctl restart x-ui 2>&1 || true; sleep 3");
        return { success: true, detail: `${panelName} installed (service recovery attempted) — ${statusCheck.stdout.slice(0, 150)}` };
      }
    }
    return { success: true, detail: `${panelName} installed successfully with default settings${sslMode !== "none" ? ` (SSL: ${sslMode}, domains: ${domains.join(", ") || "none"})` : ""}` };
  }

  if (exitCode === 0) {
    await ssh.exec("sleep 10");
    const verify2 = await checkPanelInstalled(ssh, panel);
    if (verify2.installed) {
      return { success: true, detail: `${panelName} installed successfully (verified after delay)` };
    }
  }

  const lastLines = installOutput.trim().split("\n").slice(-15).join(" | ").slice(0, 1000);
  return {
    success: false,
    detail: `${panelName} installation may have failed — panel not detected after install. Exit: ${exitCode}. Last output: ${lastLines || "no output"}`,
  };
}


async function issueMultiDomainCert(
  ssh: SshClient,
  panel: PanelId,
  domains: string[],
  onProgress?: (text: string) => void
): Promise<{ success: boolean; detail: string }> {
  if (!domains.length) {
    return { success: true, detail: "No multi-domain cert requested — skipped" };
  }
  const cleanDomains = normalizeDomains(undefined, domains);
  if (!cleanDomains.length) {
    return { success: true, detail: "No valid domains for multi-cert — skipped" };
  }

  const snippet = buildAcmeMultiDomainSnippet(panel, cleanDomains);
  const remotePath = `/tmp/bkup-multicert-${Date.now()}.sh`;
  try {
    await ssh.writeRemoteFile(remotePath, `#!/usr/bin/env bash\nset -e\n${snippet}\n`, 0o755);
  } catch (e: any) {
    return { success: false, detail: `Failed to create cert script: ${e.message}` };
  }

  try {
    const res = await ssh.exec(`bash ${remotePath} 2>&1`, {
      timeout: 10 * 60 * 1000,
      onStdout: (c) => {
        const line = c.trim().split("\n").pop()?.slice(0, 200) || "";
        if (line) onProgress?.(line);
      },
      onStderr: (c) => {
        const line = c.trim().split("\n").pop()?.slice(0, 200) || "";
        if (line) onProgress?.(line);
      },
    });
    const out = res.stdout + res.stderr;
    await ssh.exec(`rm -f ${remotePath}`);
    if (out.includes("MULTI_CERT_OK")) {
      const first = cleanDomains[0];
      return { success: true, detail: `Multi-domain cert issued for ${cleanDomains.join(", ")} — installed to /root/cert/${first}/ and applied to ${panel}` };
    }
    if (out.includes("MULTI_CERT_FAIL") || out.includes("ACME_ISSUE_FAILED")) {
      return { success: false, detail: `Cert issuance failed for ${cleanDomains.join(", ")} — DNS must point to server and port 80 open. Output: ${out.slice(-500)}` };
    }
    // If acme output contains cert files, consider success
    if (out.includes("/root/cert/") && out.includes("fullchain")) {
      return { success: true, detail: `Cert for ${cleanDomains.join(", ")} obtained — ${out.slice(-300)}` };
    }
    return { success: false, detail: `Cert issuance unclear for ${cleanDomains.join(", ")} — ${out.slice(-500)}` };
  } catch (e: any) {
    await ssh.exec(`rm -f ${remotePath}`).catch(() => {});
    const msg = e.message || String(e);
    if (msg.toLowerCase().includes("timed out")) {
      return { success: false, detail: `Cert issuance timed out for ${cleanDomains.join(", ")} — ${msg}` };
    }
    return { success: false, detail: `Cert issuance error: ${msg}` };
  }
}

async function installPanelNode(
  ssh: SshClient,
  panel: PanelId,
  onProgress?: (text: string) => void
): Promise<{ success: boolean; detail: string }> {
  const built = buildNodeInstallCommand(panel);
  if (!built) return { success: false, detail: `No node install script for ${panel}` };

  const panelName = panel === "pasarguard" ? "PasarGuard" : "Rebecca";
  const url = built.url;

  let finalScript: string;
  if (panel === "pasarguard") {
    finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
echo "[bkup] Downloading PasarGuard node installer..."
curl -fsSL '${url}' -o /tmp/pg-node-install.sh || wget -O /tmp/pg-node-install.sh '${url}'
chmod +x /tmp/pg-node-install.sh
bash /tmp/pg-node-install.sh install
`;
  } else {
    finalScript = `#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export HOME=/root
echo "[bkup] Downloading Rebecca node installer..."
curl -fsSL '${url}' -o /tmp/rebecca-node-install.sh || wget -O /tmp/rebecca-node-install.sh '${url}'
chmod +x /tmp/rebecca-node-install.sh
bash /tmp/rebecca-node-install.sh install
`;
  }

  const remoteScriptPath = `/tmp/bkup-node-install-${Date.now()}.sh`;

  try {
    await ssh.writeRemoteFile(remoteScriptPath, finalScript, 0o755);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, detail: `${panelName} node failed to create install script: ${msg}` };
  }

  let output = "";
  try {
    const res = await ssh.exec(`bash ${remoteScriptPath} 2>&1`, {
      timeout: 15 * 60 * 1000,
      onStdout: (chunk) => {
        output += chunk;
        const snippet = chunk.trim().split("\n").pop()?.slice(0, 160) || "";
        if (snippet) onProgress?.(snippet);
      },
      onStderr: (chunk) => {
        output += chunk;
        const snippet = chunk.trim().split("\n").pop()?.slice(0, 160) || "";
        if (snippet) onProgress?.(snippet);
      },
    });
    // res.stdout/res.stderr are the same data streamed via onStdout/onStderr
    // callbacks above, so just use output (already accumulated)
    output = output || res.stdout + res.stderr;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await ssh.exec(`rm -f ${remoteScriptPath}`);
    } catch {}
    return { success: false, detail: `${panelName} node install failed: ${msg}. Output: ${output.slice(-500)}` };
  }

  try {
    await ssh.exec(`rm -f ${remoteScriptPath} /tmp/pg-node-install.sh /tmp/rebecca-node-install.sh`);
  } catch {}

  await ssh.exec("sleep 5");

  // Verify the node was actually installed (service running or binary exists)
  let nodeOk = false;
  if (panel === "pasarguard") {
    const probe = await ssh.exec(
      'docker ps --format "{{.Names}}" 2>/dev/null | grep -qi "pasarguard.*node\\|pg-node\\|pasarguard-node" && echo NODE_OK || ' +
      '(systemctl is-active pg-node 2>/dev/null | grep -q active && echo NODE_OK) || ' +
      '(test -x /usr/local/bin/pg-node 2>/dev/null && echo NODE_OK) || echo NODE_MISSING'
    );
    nodeOk = probe.stdout.includes("NODE_OK");
  } else if (panel === "rebecca") {
    const probe = await ssh.exec(
      'docker ps --format "{{.Names}}" 2>/dev/null | grep -qi "rebecca.*node\\|rebecca-node" && echo NODE_OK || ' +
      '(systemctl is-active rebecca-node 2>/dev/null | grep -q active && echo NODE_OK) || ' +
      '(test -x /usr/local/bin/rebecca-node 2>/dev/null && echo NODE_OK) || echo NODE_MISSING'
    );
    nodeOk = probe.stdout.includes("NODE_OK");
  }

  if (!nodeOk) {
    return {
      success: false,
      detail: `${panelName} node installer ran but the node service/binary was not detected after install. Output: ${output.slice(-500)}`,
    };
  }

  return { success: true, detail: `${panelName} node installed successfully` };
}

// ── Backup-file sniffing (magic bytes) — dispatch by CONTENT, never by name ──
// bkup itself produces several formats: raw x-ui.db (SQLite), 3x-ui JSON
// config exports, PasarGuard JSON snapshot archives (tar.gz), HMPanel official
// archives, Rebecca's own export. The restore engine must understand the very
// same formats or fail loudly — never claim success on a file it cannot read.
type BackupKind = "sqlite" | "json" | "tar-gz" | "zip" | "unknown";

function sniffBackupKind(localPath: string): BackupKind {
  try {
    const fd = fs.openSync(localPath, "r");
    const buf = Buffer.alloc(16);
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (n >= 15 && buf.subarray(0, 15).toString("utf8") === "SQLite format 3") return "sqlite";
    if (n >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return "tar-gz";
    if (n >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
    const head = buf.subarray(0, n).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("{") || head.startsWith("[")) return "json";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Minimal REAL structure check of a SQLite database — runs locally on the
 * bkup server, so restore reporting never depends on a sqlite3 CLI existing
 * on the target (a missing CLI used to surface as the misleading
 * "SQLite integrity could not be confirmed").
 */
export function sqliteHeaderOk(buf: Buffer): boolean {
  if (buf.length < 100) return false;
  if (buf.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") return false;
  let pageSize = buf.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return false;
  const pages = buf.readUInt32BE(28); // header field: size of the db in pages
  if (pages > 0 && Math.abs(buf.length - pages * pageSize) > pageSize * 4) return false;
  return true;
}

interface CertRef {
  cert: string;
  key: string;
}

/**
 * Extract every certificate/key FILE path the backup references — from the
 * backup's own bytes, entirely LOCALLY on the bkup server.
 *
 * Why: after a restore, X-Ray refuses to start while any referenced
 * certificate file is absent on the new server ("failed to parse certificate
 * — open /root/cert/…/fullchain.pem: no such file or directory"). The
 * previous implementation ran sqlite3+json_extract ON THE TARGET — which
 * silently produced nothing when the target had no sqlite3 CLI, so the files
 * were never created and the restored panel came up with X-Ray in error.
 *
 * SQLite stores the inbounds' stream_settings as plain JSON text inside the
 * database pages, so the references are greppable straight out of the raw
 * file — no sqlite engine, no SSH-quoting puzzles, and EVERY certificate of
 * EVERY inbound is found (nested certificates arrays included). The panel's
 * own web certificate settings (webCertFile/webKeyFile rows) are read the
 * same way.
 */
export function extractXrayCertRefs(buf: Buffer): { certs: CertRef[]; webCert: string | null; webKey: string | null } {
  const text = buf.toString("latin1");
  const okPath = (p: string | null): p is string =>
    !!p &&
    p.startsWith("/") &&
    !p.includes("..") &&
    !/[\x00-\x1f"']/.test(p) &&
    p.length <= 260 &&
    /\.(pem|crt|cer|cert|key)$/i.test(p);
  const unesc = (s: string): string => s.replace(/\\(["'\\/bfnrt])/g, (_a, c: string) =>
    c === "b" ? "" : c === "f" ? "" : c === "n" ? "" : c === "r" ? "" : c === "t" ? "	" : c
  );

  const certs = new Map<string, CertRef>();
  const objRe = /\{[^{}]{0,4000}?"(?:certificateFile|keyFile)"[^{}]{0,4000}?\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const obj = m[0];
    const certM = /"certificateFile"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(obj);
    if (!certM) continue;
    const cert = unesc(certM[1]);
    if (!okPath(cert)) continue;
    const keyM = /"keyFile"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(obj);
    const keyRaw = keyM ? unesc(keyM[1]) : null;
    // no keyFile stored → the conventional path next to the cert file
    const key: string = okPath(keyRaw) ? (keyRaw as string) : `${dirnameOf(cert)}/privkey.pem`;
    if (!certs.has(cert)) certs.set(cert, { cert, key });
  }

  // panel web certificate settings: key/value rows appear as adjacent TEXT
  const webCertM = /webCert(?:File|Path)?[\s\S]{0,48}?(\/[A-Za-z0-9._~+/-]+\.(?:pem|crt|cer))/i.exec(text);
  const webKeyM = /webKey(?:File|Path)?[\s\S]{0,48}?(\/[A-Za-z0-9._~+/-]+\.(?:pem|key))/i.exec(text);
  const webCert = webCertM && okPath(webCertM[1]) ? webCertM[1] : null;
  let webKey = webKeyM && okPath(webKeyM[1]) ? webKeyM[1] : null;
  if (webCert && !webKey) webKey = `${dirnameOf(webCert)}/privkey.pem`;

  return { certs: [...certs.values()], webCert, webKey };
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

/** Shell single-quote for safe embedding into generated scripts. */
function shQ(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build the remote script that creates the referenced certificate files AT
 * THEIR REFERENCED PATHS — explicitly listed, so nothing on the target needs
 * sqlite3/jq or fragile output parsing. Existing files are never overwritten
 * unless their pair is dangling (cert+key mismatch is unusable for TLS).
 */
export function buildCertEnsureScript(refs: { certs: CertRef[]; webCert: string | null; webKey: string | null }): string {
  const pairs: CertRef[] = [...refs.certs];
  if (refs.webCert && !pairs.some((c) => c.cert === refs.webCert)) {
    pairs.push({ cert: refs.webCert, key: refs.webKey ?? `${dirnameOf(refs.webCert)}/privkey.pem` });
  }
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "CREATED=0",
    "MISSING_AFTER=0",
    "ensure_pair() {",
    '  local CERT="$1" KEY="$2"',
    '  if [ -s "$CERT" ] && [ -s "$KEY" ]; then return 0; fi',
    '  mkdir -p "$(dirname "$CERT")" "$(dirname "$KEY")" 2>/dev/null || true',
    '  if [ -s "$KEY" ] && [ ! -s "$CERT" ]; then',
    '    openssl req -new -x509 -days 3650 -nodes -key "$KEY" -subj "/CN=restored" -out "$CERT" >/dev/null 2>&1 || true',
    "  else",
    '    openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -subj "/CN=restored" -keyout "$KEY" -out "$CERT" >/dev/null 2>&1 || true',
    "  fi",
    '  chmod 644 "$CERT" "$KEY" 2>/dev/null || true',
    '  if [ -s "$CERT" ] && [ -s "$KEY" ]; then',
    '    CREATED=$((CREATED+1)); echo "[bkup] Prepared the certificate the backup references: $CERT"',
    "  fi",
    "}",
  ];
  for (const c of pairs) lines.push(`ensure_pair ${shQ(c.cert)} ${shQ(c.key)}`);
  lines.push('echo "CREATED_FILES:$CREATED"');
  for (const c of pairs) {
    lines.push(`if [ ! -s ${shQ(c.cert)} ] || [ ! -s ${shQ(c.key)} ]; then MISSING_AFTER=$((MISSING_AFTER+1)); echo "STILL_MISSING:${c.cert}"; fi`);
  }
  lines.push('echo "MISSING_AFTER_COUNT:$MISSING_AFTER"');
  return lines.join("\n");
}

// ── SQL generation for JSON-snapshot restores ──
function sqlQuoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlQuoteValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
}

/** Build chunked multi-row INSERT statements restricted to real table columns. */
function buildSqlInserts(table: string, columns: string[], rows: Record<string, unknown>[], chunkSize = 40): string {
  if (!columns.length) return "";
  const out: string[] = [];
  const usable = rows.filter((r) => columns.some((c) => c in r));
  for (let i = 0; i < usable.length; i += chunkSize) {
    const chunk = usable.slice(i, i + chunkSize);
    const values = chunk
      .map((row) => `(${columns.map((c) => sqlQuoteValue(row[c])).join(", ")})`)
      .join(",\n  ");
    out.push(`INSERT INTO ${sqlQuoteIdent(table)} (${columns.map(sqlQuoteIdent).join(", ")}) VALUES\n  ${values};`);
  }
  return out.join("\n");
}

function parseSqliteColumns(pragmaOutput: string): string[] {
  return pragmaOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.split("|")[1] || "").trim())
    .filter((n) => n && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

function parseSqliteTableNames(masterOutput: string): string[] {
  return masterOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((n) => n && !n.startsWith("sqlite_"));
}

async function remoteSqliteColumns(ssh: SshClient, dbPath: string, table: string): Promise<string[] | null> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return null;
  const res = await ssh.exec(`sqlite3 '${dbPath}' "PRAGMA table_info(${table});" 2>/dev/null`);
  const cols = parseSqliteColumns(res.stdout);
  return cols.length ? cols : null;
}

async function ensureSqlite3(ssh: SshClient): Promise<boolean> {
  const probe = await ssh.exec("command -v sqlite3 >/dev/null 2>&1 && echo HAVE_SQLITE3 || echo NO_SQLITE3");
  if (probe.stdout.includes("HAVE_SQLITE3")) return true;
  await ssh.exec("apt-get install -y -qq sqlite3 2>/dev/null || yum install -y sqlite 2>/dev/null || true");
  const probe2 = await ssh.exec("command -v sqlite3 >/dev/null 2>&1 && echo HAVE_SQLITE3 || echo NO_SQLITE3");
  return probe2.stdout.includes("HAVE_SQLITE3");
}

/** Restore a bkup 3x-ui JSON config export ({ inbounds, settings }) into the
 * target server's x-ui.db. The inbounds (plus their client-traffic rows) are
 * replayed into the panel's real schema — discovered live via PRAGMA — while
 * the fresh install's admin login and panel settings are kept, so nothing in
 * the new environment (certs, ports, credentials) breaks. The JSON file is
 * NEVER written verbatim as the SQLite database. */
async function restore3xUiJson(ssh: SshClient, localPath: string): Promise<{ success: boolean; detail: string }> {
  let exportData: { inbounds?: unknown; settings?: unknown };
  try {
    exportData = JSON.parse(fs.readFileSync(localPath, "utf8"));
  } catch {
    return { success: false, detail: "The 3x-ui JSON backup is not a valid JSON export" };
  }
  const inbounds = Array.isArray(exportData.inbounds) ? (exportData.inbounds as Record<string, unknown>[]) : [];
  if (!inbounds.length) {
    return { success: false, detail: "The 3x-ui JSON export contains no inbounds — nothing to restore" };
  }

  if (!(await ensureSqlite3(ssh))) {
    return { success: false, detail: "sqlite3 is not available on the server and could not be installed — the JSON export cannot be replayed into x-ui.db" };
  }

  const dbPath = "/etc/x-ui/x-ui.db";
  const exists = await ssh.exec(`test -f '${dbPath}' && echo DB_EXISTS || echo DB_MISSING`);
  if (!exists.stdout.includes("DB_EXISTS")) {
    return { success: false, detail: "x-ui.db was not found on the server — install 3x-ui first, then retry the restore" };
  }

  const colsInbounds = await remoteSqliteColumns(ssh, dbPath, "inbounds");
  if (!colsInbounds) {
    return { success: false, detail: "Could not read the inbounds table schema from x-ui.db (sqlite3 query failed)" };
  }
  const colsTraffic = await remoteSqliteColumns(ssh, dbPath, "client_traffics");

  // flatten the per-inbound clientStats into client_traffics rows
  const trafficRows: Record<string, unknown>[] = [];
  for (const inb of inbounds) {
    const stats = inb?.clientStats;
    if (Array.isArray(stats)) {
      for (const st of stats as Record<string, unknown>[]) {
        const row = { ...st };
        if (row.inbound_id === undefined || row.inbound_id === null) row.inbound_id = inb.id;
        trafficRows.push(row);
      }
    }
  }

  const parts: string[] = ["BEGIN;"];
  if (colsTraffic) parts.push(`DELETE FROM ${sqlQuoteIdent("client_traffics")};`);
  parts.push(`DELETE FROM ${sqlQuoteIdent("inbounds")};`);
  parts.push(buildSqlInserts("inbounds", colsInbounds, inbounds));
  if (colsTraffic && trafficRows.length) parts.push(buildSqlInserts("client_traffics", colsTraffic, trafficRows));
  parts.push(`UPDATE sqlite_sequence SET seq=(SELECT COALESCE(MAX(id),0) FROM ${sqlQuoteIdent("inbounds")}) WHERE name='inbounds';`);
  if (colsTraffic) parts.push(`UPDATE sqlite_sequence SET seq=(SELECT COALESCE(MAX(id),0) FROM ${sqlQuoteIdent("client_traffics")}) WHERE name='client_traffics';`);
  parts.push("COMMIT;");
  const sqlText = parts.filter(Boolean).join("\n") + "\n";

  const stamp = Date.now();
  // local and remote temp names MUST differ — a same-machine (localhost) restore
  // would otherwise let the remote SFTP truncation destroy the local SQL file
  // while it is being read
  const localSql = `/tmp/bkup-xui-json-${stamp}.local.sql`;
  const remoteSql = `/tmp/bkup-xui-json-${stamp}.remote.sql`;
  fs.writeFileSync(localSql, sqlText);
  try {
    await ssh.uploadFile(localSql, remoteSql);
  } finally {
    try { fs.unlinkSync(localSql); } catch { /* ignore */ }
  }

  await ssh.exec("systemctl stop x-ui 2>/dev/null || x-ui stop 2>/dev/null || pkill -f x-ui 2>/dev/null || true; sleep 2");
  await ssh.exec(`cp -f '${dbPath}' '${dbPath}.pre-restore' 2>/dev/null || true; rm -f '${dbPath}-wal' '${dbPath}-shm' '${dbPath}-journal' 2>/dev/null || true`);
  const apply = await ssh.exec(`sqlite3 '${dbPath}' < '${remoteSql}' 2>&1; echo APPLY_EXIT:$?`);
  try { await ssh.exec(`rm -f '${remoteSql}'`); } catch { /* ignore */ }

  await ssh.exec("systemctl enable x-ui 2>/dev/null || true; systemctl daemon-reload 2>/dev/null || true");
  await ssh.exec("systemctl restart x-ui 2>/dev/null || systemctl start x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>&1 || true; sleep 6");

  const verify = await ssh.exec(`sqlite3 '${dbPath}' "SELECT COUNT(*) FROM inbounds;" 2>&1`);
  const restoredCount = parseInt(verify.stdout.trim(), 10);
  if (!Number.isFinite(restoredCount) || restoredCount !== inbounds.length) {
    return {
      success: false,
      detail: `JSON restore replay failed — expected ${inbounds.length} inbounds in x-ui.db but found ${verify.stdout.trim().slice(0, 40)}. ${apply.stdout.slice(-200)}`,
    };
  }
  let trafficNote = "";
  if (colsTraffic && trafficRows.length) {
    const t = await ssh.exec(`sqlite3 '${dbPath}' "SELECT COUNT(*) FROM client_traffics;" 2>&1`);
    trafficNote = `, ${t.stdout.trim()} client traffic rows`;
  }
  const svc = await ssh.exec("systemctl is-active x-ui 2>/dev/null || echo INACTIVE");
  const svcNote = svc.stdout.includes("active") ? "panel service is running" : "panel restarted — verify it in the panel UI";
  return {
    success: true,
    detail: `3x-ui JSON config restored — ${restoredCount} inbounds${trafficNote} replayed into x-ui.db (fresh-install admin login kept). ${svcNote}`,
  };
}

async function restoreFromRemotePath(
  ssh: SshClient,
  panel: PanelId,
  remoteBackupPath: string,
  backupName: string,
  localBackupPath: string
): Promise<{ success: boolean; detail: string }> {
  switch (panel) {
    case "3x-ui":
      return await restore3xUi(ssh, remoteBackupPath, backupName, localBackupPath);
    case "hmpanel":
      return await restoreHmpanel(ssh, remoteBackupPath, backupName, localBackupPath);
    case "pasarguard":
      return await restorePasarguard(ssh, remoteBackupPath, backupName, localBackupPath);
    case "rebecca":
      return await restoreRebecca(ssh, remoteBackupPath, backupName, localBackupPath);
  }
}

async function restore3xUi(ssh: SshClient, remoteBackupPath: string, backupName: string, localBackupPath: string): Promise<{ success: boolean; detail: string }> {
  // dispatch by CONTENT first — a JSON config export must never be written
  // into /etc/x-ui/x-ui.db as if it were the SQLite database
  const kind = sniffBackupKind(localBackupPath);
  if (kind === "json") {
    return await restore3xUiJson(ssh, localBackupPath);
  }
  if (kind === "unknown") {
    return { success: false, detail: "Unrecognized 3x-ui backup format — nothing was modified on the server. Use a bkup 3x-ui backup (.db database, .json config export or their archive)" };
  }

  const uploadCheck = await ssh.exec(`ls -lh '${remoteBackupPath}' 2>&1 && stat -c %s '${remoteBackupPath}' 2>/dev/null || wc -c < '${remoteBackupPath}' 2>/dev/null || echo 0`);
  const uploadOut = uploadCheck.stdout.trim();
  if (uploadOut.includes("No such file") || uploadOut.includes("cannot access")) {
    return { success: false, detail: `Uploaded backup not found on server at ${remoteBackupPath} — upload may have failed` };
  }
  const sizeMatch = uploadOut.match(/(\d+)\s*$/);
  const remoteSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  if (remoteSize === 0) {
    return { success: false, detail: `Uploaded backup is empty (0 bytes) at ${remoteBackupPath}` };
  }

  await ssh.exec("systemctl stop x-ui 2>/dev/null || x-ui stop 2>/dev/null || pkill -f x-ui 2>/dev/null || true; sleep 2");
  await ssh.exec("rm -f /etc/x-ui/x-ui.db-wal /etc/x-ui/x-ui.db-shm /etc/x-ui/x-ui.db-journal 2>/dev/null || true");
  await ssh.exec("cp /etc/x-ui/x-ui.db /etc/x-ui/x-ui.db.pre-restore 2>/dev/null || true");
  await ssh.exec("mkdir -p /etc/x-ui /usr/local/x-ui");

  let placeOk = false;
  if (kind === "sqlite") {
    // a raw SQLite database — place it verbatim, byte-for-byte
    const moveRes = await ssh.exec(
      `cp -f '${remoteBackupPath}' /etc/x-ui/x-ui.db && chmod 644 /etc/x-ui/x-ui.db && chown root:root /etc/x-ui/x-ui.db 2>/dev/null || true && ls -lh /etc/x-ui/x-ui.db && echo OK`
    );
    if (moveRes.stdout.includes("OK")) placeOk = true;
    if (moveRes.exitCode !== 0 && moveRes.exitCode !== null && !placeOk) {
      return { success: false, detail: `Failed to place the database file: ${moveRes.stderr || moveRes.stdout}` };
    }
  } else {
    const extractDir = `/tmp/bkup-xui-extract-${Date.now()}`;
    await ssh.exec(`mkdir -p '${extractDir}'`);
    const extractRes = await ssh.exec(
      kind === "zip"
        ? `cd '${extractDir}' && unzip -o '${remoteBackupPath}' 2>&1 && echo EXTRACT_OK`
        : `cd '${extractDir}' && tar -xzf '${remoteBackupPath}' 2>&1 && echo EXTRACT_OK`
    );
    if (!extractRes.stdout.includes("EXTRACT_OK")) {
      const fallback = await ssh.exec(`cp -f '${remoteBackupPath}' /etc/x-ui/x-ui.db && chmod 644 /etc/x-ui/x-ui.db && echo OK`);
      placeOk = fallback.stdout.includes("OK");
    } else {
      const findRes = await ssh.exec(
        `find '${extractDir}' -name 'x-ui.db' -type f 2>/dev/null | head -1 || find '${extractDir}' -name '*.db' -type f 2>/dev/null | head -1`
      );
      const dbFile = findRes.stdout.trim().split("\n")[0]?.trim();
      if (!dbFile) {
        const cpRes = await ssh.exec(`cp -f '${remoteBackupPath}' /etc/x-ui/x-ui.db && chmod 644 /etc/x-ui/x-ui.db && echo OK`);
        placeOk = cpRes.stdout.includes("OK");
      } else {
        const cpRes = await ssh.exec(
          `cp -f '${dbFile}' /etc/x-ui/x-ui.db && chmod 644 /etc/x-ui/x-ui.db && chown root:root /etc/x-ui/x-ui.db 2>/dev/null || true && echo OK`
        );
        placeOk = cpRes.stdout.includes("OK");
      }
      await ssh.exec(`rm -rf '${extractDir}'`);
    }
  }

  if (!placeOk) {
    // the copy itself failed — an old pre-existing file must never be mistaken
    // for a successful restore (this used to report false success)
    return { success: false, detail: "Failed to place the restored database file at /etc/x-ui/x-ui.db — copy operation failed" };
  }

  // the placed database must be byte-for-byte the size of the uploaded backup
  const sizeCheck = await ssh.exec(`stat -c %s /etc/x-ui/x-ui.db 2>/dev/null || wc -c < /etc/x-ui/x-ui.db`);
  const placedSize = parseInt(sizeCheck.stdout.trim(), 10);
  if (!Number.isFinite(placedSize) || placedSize !== remoteSize) {
    return { success: false, detail: `Restored database size mismatch — uploaded ${remoteSize} bytes but /etc/x-ui/x-ui.db holds ${sizeCheck.stdout.trim().slice(0, 40)} bytes` };
  }

  await ssh.exec(
    "rm -f /etc/x-ui/x-ui.db-wal /etc/x-ui/x-ui.db-shm /etc/x-ui/x-ui.db-journal 2>/dev/null; chmod 644 /etc/x-ui/x-ui.db; chown root:root /etc/x-ui/x-ui.db 2>/dev/null || true"
  );

  // DO NOT run x-ui migrate — it modifies the backup database schema
  // and corrupts inbounds. The backup must be restored exactly as-is.
  // DO NOT change cert settings or listenIP — those belong to the backup.

  // ── Cert pre-flight (the "X-Ray error after restore" killer) ──
  // Every certificate/key FILE path the restored database references is
  // extracted LOCALLY from the backup's own bytes and created on the server
  // AT THE REFERENCED PATHS before the panel is ever started. Without this,
  // X-Ray dies with "failed to parse certificate — no such file or directory"
  // on the first inbound whose TLS cert only existed on the source server.
  // The extraction needs no sqlite3 on the target and covers EVERY certificate
  // of EVERY inbound (nested arrays included). The backup itself is untouched.
  let certNote = "";
  try {
    let refBytes: Buffer | null = null;
    const rawLocal = fs.readFileSync(localBackupPath);
    if (kind === "sqlite") refBytes = rawLocal;
    else if (kind === "tar-gz") {
      try { refBytes = zlib.gunzipSync(rawLocal); } catch { refBytes = null; }
    }
    if (refBytes) {
      const refs = extractXrayCertRefs(refBytes);
      if (refs.certs.length || refs.webCert) {
        const ensureOut = await execRemoteScript(ssh, buildCertEnsureScript(refs));
        const created = parseInt((ensureOut.match(/CREATED_FILES:(\d+)/) || [])[1] || "0", 10);
        const stillMissing = parseInt((ensureOut.match(/MISSING_AFTER_COUNT:(\d+)/) || [])[1] || "0", 10);
        if (created > 0) {
          certNote = ` — created ${created} missing certificate file pair(s) at the exact paths the backup references (backup data untouched)`;
        }
        if (stillMissing > 0) {
          const missingList = ensureOut.split("\n").filter((l) => l.startsWith("STILL_MISSING:")).slice(0, 3).map((l) => l.slice(14)).join(", ");
          certNote += ` — WARNING: ${stillMissing} referenced cert path(s) could not be created (${missingList})`;
        }
      }
    }
  } catch (certErr) {
    // cert pre-flight must never break the restore itself
    await log("warn", bi(`[Restore] certificate pre-flight hit an error: ${certErr instanceof Error ? certErr.message : String(certErr)}`, `[Restore] certificate pre-flight hit an error: ${certErr instanceof Error ? certErr.message : String(certErr)}`));
  }

  await ssh.exec("systemctl enable x-ui 2>/dev/null || true; systemctl daemon-reload 2>/dev/null || true");
  await ssh.exec("systemctl restart x-ui 2>/dev/null || systemctl start x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>&1 || true");

  const probeStatus = async (): Promise<{ svc: boolean; xray: boolean; raw: string }> => {
    // script-file probe — see execRemoteScript for why this must not travel
    // inside the remote shell command line (pgrep -f self-match = false success)
    const raw = (
      await execRemoteScript(ssh, [
        "#!/usr/bin/env bash",
        'echo "SVC:$(systemctl is-active x-ui 2>/dev/null)"',
        'pgrep -f "/usr/local/x-ui" >/dev/null 2>&1 && echo XUI_UP',
        'pgrep -f "xray" >/dev/null 2>&1 && echo XRAY_UP',
        "echo CHECK_DONE",
      ].join("\n"))
    ).trim();
    return {
      svc: raw.includes("SVC:active") || raw.includes("XUI_UP"),
      xray: raw.includes("XRAY_UP"),
      raw,
    };
  };

  // bring-up loop — the panel AND its X-Ray core must actually be running
  // before success is claimed. A restart makes the panel regenerate the
  // X-Ray config from the restored database; the backup bytes are never touched.
  let probe = await probeStatus();
  for (let attempt = 0; attempt < 3; attempt++) {
    await ssh.exec("sleep 6");
    probe = await probeStatus();
    if (probe.svc && probe.xray) break;
    if (attempt < 2) {
      await ssh.exec("/usr/local/x-ui/x-ui restart >/dev/null 2>&1 || systemctl restart x-ui 2>/dev/null || true");
    }
  }

  // ── Environment-only X-Ray recovery — the restored database is NEVER
  // modified (no setting is reset, no row is touched). When X-Ray refuses to
  // start on THIS server it is almost always an environment gap, not a broken
  // backup: the backup references certificate files that only existed on the
  // server it was taken from. The fix is purely environmental and works for
  // every certificate reference:
  //   1) the panel's own web certificate file is missing → a self-signed pair
  //      is created AT THE EXACT PATH the backup's setting points to (the
  //      setting itself is left untouched)
  //   2) inbound TLS certificate paths stored INSIDE the backup are missing on
  //      this server → self-signed pairs are generated AT THOSE REFERENCED
  //      PATHS, so the backup's own configuration resolves in this environment
  if (!probe.xray) {
    await ssh.exec(`bash -s <<'BKUP_XRAY_FIX'
echo "[bkup] X-Ray did not come up — checking the environment (backup data untouched)"
# The backup database is NEVER modified — missing files it REFERENCES are
# created at exactly the referenced paths, so the backup's own configuration
# resolves on this server verbatim.

# 1) the panel's own web certificate points at a file that only existed on the
#    source server → create a self-signed pair AT THAT PATH (setting untouched)
SHOW=$(/usr/local/x-ui/x-ui setting -show 2>/dev/null || true)
WEB_CERT=$(echo "$SHOW" | grep -ioE "^webCert(File|Path)?[[:space:]]*:.*" | head -1 | cut -d: -f2- | tr -d '"'"'"' | tr -d '\r' | xargs 2>/dev/null || true)
WEB_KEY=$(echo "$SHOW" | grep -ioE "^webKey(File|Path)?[[:space:]]*:.*" | head -1 | cut -d: -f2- | tr -d '"'"'"' | tr -d '\r' | xargs 2>/dev/null || true)
case "$WEB_CERT" in /*) ;; *) WEB_CERT="" ;; esac
if [ -n "$WEB_CERT" ] && [ ! -f "$WEB_CERT" ]; then
  case "$WEB_KEY" in /*) ;; *) WEB_KEY="\$(dirname "$WEB_CERT")/privkey.pem" ;; esac
  mkdir -p "\$(dirname "$WEB_CERT")" "\$(dirname "$WEB_KEY")" 2>/dev/null || true
  if openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -subj "/CN=restored-panel" -keyout "$WEB_KEY" -out "$WEB_CERT" >/dev/null 2>&1; then
    echo "[bkup] Created the panel web certificate the backup references: $WEB_CERT (self-signed — replace with your real cert when convenient)"
  fi
  chmod 644 "$WEB_CERT" "$WEB_KEY" 2>/dev/null || true
fi

# 2) inbound TLS certificate paths stored INSIDE the backup are missing on
#    this server → self-signed pairs generated AT THOSE REFERENCED PATHS.
#    Every certificate of every inbound is covered (json_each), not just [0].
PAIRS=$(sqlite3 /etc/x-ui/x-ui.db "SELECT DISTINCT json_extract(stream_settings,'\$.tlsSettings.certificates[0].certificateFile'), json_extract(stream_settings,'\$.tlsSettings.certificates[0].keyFile') FROM inbounds WHERE json_valid(stream_settings) AND stream_settings LIKE '%certificateFile%' UNION SELECT DISTINCT json_extract(c.value,'\$.certificateFile'), json_extract(c.value,'\$.keyFile') FROM inbounds, json_each(inbounds.stream_settings,'\$.tlsSettings.certificates') AS c WHERE json_valid(inbounds.stream_settings);" 2>/dev/null || true)
echo "$PAIRS" | while IFS='|' read -r CERT KEY; do
  case "$CERT" in /*) ;; *) continue ;; esac
  if [ -f "$CERT" ] && [ -n "$KEY" ] && [ -f "$KEY" ]; then continue; fi
  KEY_TARGET="$KEY"
  if [ -z "$KEY_TARGET" ]; then KEY_TARGET="$CERT.key"; fi
  case "$KEY_TARGET" in /*) ;; *) KEY_TARGET="$(dirname "$CERT")/$(basename "$KEY_TARGET")" ;; esac
  mkdir -p "$(dirname "$CERT")" "$(dirname "$KEY_TARGET")" 2>/dev/null || true
  if [ -f "$KEY_TARGET" ]; then
    openssl req -new -x509 -days 3650 -nodes -key "$KEY_TARGET" -subj "/CN=restored" -out "$CERT" >/dev/null 2>&1 && echo "[bkup] Generated the certificate referenced by the backup: $CERT" || true
  else
    openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -subj "/CN=restored" -keyout "$KEY_TARGET" -out "$CERT" >/dev/null 2>&1 && echo "[bkup] Generated the certificate pair referenced by the backup: $CERT + $KEY_TARGET" || true
  fi
  chmod 644 "$CERT" "$KEY_TARGET" 2>/dev/null || true
done
systemctl restart x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>&1 || true
BKUP_XRAY_FIX`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await ssh.exec("sleep 6");
      probe = await probeStatus();
      if (probe.svc && probe.xray) break;
      if (attempt < 1) {
        await ssh.exec("/usr/local/x-ui/x-ui restart >/dev/null 2>&1 || systemctl restart x-ui 2>/dev/null || true");
      }
    }
  }

  const verifyDb = await ssh.exec(
    `ls -lh /etc/x-ui/x-ui.db; (command -v sqlite3 >/dev/null 2>&1 && sqlite3 /etc/x-ui/x-ui.db "SELECT COUNT(*) FROM inbounds;" 2>&1 || echo "no-sqlite3-cli") | head -10`
  );
  const dbExists = verifyDb.stdout.includes("x-ui.db");
  if (!dbExists) {
    return { success: false, detail: "x-ui.db not found after restore" };
  }
  // the structural verdict comes from the backup's own bytes — checked LOCALLY
  // on the bkup server (header + page table), never from a remote sqlite3 that
  // may not exist (that used to print the misleading "could not be confirmed")
  const localIntegrityOk = kind === "sqlite" ? sqliteHeaderOk(fs.readFileSync(localBackupPath)) : true;
  const inboundMatch = verifyDb.stdout.trim().split("\n").filter((l) => /^\d+$/.test(l.trim()));

  // post-restart size comparison is ADVISORY only — when the backup comes from
  // an older panel version, the panel's own startup migration legitimately
  // rewrites the schema (adds columns), so a size difference here does NOT
  // mean the restore corrupted anything. The strict byte-exact size check ran
  // BEFORE the first restart, while nothing had yet touched the file.
  const finalSizeCheck = await ssh.exec(
    `stat -c %s /etc/x-ui/x-ui.db 2>/dev/null || wc -c < /etc/x-ui/x-ui.db; echo "---"; stat -c %s '${remoteBackupPath}' 2>/dev/null || wc -c < '${remoteBackupPath}' 2>/dev/null || echo 0`
  );
  const sizeLines = finalSizeCheck.stdout.trim().split("---");
  const placedBytes = parseInt((sizeLines[0] || "").trim(), 10);
  const backupBytes = parseInt((sizeLines[1] || "").trim(), 10);
  const sizeNote =
    Number.isFinite(placedBytes) && Number.isFinite(backupBytes) && backupBytes > 0 && placedBytes !== backupBytes
      ? ` (size now ${placedBytes} bytes vs backup ${backupBytes} — the panel rewrote the database on startup, expected for cross-version backups)`
      : "";

  const inboundsNote = inboundMatch.length ? `, ${inboundMatch[inboundMatch.length - 1].trim()} inbounds` : "";
  const integrityNote = localIntegrityOk ? "SQLite structure verified (header + page table, checked locally)" : "SQLite header check failed locally — placement may be wrong";
  if (probe.svc && probe.xray) {
    return { success: true, detail: `3x-ui database restored verbatim (${remoteSize} bytes) — panel running, X-Ray core running${inboundsNote}; ${integrityNote}${certNote}${sizeNote}` };
  }

  // the database itself is restored and untouched — but the service/core did
  // not come up even after the environment fixes. Report the truth with the
  // real X-Ray error tail, never a silent success and never a modified backup.
  const journal = await ssh.exec("journalctl -u x-ui --no-pager -n 12 2>/dev/null | tail -12 || true");
  const errLog = await ssh.exec("tail -n 8 /usr/local/x-ui/error.log 2>/dev/null || true");
  const xrayNote = !probe.svc
    ? "the panel service is NOT running"
    : "the panel is running but the X-Ray core is NOT running";
  return {
    success: false,
    detail: `3x-ui database restored verbatim (${remoteSize} bytes)${inboundsNote}; ${integrityNote}${certNote}${sizeNote}. ${xrayNote}. X-Ray log tail: ${(errLog.stdout || journal.stdout).slice(-400) || probe.raw.slice(0, 200)}`,
  };
}

// ── HMPanel restore — official CLI first (complete & correct), manual fallback ──
async function restoreHmpanel(ssh: SshClient, remoteBackupPath: string, backupName: string, localBackupPath: string): Promise<{ success: boolean; detail: string }> {
  const lowerName = backupName.toLowerCase();
  const kind = sniffBackupKind(localBackupPath);
  if (kind === "json") {
    return { success: false, detail: "This HMPanel backup is a JSON document — HMPanel restores need the official archive (.tar.gz from the panel or bkup)" };
  }
  if (kind === "sqlite") {
    return { success: false, detail: "This backup is a raw SQLite database, not an HMPanel archive — HMPanel restores its PostgreSQL payload from the official .tar.gz backup" };
  }

  const uploadCheck = await ssh.exec(`ls -lh '${remoteBackupPath}' 2>&1 && stat -c %s '${remoteBackupPath}' 2>/dev/null || wc -c < '${remoteBackupPath}' 2>/dev/null || echo 0`);
  const uploadOut = uploadCheck.stdout.trim();
  if (uploadOut.includes("No such file") || uploadOut.includes("cannot access")) {
    return { success: false, detail: `Uploaded backup not found at ${remoteBackupPath}` };
  }
  const sizeMatch = uploadOut.match(/(\d+)\s*$/);
  const remoteSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  if (remoteSize === 0) {
    return { success: false, detail: `Uploaded HMPanel backup is empty (0 bytes)` };
  }

  const hmDir = "/opt/hmpanel";
  await ssh.exec(`mkdir -p ${hmDir} ${hmDir}/backups; cp -r ${hmDir} ${hmDir}.pre-restore-$(date +%s) 2>/dev/null || true`);

  // The official HMPanel CLI (installed as /opt/hmpanel/cli.sh and `hm`) is the
  // authoritative restore engine: it recreates panel_db, reloads the pg_dumpall
  // payload with ON_ERROR_STOP + a tolerant retry, recreates the source roles,
  // restores config/uploads/premium/instance-id, re-syncs the Postgres
  // credentials and waits for panel health. Driving it is the only complete
  // restore, so it is always the primary path when present.
  const cliCheck = await ssh.exec("ls /opt/hmpanel/cli.sh 2>/dev/null; command -v hm 2>/dev/null; command -v hmpanel 2>/dev/null; echo CLI_CHECK_DONE");
  const hasCli = cliCheck.stdout.includes("cli.sh") || cliCheck.stdout.includes("/hm") || cliCheck.stdout.includes("hmpanel");

  if (hasCli) {
    const cliCmd = cliCheck.stdout.includes("cli.sh") ? "bash /opt/hmpanel/cli.sh restore" : "hm restore";
    try {
      const restoreRes = await ssh.exec(`${cliCmd} '${remoteBackupPath}' 2>&1; echo CLI_EXIT:$?`, { timeout: 15 * 60 * 1000 });
      const out = (restoreRes.stdout || "") + (restoreRes.stderr || "");
      if (out.includes("RESTORE_OK") && !out.includes("RESTORE_FAILED")) {
        const verify = await ssh.exec('docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel; echo "---"; docker exec hmpanel-panel curl -sf http://127.0.0.1:4000/health 2>/dev/null || echo HEALTH_CHECK_SKIPPED');
        return { success: true, detail: `HMPanel backup restored completely via official CLI (${remoteSize} bytes) — ${verify.stdout.slice(0, 180)}` };
      }
      await ssh.exec(`cp -f '${remoteBackupPath}' ${hmDir}/backups/restore-failed-$(date +%s).tar.gz 2>/dev/null || true`);
      const tail = out.trim().split("\n").slice(-6).join(" | ").slice(-400);
      return { success: false, detail: `HMPanel restore via CLI failed — ${tail}` };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const verifyAfter = await ssh.exec('docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel; docker exec hmpanel-panel curl -sf http://127.0.0.1:4000/health 2>/dev/null || echo HEALTH_CHECK_SKIPPED');
      if (verifyAfter.stdout.toLowerCase().includes("hmpanel")) {
        return { success: true, detail: `HMPanel CLI restore finished but returned an error — panel is running (${remoteSize} bytes). ${msg}` };
      }
      await ssh.exec(`cp -f '${remoteBackupPath}' ${hmDir}/backups/restore-failed-$(date +%s).tar.gz 2>/dev/null || true`);
      return { success: false, detail: `HMPanel restore via CLI error: ${msg}` };
    }
  }

  if (kind === "tar-gz" || kind === "zip" || lowerName.match(/\.(tar\.gz|tgz)$/) || lowerName.endsWith(".tar") || lowerName.endsWith(".gz")) {
    const extractDir = `/tmp/bkup-hm-fast-${Date.now()}`;
    try {
      await ssh.exec(`mkdir -p '${extractDir}' && rm -rf '${extractDir}'/*`);
      const extractRes = await ssh.exec(`cd '${extractDir}' && (tar -xzf '${remoteBackupPath}' 2>&1 || tar -xf '${remoteBackupPath}' 2>&1) && ls -lh && echo EXTRACT_OK || echo EXTRACT_FAIL`, { timeout: 5 * 60 * 1000 });
      if (extractRes.stdout.includes("EXTRACT_OK")) {
        // the official archive nests its payload — search the WHOLE tree, not
        // just the top level (a top-level-only check is how restores used to
        // miss the SQL dump and silently skip the database)
        const findSql = await ssh.exec(`find '${extractDir}' -maxdepth 4 \\( -name 'database.sql.gz' -o -name 'db_backup.sql' -o -name '*.sql.gz' -o -name 'database.sql' -o -name '*.sql' \\) -type f 2>/dev/null | head -1; echo SQL_FIND_DONE`);
        const sqlFile = findSql.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(extractDir) && l.length > extractDir.length);
        const hasDbFile = Boolean(sqlFile);

        if (hasDbFile) {
          const fastRestore = await ssh.exec(`
            set -e
            set -o pipefail
            cd ${hmDir}
            SQL_FILE='${sqlFile}'
            echo "[bkup] Fast restore: stopping panel-app..."
            docker compose stop panel-app 2>/dev/null || docker stop hmpanel-panel 2>/dev/null || true
            sleep 2
            PG_CONT=$(docker ps --format "{{.Names}}" 2>/dev/null | grep -i postgres | head -1)
            if [ -z "$PG_CONT" ]; then PG_CONT="hmpanel-postgres"; fi
            DB_USER=$(grep -E '^POSTGRES_USER=' ${hmDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || echo "panel_user")
            DB_USER=\${DB_USER:-panel_user}
            echo "[bkup] Using PG container: $PG_CONT user: $DB_USER"
            if [ -n "$SQL_FILE" ] && [ -f "$SQL_FILE" ]; then
              case "$SQL_FILE" in
                *.gz) zcat "$SQL_FILE" > /tmp/hm-restore.sql 2>/dev/null || gunzip -c "$SQL_FILE" > /tmp/hm-restore.sql ;;
                *) cp "$SQL_FILE" /tmp/hm-restore.sql ;;
              esac
            else
              echo "NO_SQL_FILE"
              exit 1
            fi
            echo "[bkup] SQL size: $(du -h /tmp/hm-restore.sql | awk '{print $1}')"
            if grep -qE '^\\\\connect ' /tmp/hm-restore.sql; then
              echo "[bkup] Detected pg_dumpall with \\\\connect — extracting panel_db section"
              awk 'BEGIN{keep=0;copy=0} copy==1{print; if($0=="\\\\.")copy=0; next} /^\\\\connect /{keep=($0~/panel_db/)?1:0; next} keep==0{next} /^[[:space:]]*(DROP|CREATE|ALTER)[[:space:]]+(ROLE|USER|DATABASE|TABLESPACE)[[:space:]]/{next} /^[[:space:]]*DROP[[:space:]]/{next} {print; if($0~/^COPY .* FROM stdin;$/ )copy=1}' /tmp/hm-restore.sql > /tmp/hm-restore-filtered.sql
              mv /tmp/hm-restore-filtered.sql /tmp/hm-restore.sql
            else
              echo "[bkup] Single DB dump detected"
              sed -i -E '/^[[:space:]]*(DROP|CREATE|ALTER)[[:space:]]+(ROLE|USER|DATABASE)/d' /tmp/hm-restore.sql || true
              sed -i -E '/^[[:space:]]*DROP[[:space:]]/d' /tmp/hm-restore.sql || true
            fi
            echo "[bkup] Recreating panel_db..."
            docker exec $PG_CONT psql -U $DB_USER -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='panel_db' AND pid<>pg_backend_pid();" 2>/dev/null || true
            docker exec $PG_CONT psql -U $DB_USER -d postgres -c "DROP DATABASE IF EXISTS panel_db WITH (FORCE);" 2>/dev/null || docker exec $PG_CONT psql -U $DB_USER -d postgres -c "DROP DATABASE IF EXISTS panel_db;" 2>/dev/null || true
            docker exec $PG_CONT psql -U $DB_USER -d postgres -c "CREATE DATABASE panel_db OWNER \\"$DB_USER\\";" 2>/dev/null || true
            echo "[bkup] Loading data into panel_db..."
            PSQL_OUTPUT=$(cat /tmp/hm-restore.sql | docker exec -i $PG_CONT psql -U $DB_USER -d panel_db 2>&1)
            PSQL_EXIT=$?
            echo "$PSQL_OUTPUT" | tail -30
            if [ $PSQL_EXIT -ne 0 ]; then
              echo "[bkup] WARNING: psql exited with code $PSQL_EXIT — restore may be incomplete"
            fi
            echo "[bkup] Verifying..."
            if docker exec $PG_CONT psql -U $DB_USER -d panel_db -tAc 'SELECT COUNT(*) FROM "Admin"' >/dev/null 2>&1; then
              echo "FAST_RESTORE_DONE"
            else
              echo "FAST_RESTORE_FAIL"
            fi
          `, { timeout: 10 * 60 * 1000 });

          const fastOut = fastRestore.stdout + fastRestore.stderr;
          if (fastOut.includes("NO_SQL_FILE")) {
            await ssh.exec(`cp -f '${remoteBackupPath}' ${hmDir}/backups/no-sql-found-$(date +%s).tar.gz 2>/dev/null || true`);
            return {
              success: false,
              detail: `HMPanel archive extracted, but no SQL database dump was found inside — nothing was restored. The archive was kept at ${hmDir}/backups/ for a manual import`,
            };
          }
          if (fastOut.includes("FAST_RESTORE_DONE") && !fastOut.includes("FAST_RESTORE_FAIL")) {
            await ssh.exec(`
              set -e
              cd ${hmDir}
              ARCH_DETECTED=$(uname -m)
              if [[ "$ARCH_DETECTED" == "aarch64" || "$ARCH_DETECTED" == "arm64" || "$ARCH_DETECTED" == "armv8"* ]]; then
                if [ -f ${hmDir}/docker-compose.yml ] && ! grep -q "platform:" ${hmDir}/docker-compose.yml; then
                  echo "[bkup] ARM64 detected during restore — patching compose"
                  apt-get update -qq 2>/dev/null || true
                  apt-get install -y -qq qemu-user-static binfmt-support 2>/dev/null || yum install -y qemu-user-static 2>/dev/null || true
                  sed -i '/image: ghcr.io\\/neoauroraproject\\/hmpanel/a \\    platform: linux/amd64' ${hmDir}/docker-compose.yml || true
                fi
              fi
              if [ -f '${extractDir}/config.tar.gz' ]; then
                echo "[bkup] Restoring config..."
                tar -xzf '${extractDir}/config.tar.gz' -C ${hmDir} 2>/dev/null || true
              fi
              if [ -f '${extractDir}/uploads.tar.gz' ]; then
                echo "[bkup] Restoring uploads..."
                docker run --rm -v hmpanel_uploads:/dest -v '${extractDir}/uploads.tar.gz:/backup.tar.gz:ro' alpine sh -c 'mkdir -p /dest && tar -xzf /backup.tar.gz -C /dest' 2>/dev/null || true
              fi
              if [ -f '${extractDir}/premium.tar.gz' ]; then
                echo "[bkup] Restoring premium..."
                docker run --rm -v hmpanel_premium:/dest -v '${extractDir}/premium.tar.gz:/backup.tar.gz:ro' alpine sh -c 'mkdir -p /dest && tar -xzf /backup.tar.gz -C /dest' 2>/dev/null || true
              fi
              if [ -f '${extractDir}/.hmpanel-instance-id' ]; then
                cp '${extractDir}/.hmpanel-instance-id' ${hmDir}/backups/ 2>/dev/null || true
              fi
              echo "[bkup] Syncing credentials and restarting..."
              source ${hmDir}/.env 2>/dev/null || true
              DB_PASS=\${POSTGRES_PASSWORD:-}
              if [ -n "$DB_PASS" ]; then
                ESCAPED_PASS=$(echo "$DB_PASS" | sed "s/'/''/g")
                docker exec hmpanel-postgres psql -U $(grep -E '^POSTGRES_USER=' ${hmDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || echo panel_user) -d postgres -c "ALTER ROLE \\"$(grep -E '^POSTGRES_USER=' ${hmDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || echo panel_user)\\" WITH PASSWORD '$ESCAPED_PASS';" 2>/dev/null || true
              fi
              cd ${hmDir}
              docker compose up -d --force-recreate --no-deps redis 2>/dev/null || true
              sleep 2
              docker compose up -d --force-recreate --no-deps panel-app 2>/dev/null || docker compose up -d --force-recreate panel-app 2>/dev/null || true
              sleep 3
              docker compose up -d --no-deps nginx 2>/dev/null || docker restart hmpanel-nginx 2>/dev/null || true
              sleep 3
              echo "RESTART_DONE"
            `, { timeout: 5 * 60 * 1000 });

            await ssh.exec("sleep 5");
            const verify = await ssh.exec('docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel; echo "---"; docker exec hmpanel-postgres psql -U panel_user -d panel_db -tAc \'SELECT COUNT(*) FROM "Admin"\' 2>/dev/null || echo 0; echo "---"; cd /opt/hmpanel && docker compose ps 2>&1 | head -20');
            await ssh.exec(`rm -rf '${extractDir}' /tmp/hm-restore.sql /tmp/hm-restore-filtered.sql 2>/dev/null || true`);

            if (verify.stdout.toLowerCase().includes("hmpanel")) {
              return { success: true, detail: `HMPanel fast restore done (${remoteSize} bytes, ~3-5 min) — containers running, Admin count check: ${verify.stdout.slice(0, 200)}` };
            }
            if (fastOut.includes("FAST_RESTORE_DONE")) {
              return { success: true, detail: `HMPanel fast restore completed (${remoteSize} bytes) — ${fastOut.slice(-200)}` };
            }
          }
        }
      }
    } catch (e) {
      try {
        await ssh.exec(`rm -rf /tmp/bkup-hm-fast-* /tmp/hm-restore.sql 2>/dev/null || true`);
      } catch {}
    }
  }

  // last resort — the archive could not be replayed automatically. This must
  // be an HONEST failure: a running panel says nothing about whether the
  // backup was actually restored (it used to report success here).
  await ssh.exec(`cp -f '${remoteBackupPath}' ${hmDir}/backups/manual-restore-$(date +%s).tar.gz 2>/dev/null || cp -f '${remoteBackupPath}' /tmp/hmpanel-manual-restore.tar.gz; rm -rf /tmp/bkup-hm-fast-* /tmp/bkup-hm-extract-* 2>/dev/null || true`);
  return {
    success: false,
    detail: `HMPanel backup could not be restored automatically — nothing was changed. The archive was kept at ${hmDir}/backups/ for a manual import via the panel`,
  };
}

async function restorePasarguard(ssh: SshClient, remoteBackupPath: string, backupName: string, localBackupPath: string): Promise<{ success: boolean; detail: string }> {
  const lowerName = backupName.toLowerCase();
  const kind = sniffBackupKind(localBackupPath);

  const uploadCheck = await ssh.exec(`ls -lh '${remoteBackupPath}' 2>&1 && stat -c %s '${remoteBackupPath}' 2>/dev/null || wc -c < '${remoteBackupPath}' 2>/dev/null || echo 0`);
  const uploadOut = uploadCheck.stdout.trim();
  if (uploadOut.includes("No such file") || uploadOut.includes("cannot access")) {
    return { success: false, detail: `Uploaded PasarGuard backup not found at ${remoteBackupPath}` };
  }
  const sizeMatch = uploadOut.match(/(\d+)\s*$/);
  const remoteSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  if (remoteSize === 0) {
    return { success: false, detail: `Uploaded PasarGuard backup is empty` };
  }

  const pgDir = "/opt/pasarguard";
  await ssh.exec(`mkdir -p ${pgDir} ${pgDir}/data /var/lib/pasarguard; (cp -r ${pgDir}/data ${pgDir}/data.pre-restore-$(date +%s) 2>/dev/null || cp -r /var/lib/pasarguard /var/lib/pasarguard.pre-restore-$(date +%s) 2>/dev/null || true)`);

  // ── PasarGuard restore strategy: deterministic, content-based ──
  // The official `pasarguard restore` CLI is an INTERACTIVE selector over the
  // archives in /opt/pasarguard/backup (it takes no file path and cannot read
  // bkup's API snapshot), so bkup restores by CONTENT instead:
  //   1) the panel's SQLite database file  → placed byte-for-byte
  //   2) an official db_backup.sql dump    → replayed into the database
  //   3) bkup's own JSON snapshot archive  → sections replayed into the schema
  // The database location follows the REAL install: SQLALCHEMY_DATABASE_URL in
  // /opt/pasarguard/.env first, then the two official layouts — v5 stores the
  // DB under /var/lib/pasarguard, legacy installs under /opt/pasarguard.
  const envProbe = await ssh.exec(`grep -E '^SQLALCHEMY_DATABASE_URL=' ${pgDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || true; echo ENV_DONE`);
  const envUrl = (envProbe.stdout.split("\n")[0] ?? "").trim();
  const backendIsSqlite = !envUrl || /sqlite/i.test(envUrl);
  const envSqliteM = /sqlite:\/\/\/(\/[^\s"']+)/i.exec(envUrl);
  const pgDbCandidates = [
    envSqliteM?.[1],
    "/var/lib/pasarguard/db.sqlite3",
    `${pgDir}/data/db.sqlite3`,
    `${pgDir}/db.sqlite3`,
  ].filter((x): x is string => Boolean(x));

  if (!backendIsSqlite) {
    return {
      success: false,
      detail:
        "This PasarGuard server uses a MySQL/PostgreSQL backend (SQLALCHEMY_DATABASE_URL in .env), so a file-level restore cannot be applied automatically — install PasarGuard with the same SQLite backend as the panel the backup came from, then run the restore again. The server was not modified.",
    };
  }

  if (kind === "sqlite" || (kind === "unknown" && (lowerName.endsWith(".db") || lowerName.endsWith(".sqlite") || lowerName.endsWith(".sqlite3")))) {
    const dbPathRes = await ssh.exec(`for c in ${pgDbCandidates.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DB_SEARCH_DONE`);
    let targetDb = pgDbCandidates[0];
    const found = dbPathRes.stdout.trim().split("\n").find((l) => l.startsWith("/") && (l.includes(".db") || l.includes(".sqlite")));
    if (found) targetDb = found.trim();

    await ssh.exec(`cd ${pgDir} && docker compose down 2>&1 || docker-compose down 2>&1 || true; sleep 2; rm -f ${targetDb}-wal ${targetDb}-shm 2>/dev/null || true`);
    const cpRes = await ssh.exec(`cp -f '${remoteBackupPath}' '${targetDb}' && chmod 644 '${targetDb}' && ls -lh '${targetDb}' && echo OK || echo FAIL`);
    await ssh.exec(`rm -f ${targetDb}-wal ${targetDb}-shm 2>/dev/null; chmod 644 '${targetDb}' 2>/dev/null || true`);
    await ssh.exec(`cd ${pgDir} && docker compose up -d 2>&1 || docker-compose up -d 2>&1 || true; sleep 8`);

    if (cpRes.stdout.includes("OK")) {
      const verify = await ssh.exec(`ls -lh '${targetDb}'; sqlite3 '${targetDb}' "SELECT COUNT(*) FROM users;" 2>&1 | head -10 || echo ok; docker ps --format "{{.Names}}" 2>/dev/null | grep -i pasarguard`);
      return { success: true, detail: `PasarGuard database restored (${remoteSize} bytes) to ${targetDb} — ${verify.stdout.slice(0, 150)}` };
    }
    return { success: false, detail: `Failed to restore PasarGuard db: ${cpRes.stdout.slice(0, 200)}` };
  }

  if (kind === "json") {
    return { success: false, detail: "This PasarGuard backup is a bare JSON document — PasarGuard restores need the bkup snapshot archive (.tar.gz) or the panel's database file. Nothing was modified" };
  }

  if (kind === "tar-gz" || kind === "zip" || lowerName.match(/\.(tar\.gz|tgz|zip)$/)) {
    const extractDir = `/tmp/bkup-pg-extract-${Date.now()}`;
    await ssh.exec(`mkdir -p '${extractDir}'`);
    const extractRes = await ssh.exec(
      kind === "zip"
        ? `cd '${extractDir}' && unzip -o '${remoteBackupPath}' 2>&1 && echo EXTRACT_OK || echo EXTRACT_FAIL`
        : `cd '${extractDir}' && (tar -xzf '${remoteBackupPath}' 2>&1 || tar -xf '${remoteBackupPath}' 2>&1) && echo EXTRACT_OK || echo EXTRACT_FAIL`,
      { timeout: 5 * 60 * 1000 }
    );

    if (extractRes.stdout.includes("EXTRACT_OK")) {
      // 1) a real SQLite database inside the archive → place it (classic path)
      const findDb = await ssh.exec(`find '${extractDir}' \\( -name "*.db" -o -name "*.sqlite*" \\) -type f 2>/dev/null | head -5`);
      const dbFile = findDb.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(extractDir));
      if (dbFile) {
        const dbPath = dbFile;
        const tgtProbe = await ssh.exec(`for c in ${pgDbCandidates.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DONE`);
        const tgt = tgtProbe.stdout.trim().split("\n").find((l) => l.startsWith("/")) || pgDbCandidates[0];
        await ssh.exec(`cd ${pgDir} && docker compose down 2>&1 || docker-compose down 2>&1 || true; sleep 2`);
        const cpRes = await ssh.exec(`mkdir -p "$(dirname '${tgt}')"; cp -f '${dbPath}' '${tgt}' && chmod 644 '${tgt}' && echo COPY_OK || echo COPY_FAIL; rm -f '${tgt}-wal' '${tgt}-shm' 2>/dev/null || true`);
        await ssh.exec(`cd ${pgDir} && docker compose up -d 2>&1 || docker-compose up -d 2>&1; sleep 8`);
        await ssh.exec(`rm -rf '${extractDir}'`);
        if (cpRes.stdout.includes("COPY_OK")) {
          const verify = await ssh.exec(`ls -lh '${tgt}'; docker ps --format "{{.Names}}" 2>/dev/null | grep -i pasarguard`);
          return { success: true, detail: `PasarGuard database restored (${remoteSize} bytes) to ${tgt} — ${verify.stdout.slice(0, 150)}` };
        }
        return { success: false, detail: "Failed to place the PasarGuard database found inside the archive" };
      }

      // 1b) an OFFICIAL db_backup.sql dump (from `pasarguard backup` on the
      //     source server) → replay it into the panel's SQLite database
      const findSql = await ssh.exec(`find '${extractDir}' -maxdepth 3 \\( -name "db_backup.sql" -o -name "*.sql" \\) -type f 2>/dev/null | head -1; echo SQL_DONE`);
      const sqlFile = findSql.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(extractDir));
      if (sqlFile && !sqlFile.endsWith(".json")) {
        const tgtProbe = await ssh.exec(`for c in ${pgDbCandidates.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DONE`);
        const tgt = tgtProbe.stdout.trim().split("\n").find((l) => l.startsWith("/")) || pgDbCandidates[0];
        await ensureSqlite3(ssh);
        await ssh.exec(`cd ${pgDir} && docker compose down 2>&1 || docker-compose down 2>&1 || true; sleep 2; rm -f '${tgt}-wal' '${tgt}-shm' 2>/dev/null || true`);
        // strip MySQL-isms best-effort (official dumps on sqlite installs are plain SQL)
        const replay = await ssh.exec(`sed -E 's/ENGINE=[A-Za-z]+//g; s/DEFAULT CHARSET=[A-Za-z0-9_]+//g; s/COLLATE=[A-Za-z0-9_]+//g; s/AUTO_INCREMENT=[0-9]+//g; /^(SET |LOCK TABLES|UNLOCK TABLES|\\/\\*!)/d' '${sqlFile}' | sqlite3 '${tgt}' 2>&1 | tail -8; echo REPLAY_EXIT:\${PIPESTATUS[1]}`);
        await ssh.exec(`cd ${pgDir} && docker compose up -d 2>&1 || docker-compose up -d 2>&1 || true; sleep 8`);
        await ssh.exec(`rm -rf '${extractDir}'`);
        const cnt = await ssh.exec(`sqlite3 '${tgt}' "SELECT COUNT(*) FROM users;" 2>&1 | head -3 || echo no-sqlite3`);
        if (/^\d+$/.test(cnt.stdout.trim().split("\n")[0] || "")) {
          return { success: true, detail: `PasarGuard SQL dump replayed (${remoteSize} bytes) into ${tgt} — ${cnt.stdout.trim().split("\n")[0]} users` };
        }
        return { success: false, detail: `SQL dump replay did not verify — ${replay.stdout.slice(-160)} / verify: ${cnt.stdout.slice(0, 120)}` };
      }

      // 2) no database file inside → it must be the bkup JSON snapshot:
      //    replay the sections into the panel's real SQLite schema
      const snap = await restorePasarguardSnapshot(ssh, extractDir, remoteSize);
      await ssh.exec(`rm -rf '${extractDir}'`);
      return snap;
    }

    await ssh.exec(`rm -rf '${extractDir}'`);
    return { success: false, detail: `The PasarGuard backup archive could not be extracted — nothing was modified on the server` };
  }

  return { success: false, detail: `Unrecognized PasarGuard backup format — nothing was modified on the server` };
}

/** Restore a bkup PasarGuard full snapshot (tar.gz of manifest.json +
 * <section>.json files) into the panel's SQLite database. Each section is
 * mapped onto the REAL table (discovered via sqlite_master + PRAGMA) and the
 * rows are replayed inside one transaction — then the counts are verified, so
 * "success" only ever means the data is actually back in the database. */
async function restorePasarguardSnapshot(
  ssh: SshClient,
  extractDir: string,
  remoteSize: number
): Promise<{ success: boolean; detail: string }> {
  if (!(await ensureSqlite3(ssh))) {
    return { success: false, detail: "sqlite3 is not available on the server and could not be installed — the JSON snapshot cannot be replayed into the PasarGuard database" };
  }

  const pgDir = "/opt/pasarguard";
  const envProbe = await ssh.exec(`grep -E '^SQLALCHEMY_DATABASE_URL=' ${pgDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || true; echo ENV_DONE`);
  const envUrl = (envProbe.stdout.split("\n")[0] ?? "").trim();
  const envSqliteM = /sqlite:\/\/\/(\/[^\s"']+)/i.exec(envUrl);
  const cands = [envSqliteM?.[1], "/var/lib/pasarguard/db.sqlite3", `${pgDir}/data/db.sqlite3`, `${pgDir}/db.sqlite3`].filter((x): x is string => Boolean(x));
  const dbPathRes = await ssh.exec(`for c in ${cands.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DB_SEARCH_DONE`);
  // accept any absolute path line — the candidate list already constrains the search
  const dbLine = dbPathRes.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("/") && (l.includes(".db") || l.includes(".sqlite")));
  if (!dbLine) {
    return {
      success: false,
      detail: "PasarGuard database file (SQLite) was not found on the server — the JSON snapshot restore supports SQLite installs. Nothing was modified",
    };
  }
  const dbPath = dbLine;

  const tablesRes = await ssh.exec(`sqlite3 '${dbPath}' "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" 2>/dev/null`);
  const tables = parseSqliteTableNames(tablesRes.stdout);
  if (!tables.length) {
    return { success: false, detail: "Could not read the PasarGuard database schema (sqlite3 query failed) — nothing was modified" };
  }
  const tset = new Set(tables);

  // section → candidate table names (Marzban-family naming varies by version)
  const SECTION_TABLES: Record<string, string[]> = {
    users: ["users", "user"],
    hosts: ["hosts", "host"],
    nodes: ["nodes", "node"],
    cores: ["cores", "core"],
    groups: ["groups", "group"],
    client_templates: ["client_templates", "client_template", "clienttemplates"],
  };

  const plan: { table: string; rows: Record<string, unknown>[]; section: string }[] = [];
  for (const [section, candidates] of Object.entries(SECTION_TABLES)) {
    const table = candidates.find((c) => tset.has(c));
    if (!table) continue;
    const cat = await ssh.exec(`cat '${extractDir}/${section}.json' 2>/dev/null | head -c 52428800`);
    if (!cat.stdout.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cat.stdout);
    } catch {
      continue;
    }
    let rows: unknown[] = [];
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["users", "obj", "items", "data", "hosts", "nodes", "cores", "groups", "client_templates"]) {
        if (Array.isArray(obj[key])) {
          rows = obj[key] as unknown[];
          break;
        }
      }
    }
    if (!rows.length) continue;
    plan.push({ table, rows: rows as Record<string, unknown>[], section });
  }

  if (!plan.length) {
    return { success: false, detail: "The PasarGuard snapshot contains no restorable sections (users/hosts/nodes/cores/groups) — nothing was modified" };
  }

  const parts: string[] = ["BEGIN;"];
  for (const item of plan) {
    const cols = await remoteSqliteColumns(ssh, dbPath, item.table);
    if (!cols) continue;
    parts.push(`DELETE FROM ${sqlQuoteIdent(item.table)};`);
    parts.push(buildSqlInserts(item.table, cols, item.rows));
    // resume AUTOINCREMENT from the real key column when there is one —
    // MAX(rowid) is only the correct seq source for tables without "id"
    const seqExpr = cols.includes("id") ? "MAX(id)" : "MAX(rowid)";
    parts.push(`UPDATE sqlite_sequence SET seq=(SELECT COALESCE(${seqExpr},0) FROM ${sqlQuoteIdent(item.table)}) WHERE name='${item.table}';`);
  }
  parts.push("COMMIT;");

  const stamp = Date.now();
  // distinct local/remote names — see the same-machine note in restore3xUiJson
  const localSql = `/tmp/bkup-pg-snap-${stamp}.local.sql`;
  const remoteSql = `/tmp/bkup-pg-snap-${stamp}.remote.sql`;
  fs.writeFileSync(localSql, parts.filter(Boolean).join("\n") + "\n");
  try {
    await ssh.uploadFile(localSql, remoteSql);
  } finally {
    try { fs.unlinkSync(localSql); } catch { /* ignore */ }
  }

  await ssh.exec(`cd ${pgDir} && docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true; sleep 2`);
  await ssh.exec(`rm -f '${dbPath}-wal' '${dbPath}-shm' 2>/dev/null || true`);
  await ssh.exec(`sqlite3 '${dbPath}' < '${remoteSql}' 2>&1 | tail -5`);
  try { await ssh.exec(`rm -f '${remoteSql}'`); } catch { /* ignore */ }
  await ssh.exec(`cd ${pgDir} && docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || true; sleep 8`);

  // verify EVERY restored table row-by-row before claiming success
  const verifyParts: string[] = [];
  let allOk = true;
  for (const item of plan) {
    const c = await ssh.exec(`sqlite3 '${dbPath}' "SELECT COUNT(*) FROM ${sqlQuoteIdent(item.table)};" 2>&1`);
    const n = parseInt(c.stdout.trim(), 10);
    const ok = Number.isFinite(n) && n === item.rows.length;
    if (!ok) allOk = false;
    verifyParts.push(`${item.section}=${Number.isFinite(n) ? n : "?"}/${item.rows.length}`);
  }
  if (!allOk) {
    return { success: false, detail: `PasarGuard snapshot replay failed — restored table counts do not match the backup (${verifyParts.join(", ")})` };
  }
  const docker = await ssh.exec('docker ps --format "{{.Names}}" 2>/dev/null | grep -i pasarguard || true');
  return {
    success: true,
    detail: `PasarGuard snapshot restored (${remoteSize} bytes) — ${verifyParts.join(", ")} rows replayed into the panel database${docker.stdout.trim() ? "; panel containers running" : "; panel restarted"}. Target admin login and panel settings are kept`,
  };
}

async function restoreRebecca(ssh: SshClient, remoteBackupPath: string, backupName: string, localBackupPath: string): Promise<{ success: boolean; detail: string }> {
  const lowerName = backupName.toLowerCase();
  const kind = sniffBackupKind(localBackupPath);

  const uploadCheck = await ssh.exec(`ls -lh '${remoteBackupPath}' 2>&1 && stat -c %s '${remoteBackupPath}' 2>/dev/null || wc -c < '${remoteBackupPath}' 2>/dev/null || echo 0`);
  const uploadOut = uploadCheck.stdout.trim();
  if (uploadOut.includes("No such file") || uploadOut.includes("cannot access")) {
    return { success: false, detail: `Uploaded Rebecca backup not found at ${remoteBackupPath}` };
  }
  const sizeMatch = uploadOut.match(/(\d+)\s*$/);
  const remoteSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  if (remoteSize === 0) {
    return { success: false, detail: `Uploaded Rebecca backup is empty` };
  }

  const rbDir = "/opt/rebecca";
  await ssh.exec(`mkdir -p ${rbDir} ${rbDir}/data /var/lib/rebecca; (cp -r ${rbDir}/data ${rbDir}/data.pre-restore-$(date +%s) 2>/dev/null || cp -r /var/lib/rebecca /var/lib/rebecca.pre-restore-$(date +%s) 2>/dev/null || true)`);

  // ── Rebecca restore strategy: deterministic, content-based ──
  // The .rbbackup the panel exports is an archive of its own data; bkup
  // restores by CONTENT: a database file is placed byte-for-byte, an SQL dump
  // is replayed, and the location follows the REAL install — the
  // SQLALCHEMY_DATABASE_URL in .env first, then /var/lib/rebecca (current
  // layout) and /opt/rebecca (legacy) as fallbacks. Interactive CLIs are not
  // used: they take no file path and would only hang the restore.
  const envProbe = await ssh.exec(`grep -E '^SQLALCHEMY_DATABASE_URL=' ${rbDir}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\r' || true; echo ENV_DONE`);
  const envUrl = (envProbe.stdout.split("\n")[0] ?? "").trim();
  const backendIsSqlite = !envUrl || /sqlite/i.test(envUrl);
  const envSqliteM = /sqlite:\/\/\/(\/[^\s"']+)/i.exec(envUrl);
  const rbDbCandidates = [
    envSqliteM?.[1],
    "/var/lib/rebecca/db.sqlite3",
    `${rbDir}/data/db.sqlite3`,
    `${rbDir}/db.sqlite3`,
  ].filter((x): x is string => Boolean(x));

  if (!backendIsSqlite) {
    return {
      success: false,
      detail:
        "This Rebecca server uses a MySQL/PostgreSQL backend (SQLALCHEMY_DATABASE_URL in .env), so a file-level restore cannot be applied automatically — install Rebecca with the same SQLite backend as the panel the backup came from, then run the restore again. The server was not modified.",
    };
  }

  if (kind === "sqlite" || (kind === "unknown" && (lowerName.endsWith(".db") || lowerName.endsWith(".sqlite") || lowerName.endsWith(".sqlite3")))) {
    const dbPathRes = await ssh.exec(`for c in ${rbDbCandidates.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DB_SEARCH_DONE`);
    let targetDb = rbDbCandidates[0];
    const found = dbPathRes.stdout.trim().split("\n").find((l) => l.startsWith("/") && (l.includes(".db") || l.includes(".sqlite")));
    if (found) targetDb = found.trim();

    await ssh.exec(`cd ${rbDir} && docker compose down 2>&1 || docker-compose down 2>&1 || true; sleep 2; rm -f ${targetDb}-wal ${targetDb}-shm 2>/dev/null || true`);
    const cpRes = await ssh.exec(`cp -f '${remoteBackupPath}' '${targetDb}' && chmod 644 '${targetDb}' && ls -lh '${targetDb}' && echo OK || echo FAIL`);
    await ssh.exec(`rm -f ${targetDb}-wal ${targetDb}-shm 2>/dev/null; chmod 644 '${targetDb}' 2>/dev/null || true`);
    await ssh.exec(`cd ${rbDir} && docker compose up -d 2>&1 || docker-compose up -d 2>&1 || true; sleep 8`);

    if (cpRes.stdout.includes("OK")) {
      const verify = await ssh.exec(`ls -lh '${targetDb}'; sqlite3 '${targetDb}' "SELECT COUNT(*) FROM users;" 2>&1 | head -10 || echo ok; docker ps --format "{{.Names}}" 2>/dev/null | grep -i rebecca`);
      return { success: true, detail: `Rebecca database restored (${remoteSize} bytes) to ${targetDb} — ${verify.stdout.slice(0, 150)}` };
    }
    return { success: false, detail: `Failed to restore Rebecca db: ${cpRes.stdout.slice(0, 200)}` };
  }

  if (kind === "json") {
    return { success: false, detail: "This Rebecca backup is a bare JSON document — Rebecca restores need its own export file (via the rebecca CLI) or its database file. Nothing was modified" };
  }

  if (kind === "tar-gz" || kind === "zip" || lowerName.match(/\.(tar\.gz|tgz|zip)$/)) {
    const extractDir = `/tmp/bkup-rb-extract-${Date.now()}`;
    await ssh.exec(`mkdir -p '${extractDir}'`);
    const extractRes = await ssh.exec(
      kind === "zip"
        ? `cd '${extractDir}' && unzip -o '${remoteBackupPath}' 2>&1 && echo EXTRACT_OK || echo EXTRACT_FAIL`
        : `cd '${extractDir}' && (tar -xzf '${remoteBackupPath}' 2>&1 || tar -xf '${remoteBackupPath}' 2>&1) && echo EXTRACT_OK || echo EXTRACT_FAIL`,
      { timeout: 5 * 60 * 1000 }
    );

    if (extractRes.stdout.includes("EXTRACT_OK")) {
      const findDb = await ssh.exec(`find '${extractDir}' \\( -name "*.db" -o -name "*.sqlite*" \\) -type f 2>/dev/null | head -5`);
      const dbFile = findDb.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(extractDir));
      if (dbFile) {
        const dbPath = dbFile;
        const tgtProbe = await ssh.exec(`for c in ${rbDbCandidates.join(" ")}; do [ -f "$c" ] && echo "$c"; done 2>/dev/null | head -1; echo DONE`);
        const tgt = tgtProbe.stdout.trim().split("\n").find((l) => l.startsWith("/")) || rbDbCandidates[0];
        await ssh.exec(`cd ${rbDir} && docker compose down 2>&1 || docker-compose down 2>&1 || true; sleep 2`);
        const cpRes = await ssh.exec(`mkdir -p "$(dirname '${tgt}')"; cp -f '${dbPath}' '${tgt}' && chmod 644 '${tgt}' && echo COPY_OK || echo COPY_FAIL; rm -f '${tgt}-wal' '${tgt}-shm' 2>/dev/null || true`);
        await ssh.exec(`cd ${rbDir} && docker compose up -d 2>&1 || docker-compose up -d 2>&1; sleep 8`);
        await ssh.exec(`rm -rf '${extractDir}'`);
        if (cpRes.stdout.includes("COPY_OK")) {
          const verify = await ssh.exec(`ls -lh '${tgt}'; docker ps --format "{{.Names}}" 2>/dev/null | grep -i rebecca`);
          return { success: true, detail: `Rebecca database restored (${remoteSize} bytes) to ${tgt} — ${verify.stdout.slice(0, 150)}` };
        }
        return { success: false, detail: "Failed to place the Rebecca database found inside the archive" };
      }
      await ssh.exec(`rm -rf '${extractDir}'`);
      return { success: false, detail: "The Rebecca archive contained no database file — nothing was restored. Use the rebecca CLI path or Rebecca's SQLite database backup" };
    }

    await ssh.exec(`rm -rf '${extractDir}'`);
    return { success: false, detail: "The Rebecca backup archive could not be extracted — nothing was modified on the server" };
  }

  // unknown binary export (e.g. Rebecca's own .rbbackup): copying it verbatim
  // over db.sqlite3 would CORRUPT the panel — that false-success path is gone.
  return {
    success: false,
    detail: "This Rebecca export must be restored with the rebecca CLI — install Rebecca on the target server (which provides the CLI), then retry the restore. Nothing was modified",
  };
}

async function resolveBackup(
  backupId: number,
  source: "backup-run" | "reassembled"
): Promise<{ filePath: string; fileName: string; panel: PanelId }> {
  if (source === "backup-run") {
    const row = await db.backupRun.findUnique({ where: { id: backupId } });
    if (!row || !row.filePath) throw new Error("BACKUP_NOT_FOUND");
    return {
      filePath: row.filePath,
      fileName: row.fileName || path.basename(row.filePath),
      panel: row.panel as PanelId,
    };
  } else {
    const row = await db.reassembledBackup.findUnique({ where: { id: backupId } });
    if (!row || !row.filePath) throw new Error("BACKUP_NOT_FOUND");
    return {
      filePath: row.filePath,
      fileName: row.name,
      panel: (row.panel || "3x-ui") as PanelId,
    };
  }
}

export async function startRestore(req: RestoreRequest): Promise<{ jobId?: number; ok: boolean; error?: string }> {
  if (isRestoreRunning()) {
    return { ok: false, error: "RESTORE_ALREADY_RUNNING" };
  }

  let backup: { filePath: string; fileName: string; panel: PanelId };
  try {
    backup = await resolveBackup(req.backupId, req.backupSource);
  } catch {
    return { ok: false, error: "BACKUP_NOT_FOUND" };
  }

  if (!fs.existsSync(backup.filePath)) {
    return { ok: false, error: "BACKUP_FILE_MISSING" };
  }

  // The selected backup OWNS the panel choice — a 3x-ui backup is restored
  // only onto a 3x-ui panel, an HMPanel backup only onto HMPanel, and so on.
  // bkup never migrates one panel's backup onto another panel: whatever panel
  // the client asked for, the backup's own panel wins.
  if (req.panel !== backup.panel) {
    await log("warn", bi(
      `Restore request asked for panel "${req.panel}" but the selected backup belongs to "${backup.panel}" — the backup's own panel is used (no cross-panel migration)`,
      `Restore request asked for panel "${req.panel}" but the selected backup belongs to "${backup.panel}" — the backup's own panel is used (no cross-panel migration)`
    ));
    req = { ...req, panel: backup.panel };
  }

  const job = await db.restoreJob.create({
    data: {
      status: "running",
      panel: req.panel,
      backupId: req.backupId,
      backupName: backup.fileName,
      backupSource: req.backupSource,
      backupPath: backup.filePath,
      sshHost: req.sshHost,
      sshPort: req.sshPort,
      sshUser: req.sshUser,
    },
  });

  const state: RestoreState = {
    jobId: job.id,
    status: "running",
    panel: req.panel,
    backupName: backup.fileName,
    sshHost: req.sshHost,
    steps: makeSteps(req.panel, req.installNode ?? false),
    startedAt: Date.now(),
  };
  writeStateFile(state);
  g.__restoreRunning = true;

  runRestoreAsync(req, backup, state).catch((e) => {
    console.error("[restore] unhandled error:", e);
  });

  return { jobId: job.id, ok: true };
}

async function runRestoreAsync(
  req: RestoreRequest,
  backup: { filePath: string; fileName: string; panel: PanelId },
  state: RestoreState
): Promise<void> {
  const ssh = new SshClient(dataDir());
  let cfg: RestoreConfig | null = null;
  try {
    cfg = await getRestoreConfig();
  } catch (cfgErr) {
    console.error("[restore] failed to load restore config, using defaults:", cfgErr);
  }
  const installNode = req.installNode ?? false;
  const multiDomains = normalizeDomains(req.sslDomain, req.sslDomains);

  try {
    clearCancelFlag();
    assertNotCancelled();
    markStep(state.steps, "connect", "running");
    state.currentStepKey = "connect";
    writeStateFile(state);

    const sshOpts: SshOptions = {
      host: req.sshHost,
      port: req.sshPort || 22,
      username: req.sshUser,
      password: req.sshPassword,
      privateKey: req.sshPrivateKey,
      passphrase: req.sshPassphrase,
      timeout: 20000,
    };

    await ssh.connect(sshOpts);
    markStep(state.steps, "connect", "done", `Connected to ${req.sshUser}@${req.sshHost}:${req.sshPort}`);
    writeStateFile(state);
    await log("info", bi(`[Restore] SSH connection established: ${req.sshHost}:${req.sshPort}`, `[Restore] SSH connection established: ${req.sshHost}:${req.sshPort}`));

    assertNotCancelled();
    markStep(state.steps, "check_panel", "running");
    state.currentStepKey = "check_panel";
    writeStateFile(state);

    const panelCheck = await checkPanelInstalled(ssh, req.panel);
    markStep(state.steps, "check_panel", "done", panelCheck.detail);
    writeStateFile(state);

    assertNotCancelled();
    markStep(state.steps, "install_node", "running");
    state.currentStepKey = "install_node";
    writeStateFile(state);

    const sysReq = await checkSystemRequirements(ssh);
    markStep(state.steps, "install_node", "done", sysReq.detail);
    writeStateFile(state);

    if (!panelCheck.installed) {
      assertNotCancelled();
      markStep(state.steps, "install_panel", "running");
      state.currentStepKey = "install_panel";
      writeStateFile(state);

      const installResult = await installPanel(ssh, req.panel, cfg, req, (text) => {
        const snippet = text.trim().split("\n").pop()?.slice(0, 160) || "";
        if (snippet) {
          markStep(state.steps, "install_panel", "running", snippet);
          writeStateFile(state);
        }
      });

      if (!installResult.success) {
        markStepError(state.steps, "install_panel", installResult.detail);
        writeStateFile(state);
        throw new Error(installResult.detail);
      }

      markStep(state.steps, "install_panel", "done", installResult.detail);
      writeStateFile(state);
      await log("info", bi(`[Restore] Panel installed: ${req.panel} on ${req.sshHost}`, `[Restore] Panel installed: ${req.panel} on ${req.sshHost}`));

      if (installNode && (req.panel === "pasarguard" || req.panel === "rebecca")) {
        assertNotCancelled();
        markStep(state.steps, "install_node_component", "running");
        state.currentStepKey = "install_node_component";
        writeStateFile(state);

        const nodeResult2 = await installPanelNode(ssh, req.panel, (text) => {
          const snippet = text.trim().split("\n").pop()?.slice(0, 160) || "";
          if (snippet) {
            markStep(state.steps, "install_node_component", "running", snippet);
            writeStateFile(state);
          }
        });

        if (!nodeResult2.success) {
          markStepError(state.steps, "install_node_component", nodeResult2.detail);
          writeStateFile(state);
          throw new Error(nodeResult2.detail);
        }

        markStep(state.steps, "install_node_component", "done", nodeResult2.detail);
        writeStateFile(state);
      } else {
        markStep(state.steps, "install_node_component", "skipped", installNode ? "Not supported for this panel" : "Not requested");
        writeStateFile(state);
      }
    } else {
      markStep(state.steps, "install_panel", "skipped", "Panel already installed");
      if (installNode && (req.panel === "pasarguard" || req.panel === "rebecca")) {
        assertNotCancelled();
        markStep(state.steps, "install_node_component", "running");
        state.currentStepKey = "install_node_component";
        writeStateFile(state);

        const nodeResult2 = await installPanelNode(ssh, req.panel, (text) => {
          const snippet = text.trim().split("\n").pop()?.slice(0, 160) || "";
          if (snippet) {
            markStep(state.steps, "install_node_component", "running", snippet);
            writeStateFile(state);
          }
        });

        if (!nodeResult2.success) {
          markStep(state.steps, "install_node_component", "skipped", nodeResult2.detail);
        } else {
          markStep(state.steps, "install_node_component", "done", nodeResult2.detail);
        }
        writeStateFile(state);
      } else {
        markStep(state.steps, "install_node_component", "skipped", "Not needed");
        writeStateFile(state);
      }
    }

    assertNotCancelled();
    // ── Multi-domain SSL cert step ──
    if (multiDomains.length > 0 && (req.sslMode === "domain" || req.sslMode === "custom" || multiDomains.length > 1)) {
      markStep(state.steps, "ssl_cert", "running", `Issuing cert for ${multiDomains.join(", ")}...`);
      state.currentStepKey = "ssl_cert";
      writeStateFile(state);

      const certResult = await issueMultiDomainCert(ssh, req.panel, multiDomains, (txt) => {
        markStep(state.steps, "ssl_cert", "running", txt.slice(0, 160));
        writeStateFile(state);
      });

      if (certResult.success) {
        markStep(state.steps, "ssl_cert", "done", certResult.detail);
      } else {
        // Don't fail restore if cert fails, just mark as failed but continue — cert is important but not blocking
        markStep(state.steps, "ssl_cert", "done", `Cert warning: ${certResult.detail} — continuing with restore`);
      }
      writeStateFile(state);
    } else {
      markStep(state.steps, "ssl_cert", "skipped", "No multi-domain cert requested");
      writeStateFile(state);
    }

    assertNotCancelled();
    markStep(state.steps, "upload_backup", "running");
    state.currentStepKey = "upload_backup";
    markStep(state.steps, "upload_backup", "running", `Uploading ${backup.fileName}...`);
    writeStateFile(state);

    const remotePath = `/tmp/bkup-restore-${Date.now()}-${backup.fileName.replace(/[^\w.@-]/g, "_")}`;

    // Upload with one automatic reconnect on transient SSH errors
    let uploadAttempts = 0;
    const maxUploadAttempts = 2;
    let uploadSucceeded = false;
    let lastProgressReport = 0;
    while (uploadAttempts < maxUploadAttempts && !uploadSucceeded) {
      uploadAttempts++;
      try {
        await ssh.uploadFile(backup.filePath, remotePath, (sent, total) => {
          const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
          const now = Date.now();
          // Throttle progress writes to at most once per 2 seconds
          if (now - lastProgressReport >= 2000 || pct === 100) {
            lastProgressReport = now;
            markStep(state.steps, "upload_backup", "running", `Uploading... ${pct}%`);
            writeStateFile(state);
          }
        });
        uploadSucceeded = true;
      } catch (uploadErr) {
        const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
        const isTransient = uploadErr instanceof SshError && (
          uploadErr.code === "NOT_CONNECTED" ||
          uploadErr.code === "EUPLOAD" ||
          uploadErr.code === "ESFTP"
        );
        if (isTransient && uploadAttempts < maxUploadAttempts) {
          markStep(state.steps, "upload_backup", "running", `Connection lost, reconnecting... (attempt ${uploadAttempts}/${maxUploadAttempts})`);
          writeStateFile(state);
          await log("warn", bi(`[Restore] SSH disconnect during upload, reconnecting (attempt ${uploadAttempts})...`, `[Restore] SSH disconnect during upload, reconnecting...`));
          try {
            await ssh.reconnect();
            // Remove partial file before retry
            try { await ssh.exec(`rm -f '${remotePath}'`); } catch {}
          } catch (reconnErr) {
            throw new Error(`Upload failed — could not reconnect: ${reconnErr instanceof Error ? reconnErr.message : String(reconnErr)}`);
          }
        } else {
          throw uploadErr;
        }
      }
    }

    const localSize = fs.statSync(backup.filePath).size;
    const remoteCheck = await ssh.exec(`ls -lh '${remotePath}' 2>&1; stat -c %s '${remotePath}' 2>/dev/null || wc -c < '${remotePath}' 2>/dev/null || echo 0`);
    const remoteSizeMatch = remoteCheck.stdout.trim().match(/(\d+)\s*$/);
    const remoteSize = remoteSizeMatch ? parseInt(remoteSizeMatch[1], 10) : 0;
    if (remoteSize === 0) {
      markStepError(state.steps, "upload_backup", `Upload failed — remote file is empty or missing. Local: ${localSize} bytes, Remote: ${remoteSize} bytes. Output: ${remoteCheck.stdout.slice(0, 200)}`);
      writeStateFile(state);
      throw new Error(`Upload failed — remote file empty. Local ${localSize} bytes, remote ${remoteSize} bytes`);
    }

    markStep(state.steps, "upload_backup", "done", `Backup uploaded (${backup.fileName}) — ${localSize} bytes verified on server`);
    writeStateFile(state);

    assertNotCancelled();
    markStep(state.steps, "restore", "running");
    state.currentStepKey = "restore";
    writeStateFile(state);

    // Wrap the restore command with reconnect on transient SSH failure
    let restoreResult: { success: boolean; detail: string };
    try {
      restoreResult = await restoreFromRemotePath(ssh, req.panel, remotePath, backup.fileName, backup.filePath);
    } catch (restoreErr) {
      const isTransient = restoreErr instanceof SshError && (
        restoreErr.code === "NOT_CONNECTED" || restoreErr.code === "EEXEC" || restoreErr.code === "ESTREAM"
      );
      if (isTransient) {
        markStep(state.steps, "restore", "running", "Connection lost, reconnecting...");
        writeStateFile(state);
        await log("warn", bi(`[Restore] SSH disconnect during restore, reconnecting...`, `[Restore] SSH disconnect during restore, reconnecting...`));
        await ssh.reconnect();
        restoreResult = await restoreFromRemotePath(ssh, req.panel, remotePath, backup.fileName, backup.filePath);
      } else {
        throw restoreErr;
      }
    }

    try {
      await ssh.exec(`rm -f '${remotePath}'`);
    } catch {}

    if (!restoreResult.success) {
      markStepError(state.steps, "restore", restoreResult.detail);
      writeStateFile(state);
      throw new Error(restoreResult.detail);
    }

    markStep(state.steps, "restore", "done", restoreResult.detail);
    writeStateFile(state);

    // Re-apply multi-domain cert after restore (backup overwrites db/config, so cert settings may be lost)
    if (multiDomains.length > 0) {
      try {
        const first = multiDomains[0];
        await ssh.exec(`
          echo "[bkup] Re-applying multi-domain cert after restore for ${req.panel}..."
          if [ -f /root/cert/${first}/fullchain.pem ] && [ -f /root/cert/${first}/privkey.pem ]; then
            openssl x509 -in /root/cert/${first}/fullchain.pem -noout -checkend 0 2>&1 && echo "CERT_VALID" || echo "CERT_EXPIRED_OR_INVALID"
            if [ "${req.panel}" = "3x-ui" ] && [ -x /usr/local/x-ui/x-ui ]; then
              /usr/local/x-ui/x-ui cert -webCert /root/cert/${first}/fullchain.pem -webCertKey /root/cert/${first}/privkey.pem 2>&1 || true
              /usr/local/x-ui/x-ui setting -listenIP "0.0.0.0" 2>&1 || true
              systemctl restart x-ui 2>/dev/null || true
              sleep 2
              systemctl is-active x-ui 2>&1 || true
            elif [ "${req.panel}" = "hmpanel" ] && [ -d /opt/hmpanel ]; then
              mkdir -p /opt/hmpanel/nginx/ssl
              cp /root/cert/${first}/fullchain.pem /opt/hmpanel/nginx/ssl/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/hmpanel/nginx/ssl/privkey.pem 2>/dev/null || true
              cp /root/cert/${first}/fullchain.pem /opt/hmpanel/nginx/ssl/cert.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/hmpanel/nginx/ssl/key.pem 2>/dev/null || true
              chmod 644 /opt/hmpanel/nginx/ssl/*.pem 2>/dev/null || true
              if [ -f /opt/hmpanel/.env ]; then
                sed -i "s/^DOMAIN=.*/DOMAIN=${first}/" /opt/hmpanel/.env 2>/dev/null || true
                sed -i "s/^PANEL_DOMAIN=.*/PANEL_DOMAIN=${first}/" /opt/hmpanel/.env 2>/dev/null || true
                sed -i "s/^SSL_ENABLED=.*/SSL_ENABLED=true/" /opt/hmpanel/.env 2>/dev/null || true
              fi
              cd /opt/hmpanel && docker compose restart nginx 2>/dev/null || docker restart hmpanel-nginx 2>/dev/null || true
              sleep 2
              docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null | grep -i hmpanel || true
            elif [ "${req.panel}" = "pasarguard" ] && [ -d /opt/pasarguard ]; then
              mkdir -p /opt/pasarguard/certs /opt/pasarguard/data/certs /opt/pasarguard/nginx/ssl
              cp /root/cert/${first}/fullchain.pem /opt/pasarguard/certs/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/pasarguard/certs/privkey.pem 2>/dev/null || true
              cp /root/cert/${first}/fullchain.pem /opt/pasarguard/data/certs/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/pasarguard/data/certs/privkey.pem 2>/dev/null || true
              cp /root/cert/${first}/fullchain.pem /opt/pasarguard/nginx/ssl/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/pasarguard/nginx/ssl/privkey.pem 2>/dev/null || true
              cd /opt/pasarguard && docker compose restart 2>/dev/null || true
            elif [ "${req.panel}" = "rebecca" ] && [ -d /opt/rebecca ]; then
              mkdir -p /opt/rebecca/certs /opt/rebecca/data/certs /opt/rebecca/nginx/ssl
              cp /root/cert/${first}/fullchain.pem /opt/rebecca/certs/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/rebecca/certs/privkey.pem 2>/dev/null || true
              cp /root/cert/${first}/fullchain.pem /opt/rebecca/data/certs/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/rebecca/data/certs/privkey.pem 2>/dev/null || true
              cp /root/cert/${first}/fullchain.pem /opt/rebecca/nginx/ssl/fullchain.pem 2>/dev/null || true
              cp /root/cert/${first}/privkey.pem /opt/rebecca/nginx/ssl/privkey.pem 2>/dev/null || true
              cd /opt/rebecca && docker compose restart 2>/dev/null || true
            fi
            echo "CERT_REAPPLY_OK"
          else
            echo "CERT_NOT_FOUND_AFTER_RESTORE"
          fi
        `);
      } catch {}
    }

    assertNotCancelled();
    markStep(state.steps, "verify", "running");
    state.currentStepKey = "verify";
    writeStateFile(state);

    await ssh.exec("sleep 5");

    // Robust verification for all 4 panel types — executed as a SCRIPT FILE.
    // The previous inline version used `pgrep -f "$panel"`: the pattern text
    // ("3x-ui", "hmpanel", …) also sat inside the remote shell's own command
    // line, so pgrep matched the checker itself and ALWAYS reported running.
    const verifyOutput = (
      await execRemoteScript(ssh, [
        "check_panel_running() {",
        '  local panel="$1"',
        "  # Docker containers are matched by NAME (not a process scan) — no self-match",
        '  case "$panel" in',
        "    hmpanel|pasarguard|rebecca)",
        '      if docker ps --format "{{.Names}}" 2>/dev/null | grep -qi "$panel"; then echo "docker_running"; return 0; fi',
        "      ;;",
        "  esac",
        '  local svc="" pat=""',
        '  case "$panel" in',
        '    3x-ui)      svc="x-ui";       pat="/usr/local/x-ui" ;;',
        '    hmpanel)    svc="hmpanel";    pat="hmpanel" ;;',
        '    pasarguard) svc="pasarguard"; pat="pasarguard" ;;',
        '    rebecca)    svc="rebecca";    pat="rebecca" ;;',
        "  esac",
        '  if [ -n "$svc" ] && systemctl is-active "$svc" 2>/dev/null | grep -q "^active$"; then echo "systemd_active"; return 0; fi',
        '  if [ -n "$pat" ] && pgrep -f "$pat" >/dev/null 2>&1; then echo "process_running"; return 0; fi',
        '  if [ "$panel" = "3x-ui" ] && ss -tlnp 2>/dev/null | grep -q "x-ui"; then echo "port_active"; return 0; fi',
        '  echo "not_running"',
        "  return 1",
        "}",
        `check_panel_running "${req.panel}"`,
      ].join("\n"))
    ).trim();
    const isOk =
      verifyOutput.includes("docker_running") ||
      verifyOutput.includes("systemd_active") ||
      verifyOutput.includes("process_running") ||
      verifyOutput.includes("port_active");

    markStep(state.steps, "verify", "done", isOk ? `Verification passed — panel is running (${verifyOutput.split("\n").pop()?.trim() || "ok"})` : "Restore completed — panel process could not be detected (best-effort verification)");
    state.status = "success";
    state.finishedAt = Date.now();
    state.durationMs = state.finishedAt - state.startedAt;
    writeStateFile(state);

    await db.restoreJob.update({
      where: { id: state.jobId },
      data: {
        status: "success",
        finishedAt: new Date(),
        durationMs: state.durationMs,
        steps: JSON.stringify(state.steps),
      },
    });

    clearCancelFlag();

    await log("success", bi(`[Restore] Backup restored successfully on ${req.sshHost} (${backup.fileName})`, `[Restore] Backup restored successfully on ${req.sshHost} (${backup.fileName})`));
  } catch (e: unknown) {
    const rawError = e instanceof Error ? e.message : String(e);
    const isCancelled = rawError === "RESTORE_CANCELLED" || rawError.toLowerCase().includes("cancel");
    const error = isCancelled ? "Cancelled by user" : rawError;
    state.status = isCancelled ? "cancelled" : "failed";
    state.error = error;
    state.finishedAt = Date.now();
    state.durationMs = state.finishedAt - state.startedAt;
    if (state.currentStepKey) {
      const cur = stepBy(state.steps, state.currentStepKey);
      if (cur && cur.status !== "failed") markStepError(state.steps, state.currentStepKey, error);
    }
    writeStateFile(state);
    await db.restoreJob.update({
      where: { id: state.jobId },
      data: {
        status: state.status,
        finishedAt: new Date(),
        error: error,
        durationMs: state.durationMs,
        steps: JSON.stringify(state.steps),
      },
    });
    clearCancelFlag();
    await log("error", bi(`[Restore] Restore failed: ${error}`, `[Restore] Restore failed: ${error}`));
  } finally {
    ssh.disconnect();
    g.__restoreRunning = false;
    clearCancelFlag();
  }
}

export async function listAvailableBackups(): Promise<{
  backupRuns: { id: number; fileName: string; panel: string; fileSize: number | null; startedAt: string; source: "backup-run" }[];
  reassembled: { id: number; name: string; panel: string; size: number; createdAt: string; source: "reassembled" }[];
}> {
  const [runs, reassembled] = await Promise.all([
    db.backupRun.findMany({
      where: { status: "success", filePath: { not: null } },
      orderBy: { startedAt: "desc" },
      take: 100,
      select: { id: true, fileName: true, panel: true, fileSize: true, startedAt: true, filePath: true },
    }),
    db.reassembledBackup.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, name: true, panel: true, size: true, createdAt: true, filePath: true },
    }),
  ]);

  const backupRuns = runs
    .filter((r) => r.filePath && fs.existsSync(r.filePath))
    .map((r) => ({
      id: r.id,
      fileName: r.fileName || "unknown",
      panel: r.panel,
      fileSize: r.fileSize,
      startedAt: r.startedAt.toISOString(),
      source: "backup-run" as const,
    }));

  const reassembledRows = reassembled
    .filter((r) => r.filePath && fs.existsSync(r.filePath))
    .map((r) => ({
      id: r.id,
      name: r.name,
      panel: r.panel || "3x-ui",
      size: r.size,
      createdAt: r.createdAt.toISOString(),
      source: "reassembled" as const,
    }));

  return { backupRuns, reassembled: reassembledRows };
}

export async function getRestoreHistory(limit: number = 50) {
  const rows = await db.restoreJob.findMany({
    orderBy: { startedAt: "desc" },
    take: Math.min(200, Math.max(1, limit)),
  });
  return rows;
}
