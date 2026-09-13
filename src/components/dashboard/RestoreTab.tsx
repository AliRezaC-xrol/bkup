"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Server, DatabaseBackup, Boxes, ShieldCheck, CheckCircle2, XCircle,
  Loader2, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Wifi, History, AlertTriangle,
  RefreshCw, Key, Lock, RotateCcw, Rocket, Inbox, Network, Globe, Eye, EyeOff,
  Cloud, Plus, Trash2, Copy, ExternalLink, Shield, Link2, Combine, FileDown,
} from "lucide-react";
import { resolveText } from "@/lib/messages";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import { TimeAgo } from "@/components/dashboard/TimeAgo";
import { formatBytes } from "@/components/dashboard/types";
import type { DictKey } from "@/lib/i18n";

// ── Types ──
type Step = "connection" | "panel" | "cloudflare" | "select" | "confirm" | "progress";
type AuthMethod = "password" | "key";
type PanelId = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";

interface BackupItem {
  id: number;
  fileName?: string;
  name?: string;
  panel: string;
  fileSize?: number | null;
  size?: number;
  startedAt?: string;
  createdAt?: string;
  source: "backup-run" | "reassembled";
}

interface RestoreStepState {
  key: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
  error?: string;
}

interface RestoreStatus {
  jobId?: number;
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  panel?: PanelId;
  backupName?: string;
  sshHost?: string;
  steps?: RestoreStepState[];
  currentStepKey?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  durationMs?: number;
}

interface CfZone { id: string; name: string; status: string; }
interface CfRecord { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number; }

interface CfSubEntry {
  id: string;
  subName: string;
  ip: string;
  proxied: boolean;
  status?: "idle" | "updating" | "done" | "failed";
  detail?: string;
}

const STEP_ORDER: Step[] = ["connection", "panel", "cloudflare", "select", "confirm", "progress"];

const PANEL_OPTIONS: { value: PanelId; labelKey: DictKey; descKey: DictKey; icon: React.ReactNode; hasNode: boolean; tag: string }[] = [
  { value: "3x-ui", labelKey: "restore_panel_3xui", descKey: "restore_panel_3xui_desc", icon: <DatabaseBackup className="h-5 w-5" />, hasNode: false, tag: "3X" },
  { value: "hmpanel", labelKey: "restore_panel_hm", descKey: "restore_panel_hm_desc", icon: <Boxes className="h-5 w-5" />, hasNode: false, tag: "HM" },
  { value: "pasarguard", labelKey: "restore_panel_pg", descKey: "restore_panel_pg_desc", icon: <ShieldCheck className="h-5 w-5" />, hasNode: true, tag: "PG" },
  { value: "rebecca", labelKey: "restore_panel_rb", descKey: "restore_panel_rb_desc", icon: <Server className="h-5 w-5" />, hasNode: true, tag: "RB" },
];

// ── Main Component ──
export function RestoreTab() {
  const { t } = useLang();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("connection");
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // SSH form
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [selectedBackup, setSelectedBackup] = useState<BackupItem | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<PanelId | null>(null);
  const [installNode, setInstallNode] = useState(false);

  // SSL Certificate (optional) - NOW supports multi-domain directly in this section
  const [enableSsl, setEnableSsl] = useState(false);
  const [sslMode, setSslMode] = useState<"none" | "domain" | "ip" | "custom">("none");
  const [sslDomain, setSslDomain] = useState(""); // legacy single, kept for compat
  const [sslDomains, setSslDomains] = useState<string[]>([]); // multi-domain SAN support - main field
  const [sslDomainInput, setSslDomainInput] = useState("");
  const [sslIp, setSslIp] = useState("");
  const [sslCertPath, setSslCertPath] = useState("");
  const [sslKeyPath, setSslKeyPath] = useState("");

  // Cloudflare optional
  const [cfEnabled, setCfEnabled] = useState(false);
  const [cfToken, setCfToken] = useState("");
  const [cfEmail, setCfEmail] = useState("");
  const [cfGlobalKey, setCfGlobalKey] = useState("");
  const [cfVerifying, setCfVerifying] = useState(false);
  const [cfVerified, setCfVerified] = useState(false);
  const [cfZones, setCfZones] = useState<CfZone[]>([]);
  const [cfSelectedZoneId, setCfSelectedZoneId] = useState("");
  const [cfSelectedZoneName, setCfSelectedZoneName] = useState("");
  const [cfRecords, setCfRecords] = useState<CfRecord[]>([]);
  const [cfLoadingRecords, setCfLoadingRecords] = useState(false);
  const [cfSubEntries, setCfSubEntries] = useState<CfSubEntry[]>([]);
  const [cfShowToken, setCfShowToken] = useState(false);

  // SSH test
  const [testingSsh, setTestingSsh] = useState(false);
  const [sshTested, setSshTested] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);

  useEffect(() => { fetchStatus(); }, []);

  useEffect(() => {
    if (!restoring) return;
    const id = setInterval(fetchStatus, 1200);
    return () => clearInterval(id);
  }, [restoring]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/restore/status");
      if (res.ok) {
        const data = (await res.json()) as RestoreStatus;
        setStatus(data);
        if (data.status === "running") {
          setRestoring(true);
          setStep("progress");
        } else if (data.status === "success" || data.status === "failed" || data.status === "cancelled") {
          if (restoring) setRestoring(false);
        }
      }
    } catch {}
  }, [restoring]);

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const res = await fetch("/api/restore/backups");
      if (res.ok) {
        const data = await res.json();
        const items: BackupItem[] = [
          ...data.backupRuns.map((r: any) => ({ ...r, fileName: r.fileName, fileSize: r.fileSize, startedAt: r.startedAt })),
          ...data.reassembled.map((r: any) => ({ ...r, name: r.name, size: r.size, createdAt: r.createdAt })),
        ];
        setBackups(items);
      }
    } catch {}
    setBackupsLoading(false);
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/restore/history?limit=30");
      if (res.ok) setHistory(await res.json());
    } catch {}
  }, []);

  const canProceedConnection = sshHost.trim() && sshUser.trim() && (authMethod === "password" ? sshPassword.trim() : sshPrivateKey.trim());

  useEffect(() => {
    setSshTested(false);
    setSshTestResult(null);
  }, [sshHost, sshPort, sshUser, sshPassword, sshPrivateKey, sshPassphrase, authMethod]);

  async function testSshConnection(): Promise<boolean> {
    if (!canProceedConnection) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return false;
    }
    setTestingSsh(true);
    setSshTestResult(null);
    try {
      const res = await fetch("/api/restore/test-ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sshHost: sshHost.trim(),
          sshPort: Number(sshPort) || 22,
          sshUser: sshUser.trim(),
          sshPassword: authMethod === "password" ? sshPassword : undefined,
          sshPrivateKey: authMethod === "key" ? sshPrivateKey : undefined,
          sshPassphrase: authMethod === "key" ? sshPassphrase : undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSshTested(true);
        setSshTestResult({ ok: true, detail: data.detail });
        return true;
      } else {
        setSshTestResult({ ok: false, error: data.error });
        return false;
      }
    } catch {
      setSshTestResult({ ok: false, error: "Network error" });
      return false;
    } finally {
      setTestingSsh(false);
    }
  }

  async function handleConnectionNext() {
    if (!canProceedConnection) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    const ok = await testSshConnection();
    if (!ok) return;
    setStep("panel");
  }

  function handleSelectBackup(item: BackupItem) {
    setSelectedBackup(item);
  }

  // ── Cloudflare helpers - clean, token only, template URL creates token ──
  async function verifyCloudflare() {
    if (!cfToken.trim()) {
      toast({ title: "Enter API Token", variant: "destructive" });
      return;
    }
    setCfVerifying(true);
    setCfVerified(false);
    try {
      const res = await fetch("/api/cloudflare/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cfToken.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setCfZones(data.zones || []);
        setCfVerified(true);
        toast({ title: "Cloudflare verified", description: `${data.zones?.length || 0} domains loaded` });
      } else {
        toast({ title: data.error || "Cloudflare verification failed", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || "Network error", variant: "destructive" });
    } finally {
      setCfVerifying(false);
    }
  }

  async function loadCfRecords(zoneId: string) {
    if (!zoneId) return;
    setCfLoadingRecords(true);
    try {
      const res = await fetch("/api/cloudflare/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cfToken.trim(), zoneId, type: "A" }),
      });
      const data = await res.json();
      if (data.ok) {
        setCfRecords(data.records || []);
      } else {
        toast({ title: data.error || "Failed to load records", variant: "destructive" });
      }
    } catch {}
    setCfLoadingRecords(false);
  }

  async function updateCfDns(entry: CfSubEntry) {
    if (!cfSelectedZoneId || !cfSelectedZoneName || !entry.subName.trim() || !entry.ip.trim()) {
      toast({ title: "Select zone, subdomain and IP", variant: "destructive" });
      return;
    }
    setCfSubEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: "updating" as const } : e)));
    // Safety timeout to avoid stuck spinner
    const timeoutId = setTimeout(() => {
      setCfSubEntries((prev) => prev.map((e) => (e.id === entry.id && e.status === "updating" ? { ...e, status: "failed" as const, detail: "Timeout — try again" } : e)));
    }, 15000);
    try {
      const res = await fetch("/api/cloudflare/update-dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: cfToken.trim(),
          zoneId: cfSelectedZoneId,
          zoneName: cfSelectedZoneName,
          subName: entry.subName.trim(),
          ip: entry.ip.trim(),
          proxied: entry.proxied,
          type: "A",
        }),
      });
      const data = await res.json();
      clearTimeout(timeoutId);
      if (data.ok) {
        setCfSubEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: "done" as const, detail: `${data.action} ${data.record?.name} -> ${data.record?.content}` } : e)));
        toast({ title: `DNS ${data.action}`, description: `${data.record?.name} -> ${data.record?.content}` });
        loadCfRecords(cfSelectedZoneId);
      } else {
        setCfSubEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: "failed" as const, detail: data.error } : e)));
        toast({ title: data.error || "DNS update failed", variant: "destructive" });
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      setCfSubEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: "failed" as const, detail: err?.message ?? "DNS update failed" } : e)));
    }
  }

  async function updateAllCfDns() {
    if (!cfSelectedZoneId || !cfSubEntries.length) {
      toast({ title: "No subdomains to update", variant: "destructive" });
      return;
    }
    for (const entry of cfSubEntries) {
      if (!entry.subName.trim() || !entry.ip.trim()) continue;
      await updateCfDns(entry);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function deleteCfDns(recordId: string) {
    if (!cfSelectedZoneId || !recordId) return;
    try {
      const res = await fetch("/api/cloudflare/delete-dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cfToken.trim(), zoneId: cfSelectedZoneId, recordId }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "DNS record deleted" });
        loadCfRecords(cfSelectedZoneId);
      } else {
        toast({ title: data.error || "Delete failed", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || "Delete failed", variant: "destructive" });
    }
  }

  function addCfSubEntry() {
    const newEntry: CfSubEntry = {
      id: `${Date.now()}-${Math.random()}`,
      subName: "",
      ip: sshHost.trim() || "",
      proxied: false,
      status: "idle",
    };
    setCfSubEntries((prev) => [...prev, newEntry]);
  }

  // ── SSL Multi-domain helpers (now inside SSL Certificate section) ──
  function addSslDomain() {
    const input = sslDomainInput.trim();
    if (!input) {
      // Also try legacy single input
      if (sslDomain.trim()) {
        const single = sslDomain.trim().toLowerCase();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(single) && single.includes(".")) {
          setSslDomains((prev) => Array.from(new Set([...prev, single])));
          setSslDomain("");
          setSslDomainInput("");
          return;
        }
      }
      return;
    }
    const parts = input.split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
    const valid = parts.filter((d) => d.includes(".") && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
    if (!valid.length) {
      toast({ title: "Invalid domain", description: `Got: ${input}`, variant: "destructive" });
      return;
    }
    setSslDomains((prev) => Array.from(new Set([...prev, ...valid])));
    setSslDomainInput("");
    setSslDomain("");
  }

  function removeSslDomain(domain: string) {
    setSslDomains((prev) => prev.filter((d) => d !== domain));
  }

  // ── Start restore ──
  async function startRestore() {
    if (!selectedBackup || !selectedPanel) return;

    setRestoring(true);
    setStep("progress");

    // Merge: sslDomain single + sslDomains array
    const allDomains = Array.from(new Set([...(sslDomain ? [sslDomain.trim()] : []), ...sslDomains].map((d) => d.toLowerCase()).filter(Boolean)));

    try {
      const res = await fetch("/api/restore/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sshHost: sshHost.trim(),
          sshPort: Number(sshPort) || 22,
          sshUser: sshUser.trim(),
          sshPassword: authMethod === "password" ? sshPassword : undefined,
          sshPrivateKey: authMethod === "key" ? sshPrivateKey : undefined,
          sshPassphrase: authMethod === "key" ? sshPassphrase : undefined,
          backupId: selectedBackup.id,
          backupSource: selectedBackup.source,
          panel: selectedPanel,
          installNode: installNode,
          sslMode: enableSsl ? sslMode : allDomains.length ? "domain" : "none",
          sslDomain: allDomains[0] || sslDomain.trim() || undefined,
          sslDomains: allDomains.length > 1 ? allDomains : allDomains.length === 1 ? allDomains : undefined,
          sslIp: sslIp.trim() || undefined,
          sslCertPath: sslCertPath.trim() || undefined,
          sslKeyPath: sslKeyPath.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: data.error === "RESTORE_ALREADY_RUNNING" ? "A restore is already running" : data.error || "Error",
          variant: "destructive",
        });
        setRestoring(false);
        setStep("confirm");
        return;
      }
      fetchStatus();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
      setRestoring(false);
      setStep("confirm");
    }
  }

  // Prefill the wizard from a past (failed/cancelled) job — only connection
  // details are restored; credentials are never stored, so the user re-enters
  // the password/key and re-tests before the wizard can move on.
  function retryJob(job: any) {
    resetWizard();
    setSelectedPanel((job.panel as PanelId) ?? null);
    setSshHost(job.sshHost ?? "");
    setSshPort(String(job.sshPort ?? 22));
    setSshUser(job.sshUser || "root");
    setAuthMethod("password");
    setShowHistory(false);
    toast({ title: t("restore_retry_loaded"), description: t("restore_retry_hint") });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetWizard() {
    setStep("connection");
    setRestoring(false);
    setStatus(null);
    setSelectedBackup(null);
    setSelectedPanel(null);
    setInstallNode(false);
    setEnableSsl(false);
    setSslMode("none");
    setSslDomain("");
    setSslDomains([]);
    setSslDomainInput("");
    setSslIp("");
    setSslCertPath("");
    setSslKeyPath("");
    setSshHost("");
    setSshPort("22");
    setSshUser("root");
    setSshPassword("");
    setSshPrivateKey("");
    setSshPassphrase("");
    setSshTested(false);
    setSshTestResult(null);
    setCfEnabled(false);
    setCfToken("");
    setCfEmail("");
    setCfGlobalKey("");
    setCfVerified(false);
    setCfZones([]);
    setCfSelectedZoneId("");
    setCfSelectedZoneName("");
    setCfRecords([]);
    setCfSubEntries([]);
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const filteredBackups = selectedPanel ? backups.filter(b => b.panel === selectedPanel) : backups;

  return (
    <div className="w-full space-y-4 sm:space-y-5">
      <Card className="w-full overflow-hidden">
        <CardHeader className="p-4 sm:p-6 space-y-3">
          <div className="min-w-0">
            <CardTitle className="flex items-start gap-2 text-[15px] sm:text-lg leading-tight">
              <RotateCcw className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="break-words">{t("restore_title")}</span>
            </CardTitle>
            <CardDescription className="mt-1.5 max-w-3xl text-[11px] sm:text-sm leading-relaxed break-words">{t("restore_desc")}</CardDescription>
          </div>
          <div className="flex w-full pt-1">
            <Button variant="outline" size="sm" className="h-9 w-full gap-1.5 justify-center" onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory(); }}>
              <History className="h-3.5 w-3.5" />
              {t("restore_history")}
            </Button>
          </div>
        </CardHeader>
      </Card>

      {showHistory && <RestoreHistoryCard history={history} onRefresh={loadHistory} onRetry={retryJob} />}

      {step === "progress" && status ? (
        <ProgressView status={status} onReset={resetWizard} />
      ) : (
        <>
          <StepIndicator currentStep={step} />

          {step === "connection" && (
            <ConnectionStep
              sshHost={sshHost} setSshHost={setSshHost}
              sshPort={sshPort} setSshPort={setSshPort}
              sshUser={sshUser} setSshUser={setSshUser}
              authMethod={authMethod} setAuthMethod={setAuthMethod}
              sshPassword={sshPassword} setSshPassword={setSshPassword}
              sshPrivateKey={sshPrivateKey} setSshPrivateKey={setSshPrivateKey}
              sshPassphrase={sshPassphrase} setSshPassphrase={setSshPassphrase}
              testingSsh={testingSsh}
              sshTested={sshTested}
              sshTestResult={sshTestResult}
            />
          )}

          {step === "panel" && (
            <PanelSelectStep
              selected={selectedPanel}
              onSelect={(p) => {
                setSelectedPanel(p);
                setSelectedBackup(null);
                if (backups.length === 0) loadBackups();
              }}
              installNode={installNode}
              setInstallNode={setInstallNode}
              enableSsl={enableSsl}
              setEnableSsl={setEnableSsl}
              sslMode={sslMode}
              setSslMode={setSslMode}
              sslDomain={sslDomain}
              setSslDomain={setSslDomain}
              sslDomains={sslDomains}
              setSslDomains={setSslDomains}
              sslDomainInput={sslDomainInput}
              setSslDomainInput={setSslDomainInput}
              onAddDomain={addSslDomain}
              onRemoveDomain={removeSslDomain}
              sslIp={sslIp}
              setSslIp={setSslIp}
              sslCertPath={sslCertPath}
              setSslCertPath={setSslCertPath}
              sslKeyPath={sslKeyPath}
              setSslKeyPath={setSslKeyPath}
              sshHost={sshHost}
            />
          )}

          {step === "cloudflare" && (
            <CloudflareStep
              sshHost={sshHost}
              enabled={cfEnabled}
              setEnabled={setCfEnabled}
              token={cfToken}
              setToken={setCfToken}
              verifying={cfVerifying}
              verified={cfVerified}
              zones={cfZones}
              selectedZoneId={cfSelectedZoneId}
              selectedZoneName={cfSelectedZoneName}
              onSelectZone={(id, name) => {
                if (!id) {
                  setCfSelectedZoneId("");
                  setCfSelectedZoneName("");
                  setCfRecords([]);
                  return;
                }
                setCfSelectedZoneId(id);
                setCfSelectedZoneName(name);
                loadCfRecords(id);
              }}
              records={cfRecords}
              loadingRecords={cfLoadingRecords}
              subEntries={cfSubEntries}
              setSubEntries={setCfSubEntries}
              onAddSub={addCfSubEntry}
              onUpdateDns={updateCfDns}
              onUpdateAll={updateAllCfDns}
              onDeleteDns={deleteCfDns}
              onVerify={verifyCloudflare}
              showToken={cfShowToken}
              setShowToken={setCfShowToken}
            />
          )}

          {step === "select" && (
            <SelectBackupStep
              backups={filteredBackups}
              allBackups={backups}
              loading={backupsLoading}
              onLoad={loadBackups}
              selected={selectedBackup}
              onSelect={handleSelectBackup}
              selectedPanel={selectedPanel}
            />
          )}

          {step === "confirm" && (
            <ConfirmStep
              sshHost={sshHost} sshPort={sshPort} sshUser={sshUser}
              backup={selectedBackup} panel={selectedPanel}
              installNode={installNode}
              enableSsl={enableSsl}
              sslMode={sslMode} sslDomain={sslDomain} sslDomains={sslDomains} sslIp={sslIp}
              cfEnabled={cfEnabled}
              cfZoneName={cfSelectedZoneName}
              cfSubEntries={cfSubEntries}
            />
          )}

          {step !== "progress" && (
            <div className="flex w-full items-center justify-between gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  if (stepIndex > 0) setStep(STEP_ORDER[Math.max(0, stepIndex - 1)]);
                }}
                disabled={stepIndex === 0}
                className="gap-1.5"
                size="sm"
              >
                <ChevronLeft className="h-4 w-4" />
                {t("restore_back")}
              </Button>

              {step === "confirm" ? (
                <Button onClick={startRestore} disabled={!canProceedConnection || !selectedBackup || !selectedPanel} className="gap-1.5" size="sm">
                  <Rocket className="h-4 w-4" />
                  {t("restore_start")}
                </Button>
              ) : step === "connection" ? (
                <Button
                  onClick={handleConnectionNext}
                  disabled={!canProceedConnection || testingSsh}
                  className="gap-1.5"
                  size="sm"
                >
                  {testingSsh ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Testing connection...
                    </>
                  ) : (
                    <>
                      {t("restore_next")}
                      <ChevronRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    if (step === "panel" && !selectedPanel) {
                      toast({ title: "Please select a panel type", variant: "destructive" });
                      return;
                    }
                    if (stepIndex < STEP_ORDER.length - 1) {
                      setStep(STEP_ORDER[stepIndex + 1]);
                      if (STEP_ORDER[stepIndex + 1] === "select" && backups.length === 0) loadBackups();
                    }
                  }}
                  disabled={
                    (step === "panel" && !selectedPanel) ||
                    (step === "select" && !selectedBackup)
                  }
                  className="gap-1.5"
                  size="sm"
                >
                  {step === "cloudflare" ? (
                    <>{t("restore_next")} / Skip</>
                  ) : (
                    <>{t("restore_next")}</>
                  )}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Step Indicator ──
function StepIndicator({ currentStep }: { currentStep: Step }) {
  const { t } = useLang();
  const steps: { key: Step; label: string; icon: React.ReactNode }[] = [
    { key: "connection", label: t("restore_step_connection"), icon: <Wifi className="h-3.5 w-3.5" /> },
    { key: "panel", label: t("restore_step_panel"), icon: <Boxes className="h-3.5 w-3.5" /> },
    { key: "cloudflare", label: t("restore_step_cloudflare"), icon: <Cloud className="h-3.5 w-3.5" /> },
    { key: "select", label: t("restore_step_select"), icon: <DatabaseBackup className="h-3.5 w-3.5" /> },
    { key: "confirm", label: t("restore_step_confirm"), icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  ];
  const currentIdx = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="flex w-full items-center gap-1 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <div key={s.key} className="flex shrink-0 items-center gap-1">
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium sm:px-3 ${
              i === currentIdx
                ? "bg-primary text-primary-foreground"
                : i < currentIdx
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i < currentIdx ? <CheckCircle2 className="h-3 w-3" /> : s.icon}
            <span className="whitespace-nowrap">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-3 sm:w-6 ${i < currentIdx ? "bg-primary/40" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Connection Step ──
function ConnectionStep(props: {
  sshHost: string; setSshHost: (v: string) => void;
  sshPort: string; setSshPort: (v: string) => void;
  sshUser: string; setSshUser: (v: string) => void;
  authMethod: AuthMethod; setAuthMethod: (v: AuthMethod) => void;
  sshPassword: string; setSshPassword: (v: string) => void;
  sshPrivateKey: string; setSshPrivateKey: (v: string) => void;
  sshPassphrase: string; setSshPassphrase: (v: string) => void;
  testingSsh: boolean;
  sshTested: boolean;
  sshTestResult: { ok: boolean; detail?: string; error?: string } | null;
}) {
  const { t } = useLang();
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Server className="h-4 w-4 shrink-0" />
          {t("restore_step_connection")}
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Enter the SSH credentials of the target server where the backup will be restored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid w-full gap-3 sm:gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ssh-host" className="text-xs sm:text-sm">{t("restore_ssh_host")}</Label>
            <Input id="ssh-host" value={props.sshHost} onChange={(e) => props.setSshHost(e.target.value)} placeholder={t("restore_ssh_host_ph")} dir="ltr" className="h-9 sm:h-10" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssh-port" className="text-xs sm:text-sm">{t("restore_ssh_port")}</Label>
            <Input id="ssh-port" type="number" value={props.sshPort} onChange={(e) => props.setSshPort(e.target.value)} dir="ltr" className="h-9 sm:h-10" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ssh-user" className="text-xs sm:text-sm">{t("restore_ssh_user")}</Label>
          <Input id="ssh-user" value={props.sshUser} onChange={(e) => props.setSshUser(e.target.value)} placeholder={t("restore_ssh_user_ph")} dir="ltr" className="h-9 sm:h-10" />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">{t("restore_ssh_auth")}</Label>
          <RadioGroup value={props.authMethod} onValueChange={(v) => props.setAuthMethod(v as AuthMethod)} className="grid grid-cols-2 gap-2">
            <Label htmlFor="auth-password" className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${props.authMethod === "password" ? "border-primary bg-primary/5" : ""}`}>
              <RadioGroupItem id="auth-password" value="password" />
              <Lock className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              {t("restore_auth_password")}
            </Label>
            <Label htmlFor="auth-key" className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${props.authMethod === "key" ? "border-primary bg-primary/5" : ""}`}>
              <RadioGroupItem id="auth-key" value="key" />
              <Key className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              {t("restore_auth_key")}
            </Label>
          </RadioGroup>
        </div>
        {props.authMethod === "password" ? (
          <div className="space-y-1.5">
            <Label htmlFor="ssh-password" className="text-xs sm:text-sm">{t("restore_ssh_password")}</Label>
            <Input id="ssh-password" type="password" value={props.sshPassword} onChange={(e) => props.setSshPassword(e.target.value)} dir="ltr" className="h-9 sm:h-10" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ssh-key" className="text-xs sm:text-sm">{t("restore_ssh_key")}</Label>
              <Textarea id="ssh-key" value={props.sshPrivateKey} onChange={(e) => props.setSshPrivateKey(e.target.value)} placeholder={t("restore_ssh_key_ph")} className="min-h-[80px] font-mono text-xs sm:min-h-[100px]" dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-passphrase" className="text-xs sm:text-sm">{t("restore_ssh_passphrase")}</Label>
              <Input id="ssh-passphrase" type="password" value={props.sshPassphrase} onChange={(e) => props.setSshPassphrase(e.target.value)} placeholder={t("restore_ssh_passphrase_ph")} dir="ltr" className="h-9 sm:h-10" />
            </div>
          </div>
        )}
        {props.sshTestResult && (
          <div className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${props.sshTestResult.ok ? "border-green-500/30 bg-green-500/10 text-green-600" : "border-red-500/30 bg-red-500/10 text-red-600"}`}>
            {props.sshTestResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span className="break-words">{props.sshTestResult.ok ? (props.sshTestResult.detail || t("restore_conn_ok")) : (props.sshTestResult.error || t("restore_conn_fail"))}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Panel Select with Multi-Domain SSL Certificate inside ──
function PanelSelectStep({
  selected, onSelect, installNode, setInstallNode,
  enableSsl, setEnableSsl,
  sslMode, setSslMode, sslDomain, setSslDomain,
  sslDomains, setSslDomains,
  sslDomainInput, setSslDomainInput,
  onAddDomain, onRemoveDomain,
  sslIp, setSslIp, sslCertPath, setSslCertPath, sslKeyPath, setSslKeyPath,
  sshHost,
}: {
  selected: PanelId | null;
  onSelect: (p: PanelId) => void;
  installNode: boolean;
  setInstallNode: (v: boolean) => void;
  enableSsl: boolean;
  setEnableSsl: (v: boolean) => void;
  sslMode: "none" | "domain" | "ip" | "custom";
  setSslMode: (v: "none" | "domain" | "ip" | "custom") => void;
  sslDomain: string;
  setSslDomain: (v: string) => void;
  sslDomains: string[];
  setSslDomains: (v: string[] | ((prev: string[]) => string[])) => void;
  sslDomainInput: string;
  setSslDomainInput: (v: string) => void;
  onAddDomain: () => void;
  onRemoveDomain: (d: string) => void;
  sslIp: string;
  setSslIp: (v: string) => void;
  sslCertPath: string;
  setSslCertPath: (v: string) => void;
  sslKeyPath: string;
  setSslKeyPath: (v: string) => void;
  sshHost: string;
}) {
  const { t } = useLang();
  const selectedOpt = selected ? PANEL_OPTIONS.find((p) => p.value === selected) : null;
  const allDomains = Array.from(new Set([...(sslDomain ? [sslDomain] : []), ...sslDomains].map((d) => d.toLowerCase()).filter(Boolean)));

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Boxes className="h-4 w-4 shrink-0" />
          {t("restore_select_panel")}
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          First select the panel type. Then only backups for that panel will be shown — 3X / HM / PG / RB tags.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid w-full gap-2.5 sm:gap-3 sm:grid-cols-2 lg:grid-cols-2">
          {PANEL_OPTIONS.map((opt) => {
            const isSelected = selected === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onSelect(opt.value)}
                className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left sm:gap-3 sm:p-4 ${isSelected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "bg-card hover:bg-muted"}`}
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {opt.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold sm:text-sm">{t(opt.labelKey)}</span>
                    <Badge variant="outline" className="text-[8px]">{opt.tag}</Badge>
                    {isSelected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />}
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground sm:text-xs">{t(opt.descKey)}</p>
                </div>
              </button>
            );
          })}
        </div>

        {selectedOpt?.hasNode && (
          <div className="flex w-full items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4">
            <Checkbox id="install-node" checked={installNode} onCheckedChange={(v) => setInstallNode(v === true)} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <Label htmlFor="install-node" className="flex cursor-pointer items-center gap-1.5 text-xs font-medium sm:text-sm">
                <Network className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Also install panel node
              </Label>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground sm:text-xs">
                {selectedOpt.value === "pasarguard" ? "Install the PasarGuard node component alongside the panel." : "Install the Rebecca node component alongside the panel."}
              </p>
            </div>
          </div>
        )}

        {selected && (
          <div className="w-full space-y-3 rounded-xl border p-3 sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-semibold sm:text-sm flex items-center gap-1.5">
                <Shield className="h-4 w-4" />
                SSL Certificate (optional) — multi-domain SAN support for {selectedOpt?.tag}
                {allDomains.length > 0 && <Badge className="bg-green-500/15 text-green-600 text-[9px] ml-1">{allDomains.length} domains</Badge>}
              </Label>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-[10px] sm:text-xs"
                onClick={() => {
                  const next = !enableSsl;
                  setEnableSsl(next);
                  if (!next) setSslMode("none");
                  else if (sslMode === "none") setSslMode("domain");
                }}
              >
                {enableSsl ? <><EyeOff className="h-3 w-3" /> Hide</> : <><Eye className="h-3 w-3" /> Show SSL options</>}
              </Button>
            </div>

            {!enableSsl ? (
              <p className="text-[10px] text-muted-foreground sm:text-xs">
                SSL is disabled — panel will be installed with HTTP. Click &quot;Show SSL options&quot; if you want to set domain(s) for certificate during install. You can add multiple domains (comma, space, newline separated) — they will be issued as SAN cert via acme.sh standalone and applied correctly for all 4 panels.
              </p>
            ) : (
              <>
                <p className="text-[10px] text-muted-foreground sm:text-xs">
                  {selected === "3x-ui" ? "For 3x-ui: None fixes Not Running, Domain/IP gets Let's Encrypt cert (needs port 80). Multi-domain SAN supported." : selected === "hmpanel" ? "For HMPanel: Domains will be used as panel domain (first is primary). Multi-domain SAN cert copied to /opt/hmpanel/nginx/ssl/ and nginx restarted." : "For PasarGuard/Rebecca: Domain enables SSL with --ssl --ssl-domain, otherwise --no-ssl. Multi-domain SAN cert copied to certs/ and compose restarted."}
                </p>
                <RadioGroup value={sslMode} onValueChange={(v) => setSslMode(v as any)} className="grid gap-2">
                  <Label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${sslMode === "none" ? "border-primary bg-primary/5" : ""}`}>
                    <RadioGroupItem value="none" />
                    None (HTTP) — recommended for restore
                  </Label>
                  <Label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${sslMode === "domain" ? "border-primary bg-primary/5" : ""}`}>
                    <RadioGroupItem value="domain" />
                    Domain(s) — Let's Encrypt multi-domain SAN (recommended)
                  </Label>
                  <Label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${sslMode === "ip" ? "border-primary bg-primary/5" : ""}`}>
                    <RadioGroupItem value="ip" />
                    IP {selected === "3x-ui" ? "— Let's Encrypt IP cert" : ""}
                  </Label>
                  <Label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs sm:text-sm ${sslMode === "custom" ? "border-primary bg-primary/5" : ""}`}>
                    <RadioGroupItem value="custom" />
                    Custom cert files
                  </Label>
                </RadioGroup>

                {sslMode === "domain" && (
                  <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
                    <Label className="text-xs font-semibold flex items-center gap-1.5">
                      <Globe className="h-4 w-4" />
                      Domains for certificate (SAN) — multi-domain supported
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        value={sslDomainInput}
                        onChange={(e) => setSslDomainInput(e.target.value)}
                        placeholder="panel.example.com, www.example.com, api.example.com"
                        dir="ltr"
                        className="h-9 flex-1 text-xs font-mono"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAddDomain(); } }}
                      />
                      <Button size="sm" className="h-9 gap-1" onClick={onAddDomain}>
                        <Plus className="h-4 w-4" />
                        Add
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Enter domains separated by comma, space or newline. Press Enter or Add. First domain will be primary CN, rest as SAN. Cert issued via acme.sh standalone on port 80 and applied correctly for all 4 panels.</p>

                    {allDomains.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {allDomains.map((d) => (
                          <Badge key={d} variant="outline" className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-card" dir="ltr">
                            {d}
                            <button onClick={() => onRemoveDomain(d)} className="ml-1 rounded-full p-0.5 hover:bg-muted">
                              <XCircle className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground pt-1">No domains added yet — e.g. panel.example.com, www.example.com. Use Cloudflare step before this to point DNS to {sshHost || "target IP"}.</p>
                    )}
                  </div>
                )}
                {sslMode === "ip" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">IP address (leave empty to auto-detect)</Label>
                    <Input value={sslIp} onChange={(e) => setSslIp(e.target.value)} placeholder="auto" dir="ltr" className="h-9" />
                  </div>
                )}
                {sslMode === "custom" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Cert file path</Label>
                      <Input value={sslCertPath} onChange={(e) => setSslCertPath(e.target.value)} placeholder="/root/cert/fullchain.pem" dir="ltr" className="h-9" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Key file path</Label>
                      <Input value={sslKeyPath} onChange={(e) => setSslKeyPath(e.target.value)} placeholder="/root/cert/privkey.pem" dir="ltr" className="h-9" />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function CloudflareStep({
  sshHost, enabled, setEnabled,
  token, setToken,
  verifying, verified, zones, selectedZoneId, selectedZoneName, onSelectZone,
  records, loadingRecords, subEntries, setSubEntries, onAddSub, onUpdateDns, onUpdateAll, onDeleteDns, onVerify,
  showToken, setShowToken,
}: {
  sshHost: string;
  enabled: boolean; setEnabled: (v: boolean) => void;
  token: string; setToken: (v: string) => void;
  verifying: boolean; verified: boolean;
  zones: CfZone[]; selectedZoneId: string; selectedZoneName: string;
  onSelectZone: (id: string, name: string) => void;
  records: CfRecord[]; loadingRecords: boolean;
  subEntries: CfSubEntry[]; setSubEntries: (v: CfSubEntry[] | ((prev: CfSubEntry[]) => CfSubEntry[])) => void;
  onAddSub: () => void;
  onUpdateDns: (entry: CfSubEntry) => void;
  onUpdateAll?: () => void;
  onDeleteDns?: (recordId: string) => void;
  onVerify: () => void;
  showToken: boolean; setShowToken: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (recordId: string) => {
    if (!onDeleteDns) return;
    setDeletingId(recordId);
    await onDeleteDns(recordId);
    setDeletingId(null);
  };

  return (
    <Card className="w-full overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Cloud className="h-4 w-4 shrink-0" />
          Cloudflare DNS
          <Badge variant="outline" className="text-[9px]">Optional</Badge>
          {enabled && verified && <Badge className="bg-green-500/15 text-green-600 text-[9px]">Connected</Badge>}
        </CardTitle>
        <CardDescription className="text-xs">
          Manage DNS to point subdomains to {sshHost || "target IP"}. Skip if not needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Toggle switch - using Switch component for reliable ON/OFF */}
        <div className="flex items-center justify-between rounded-lg border p-3 bg-card">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-medium">Enable Cloudflare DNS</Label>
              {enabled ? <Badge className="bg-green-500 text-white text-[10px] h-5 px-2">ON</Badge> : <Badge variant="outline" className="text-[10px] h-5 px-2">OFF</Badge>}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Update A records in Cloudflare to {sshHost || "target IP"}.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <Switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} aria-label="Toggle Cloudflare" />
          </div>
        </div>

        {!enabled ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <Cloud className="mx-auto h-6 w-6 opacity-30" />
            <p className="mt-2 text-xs text-muted-foreground">Disabled — click Next/Skip.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Token input - single box */}
            <div className="rounded-lg border p-3 space-y-2.5 bg-card">
              <Label className="text-xs font-medium flex items-center gap-1.5">
                <Key className="h-3.5 w-3.5" />
                API Token
              </Label>
              <div className="flex gap-2">
                <div className="relative flex-1 min-w-0">
                  <Input id="cf-token-input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste Cloudflare API token" dir="ltr" type={showToken ? "text" : "password"} className="h-9 pr-8 font-mono text-xs" />
                  <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-9 w-8" onClick={() => setShowToken(!showToken)}>
                    {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => {
                    const url = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=bkup";
                    window.open(url, "_blank");
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Create via template URL
                </Button>
                <Button onClick={onVerify} disabled={verifying || !token.trim()} size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                  {verifying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying</> : <><Cloud className="h-3.5 w-3.5" /> Verify & Load Domains</>}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Template URL creates token with Zone:Read + DNS:Edit for all zones. Copy token, paste here, then Verify.</p>

              {verified && (
                <div className="flex items-center gap-1.5 rounded bg-green-500/10 p-2 text-[11px] text-green-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {zones.length} domains loaded
                </div>
              )}
            </div>

            {/* Single box for domains OR subdomains - no clutter of multiple boxes */}
            {verified && zones.length > 0 && (
              <div className="rounded-lg border bg-card overflow-hidden">
                {!selectedZoneId ? (
                  // Domain list view
                  <div className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium">Domains ({zones.length}) — select one</Label>
                      <Badge variant="outline" className="text-[9px]">{zones.length}</Badge>
                    </div>
                    <div className="grid gap-1.5 max-h-[260px] overflow-y-auto pr-1">
                      {zones.map((z) => (
                        <button
                          key={z.id}
                          onClick={() => onSelectZone(z.id, z.name)}
                          className="flex items-center justify-between rounded-md border px-3 py-2.5 text-left text-xs hover:bg-muted transition-colors bg-card"
                        >
                          <span className="truncate font-mono" dir="ltr">{z.name}</span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-2" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  // Subdomain view inside same box
                  <div className="p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs shrink-0" onClick={() => onSelectZone("", "")}>
                        <ChevronLeft className="h-3.5 w-3.5" />
                        Back
                      </Button>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate" dir="ltr">{selectedZoneName}</div>
                        <div className="text-[10px] text-muted-foreground">{records.length} A records</div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 gap-1 text-[10px] shrink-0 px-2" onClick={() => onSelectZone(selectedZoneId, selectedZoneName)} disabled={loadingRecords}>
                        <RefreshCw className={`h-3 w-3 ${loadingRecords ? "animate-spin" : ""}`} />
                        Reload
                      </Button>
                    </div>

                    {loadingRecords ? (
                      <div className="space-y-1.5">
                        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                      </div>
                    ) : records.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground py-4 text-center">No A records — add new below.</p>
                    ) : (
                      <div className="space-y-1 max-h-[200px] overflow-y-auto pr-1">
                        {records.map((r) => (
                          <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[11px]" dir="ltr">{r.name}</div>
                              <div className="font-mono text-[10px] text-muted-foreground truncate" dir="ltr">{r.content} {r.proxied ? "• Proxied" : ""}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button variant="outline" size="sm" className="h-7 gap-1 text-[10px] px-2" onClick={() => {
                                setSubEntries((prev: any) => {
                                  const exists = prev.find((e: any) => e.subName === r.name);
                                  if (exists) {
                                    // If exists, scroll to it with soft motion
                                    setTimeout(() => {
                                      const el = document.getElementById(`subentry-${exists.id}`);
                                      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                                    }, 100);
                                    return prev;
                                  }
                                  const newId = `${Date.now()}`;
                                  // Smooth scroll to bottom section after adding
                                  setTimeout(() => {
                                    const container = document.getElementById("to-update-section");
                                    if (container) container.scrollIntoView({ behavior: "smooth", block: "start" });
                                    const el = document.getElementById(`subentry-${newId}`);
                                    if (el) {
                                      el.style.opacity = "0";
                                      el.style.transform = "translateY(4px)";
                                      el.style.transition = "opacity 250ms ease, transform 250ms ease";
                                      requestAnimationFrame(() => {
                                        el.style.opacity = "1";
                                        el.style.transform = "translateY(0)";
                                      });
                                    }
                                  }, 150);
                                  return [...prev, { id: newId, subName: r.name, ip: sshHost || r.content, proxied: r.proxied, status: "idle" }];
                                });
                              }}>
                                <Plus className="h-3 w-3" />
                                Select
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={deletingId === r.id} onClick={() => handleDelete(r.id)}>
                                {deletingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 text-red-500" />}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div id="to-update-section" className="border-t pt-3 space-y-2.5 scroll-mt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-[11px] font-medium">To update to {sshHost || "target IP"}</Label>
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="outline" size="sm" className="h-7 text-[10px] px-2.5 gap-1" onClick={onAddSub}>
                            <Plus className="h-3 w-3" /> Add
                          </Button>
                          <Button variant="outline" size="sm" className="h-7 text-[10px] px-2.5 gap-1" onClick={() => setSubEntries((prev: any) => prev.map((e: any) => ({ ...e, ip: sshHost || e.ip })))}>
                            Fill IP
                          </Button>
                          {subEntries.length > 1 && onUpdateAll && (
                            <Button size="sm" className="h-7 text-[10px] px-2.5 gap-1" onClick={() => onUpdateAll()}>
                              Update all ({subEntries.length})
                            </Button>
                          )}
                        </div>
                      </div>

                      {subEntries.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground">No subdomain selected. Select from list above or Add.</p>
                      ) : (
                        <div className="space-y-2">
                          {subEntries.map((entry) => (
                            <div id={`subentry-${entry.id}`} key={entry.id} className="rounded-md border p-2.5 space-y-2 bg-card transition-all duration-200">
                              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                                <div className="min-w-0">
                                  <Label className="text-[9px] text-muted-foreground">Subdomain</Label>
                                  <Input value={entry.subName} onChange={(e) => setSubEntries((prev: any) => prev.map((en: any) => en.id === entry.id ? { ...en, subName: e.target.value } : en))} placeholder="panel or @" dir="ltr" className="h-7 text-xs font-mono mt-0.5" />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-[9px] text-muted-foreground">IP</Label>
                                  <Input value={entry.ip} onChange={(e) => setSubEntries((prev: any) => prev.map((en: any) => en.id === entry.id ? { ...en, ip: e.target.value } : en))} placeholder={sshHost || "1.2.3.4"} dir="ltr" className="h-7 text-xs font-mono mt-0.5" />
                                </div>
                                <div className="flex items-end gap-1.5">
                                  <label className="flex items-center gap-1 h-7 px-1.5 cursor-pointer">
                                    <Checkbox checked={entry.proxied} onCheckedChange={(v) => setSubEntries((prev: any) => prev.map((en: any) => en.id === entry.id ? { ...en, proxied: v === true } : en))} />
                                    <span className="text-[10px]">Proxied</span>
                                  </label>
                                  <Button size="sm" className="h-7 text-[10px] px-3 gap-1" onClick={() => onUpdateDns(entry)} disabled={entry.status === "updating"}>
                                    {entry.status === "updating" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                    Update
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setSubEntries((prev: any) => prev.filter((en: any) => en.id !== entry.id))} title="Remove">
                                    <XCircle className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                              {entry.detail && (
                                <div className={`text-[10px] break-all ${entry.status === "failed" ? "text-red-600" : "text-green-600"}`}>{entry.detail}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}





// ── Select Backup ──
function SelectBackupStep({
  backups, allBackups, loading, onLoad, selected, onSelect, selectedPanel,
}: {
  backups: BackupItem[];
  allBackups: BackupItem[];
  loading: boolean;
  onLoad: () => void;
  selected: BackupItem | null;
  onSelect: (item: BackupItem) => void;
  selectedPanel: PanelId | null;
}) {
  const { t } = useLang();
  useEffect(() => { if (allBackups.length === 0) onLoad(); }, []);
  const panelBadge = (panel: string) => panel === "hmpanel" ? "HM" : panel === "pasarguard" ? "PG" : panel === "rebecca" ? "RB" : "3X";
  const selectedTag = selectedPanel ? PANEL_OPTIONS.find(p => p.value === selectedPanel)?.tag : null;

  return (
    <Card className="w-full overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <DatabaseBackup className="h-4 w-4 shrink-0" />
            <span className="truncate">{selectedPanel ? `Backups for ${selectedTag} (${selectedPanel})` : t("restore_select_backup")}</span>
          </CardTitle>
          <CardDescription className="text-[10px] sm:text-xs mt-1">
            {selectedPanel ? `Only showing backups tagged ${selectedTag}. Total ${allBackups.length} backups, ${backups.length} match.` : `All backups — select panel first to filter.`}
          </CardDescription>
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onLoad} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="w-full">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : backups.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">{selectedPanel ? `No backups for ${selectedTag}` : t("restore_no_backups")}</p>
            <p className="mt-1 text-xs">{selectedPanel ? `No ${selectedPanel} backups found.` : t("restore_no_backups_desc")}</p>
          </div>
        ) : (
          <div className="max-h-[55vh] w-full overflow-y-auto overflow-x-hidden sm:max-h-[60vh] lg:max-h-[65vh]">
            <div className="space-y-2 pr-1">
              {backups.map((item, i) => {
                const isSelected = selected?.id === item.id && selected?.source === item.source;
                const fileName = item.fileName || item.name || `#${item.id}`;
                const size = item.fileSize ?? item.size ?? null;
                const time = item.startedAt || item.createdAt;
                return (
                  <button
                    key={`${item.source}-${item.id}-${i}`}
                    onClick={() => onSelect(item)}
                    className={`flex w-full max-w-full items-center gap-2.5 overflow-hidden rounded-xl border p-2.5 text-left sm:gap-3 sm:p-3 ${isSelected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "bg-card hover:bg-muted"}`}
                  >
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                      <DatabaseBackup className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex w-full items-center gap-1.5 overflow-hidden">
                        <span className="block max-w-full truncate text-xs font-medium sm:text-sm" dir="ltr" title={fileName}>{fileName}</span>
                        {isSelected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />}
                      </div>
                      <div className="mt-1 flex w-full flex-wrap items-center gap-1 text-[10px] text-muted-foreground sm:text-xs">
                        <Badge variant="outline" className="shrink-0 text-[9px] uppercase sm:text-[10px]">{panelBadge(item.panel)}</Badge>
                        {item.source === "reassembled" && (
                          <Badge variant="outline" className="shrink-0 border-primary/40 text-[9px] uppercase text-primary sm:text-[10px]">
                            <Combine className="me-1 h-2.5 w-2.5" />
                            {t("restore_badge_reassembled")}
                          </Badge>
                        )}
                        {time != null && <TimeAgo date={time} className="shrink-0" />}
                        {size != null && <><span className="shrink-0">·</span><span className="shrink-0 tabular-nums">{formatBytes(size)}</span></>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Confirm ──
function ConfirmStep({
  sshHost, sshPort, sshUser, backup, panel, installNode,
  enableSsl, sslMode, sslDomain, sslDomains, sslIp,
  cfEnabled, cfZoneName, cfSubEntries,
}: {
  sshHost: string; sshPort: string; sshUser: string;
  backup: BackupItem | null; panel: PanelId | null;
  installNode: boolean;
  enableSsl: boolean;
  sslMode: "none" | "domain" | "ip" | "custom";
  sslDomain: string; sslDomains: string[]; sslIp: string;
  cfEnabled: boolean; cfZoneName: string; cfSubEntries: CfSubEntry[];
}) {
  const { t } = useLang();
  const panelLabel = panel ? PANEL_OPTIONS.find((p) => p.value === panel)?.labelKey : null;
  const fileName = backup?.fileName || backup?.name || "—";
  const tag = panel ? PANEL_OPTIONS.find(p => p.value === panel)?.tag : "";

  const allDomains = Array.from(new Set([...(sslDomain ? [sslDomain] : []), ...sslDomains].map((d) => d.toLowerCase()).filter(Boolean)));

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t("restore_step_confirm")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid w-full gap-2.5 sm:gap-3 sm:grid-cols-2">
          <ReviewItem icon={<Server className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label={t("restore_review_ssh")}>
            <span className="break-all font-mono text-[11px] sm:text-xs" dir="ltr">{sshUser}@{sshHost}:{sshPort}</span>
          </ReviewItem>
          <ReviewItem icon={<DatabaseBackup className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label={t("restore_review_backup")}>
            <span className="block max-w-full truncate text-[11px] font-medium sm:text-xs" dir="ltr" title={fileName}>{fileName}</span>
          </ReviewItem>
          <ReviewItem icon={<Boxes className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label={t("restore_review_panel")}>
            <span className="flex items-center gap-1.5">{panelLabel ? t(panelLabel) : "—"} <Badge variant="outline" className="text-[8px]">{tag}</Badge></span>
          </ReviewItem>
          <ReviewItem icon={<ShieldCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="SSL Certificate (multi-domain)">
            <span className="text-[11px] sm:text-xs break-all">
              {allDomains.length ? `${allDomains.length} domains: ${allDomains.join(", ")}` : !enableSsl || sslMode === "none" ? "None (HTTP)" : sslMode === "domain" ? `Domain: ${sslDomain || "auto"}` : sslMode === "ip" ? `IP: ${sslIp || "auto"}` : "Custom cert"}
            </span>
          </ReviewItem>
          {installNode && (panel === "pasarguard" || panel === "rebecca") && (
            <ReviewItem icon={<Network className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Node">
              <span className="text-[11px] font-medium text-primary sm:text-xs">Will install node too</span>
            </ReviewItem>
          )}
          <div className="sm:col-span-2">
            <ReviewItem icon={<Cloud className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Cloudflare">
              <span className="text-[11px] sm:text-xs">
                {cfEnabled ? `Enabled — ${cfZoneName || "no zone"} — ${cfSubEntries.filter((e) => e.status === "done").length}/${cfSubEntries.length} DNS updated to ${sshHost} in Cloudflare` : "Skipped"}
              </span>
            </ReviewItem>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}


function ReviewItem({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="w-full rounded-xl border p-2.5 sm:p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground sm:text-xs">{icon}{label}</div>
      <div className="text-xs sm:text-sm">{children}</div>
    </div>
  );
}

// ── Progress ──
function ProgressView({ status, onReset }: { status: RestoreStatus; onReset: () => void }) {
  const { t } = useLang();
  const { toast } = useToast();
  const isDone = status.status === "success";
  const isFailed = status.status === "failed";
  const isRunning = status.status === "running";
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    if (!isRunning) return;
    setCancelling(true);
    try {
      const res = await fetch("/api/restore/cancel", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Restore cancelled" });
      } else {
        toast({ title: data.error || "Cancel failed", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || "Cancel failed", variant: "destructive" });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="w-full space-y-3 sm:space-y-4">
      <Card className={`w-full ${isDone ? "border-green-500/30" : isFailed ? "border-red-500/30" : ""}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            {isDone ? <><CheckCircle2 className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" /> {t("restore_complete")}</> : status.status === "cancelled" ? <><XCircle className="h-4 w-4 shrink-0 text-amber-500 sm:h-5 sm:w-5" /> Cancelled</> : isFailed ? <><XCircle className="h-4 w-4 shrink-0 text-red-500 sm:h-5 sm:w-5" /> {t("restore_failed")}</> : <><Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary sm:h-5 sm:w-5" /> {t("restore_progress")}</>}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">{isDone ? t("restore_complete_desc") : status.status === "cancelled" ? "Restore was cancelled by user" : isFailed ? t("restore_failed_desc") : t("restore_progress_desc")}</CardDescription>
        </CardHeader>
      </Card>
      <Card className="w-full">
        <CardContent className="w-full p-4 sm:p-6">
          <div className="w-full space-y-1">{(status.steps ?? []).map((step, i) => <StepRow key={step.key} step={step} index={i} isLast={i === (status.steps?.length ?? 0) - 1} />)}</div>
          {isFailed && status.error && (
            <div className="mt-4 w-full rounded-xl border border-red-500/30 bg-red-500/10 p-3 sm:p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-red-600 sm:text-sm">{t("restore_failed")}</p>
                  <p className="mt-1 break-words text-[11px] text-muted-foreground sm:text-xs">{status.error}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex w-full justify-center gap-3 pt-2">
        {isRunning && (
          <Button variant="destructive" size="default" className="gap-2 h-10 px-6 text-sm font-medium shadow-sm" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Cancel Restore
          </Button>
        )}
        {!isRunning && (
          <Button onClick={onReset} className="gap-2 h-10 px-6 text-sm font-medium shadow-sm" size="default"><RotateCcw className="h-4 w-4" />{t("restore_restore_again")}</Button>
        )}
      </div>
    </div>
  );
}



function StepRow({ step, isLast }: { step: RestoreStepState; index: number; isLast: boolean }) {
  const { t } = useLang();
  const statusConfig = {
    pending: { icon: <div className="h-2.5 w-2.5 rounded-full border-2 border-muted-foreground/30" />, color: "text-muted-foreground", bg: "bg-muted/30" },
    running: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary sm:h-4 sm:w-4" />, color: "text-primary", bg: "bg-primary/5" },
    done: { icon: <CheckCircle2 className="h-3.5 w-3.5 text-green-500 sm:h-4 sm:w-4" />, color: "text-foreground", bg: "bg-transparent" },
    failed: { icon: <XCircle className="h-3.5 w-3.5 text-red-500 sm:h-4 sm:w-4" />, color: "text-red-600", bg: "bg-red-500/5" },
    skipped: { icon: <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />, color: "text-muted-foreground", bg: "bg-transparent" },
  } as const;
  const cfg = statusConfig[step.status];
  return (
    <div className="flex w-full gap-2.5 sm:gap-3">
      <div className="flex flex-col items-center">
        <div className={`flex h-8 w-8 items-center justify-center rounded-full ${cfg.bg} ${cfg.color} sm:h-9 sm:w-9`}>{cfg.icon}</div>
        {!isLast && <div className={`mt-1 h-6 w-px sm:h-8 ${step.status === "done" ? "bg-green-500/30" : "bg-border"}`} />}
      </div>
      <div className={`min-w-0 flex-1 ${isLast ? "pb-0" : "pb-2"}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`text-xs font-medium sm:text-sm ${step.status === "pending" ? "text-muted-foreground" : ""}`}>{step.title}</span>
          {step.status === "running" && <Badge variant="outline" className="text-[9px] text-primary sm:text-[10px]">{t("restore_step_running")}</Badge>}
          {step.status === "done" && <Badge variant="outline" className="text-[9px] text-green-600 sm:text-[10px]">{t("restore_step_done")}</Badge>}
          {step.status === "failed" && <Badge variant="destructive" className="text-[9px] sm:text-[10px]">{t("restore_step_failed")}</Badge>}
          {step.status === "skipped" && <Badge variant="outline" className="text-[9px] text-muted-foreground sm:text-[10px]">{t("restore_step_skipped")}</Badge>}
        </div>
        {step.detail && <p className="mt-0.5 break-words text-[11px] text-muted-foreground sm:text-xs">{step.detail}</p>}
        {step.status === "failed" && step.error && <p className="mt-1 break-words text-[11px] text-red-600 sm:text-xs">{step.error}</p>}
      </div>
    </div>
  );
}

// ── History ──
type RestoreEffStatus = "success" | "failed" | "cancelled" | "running";

/** Failed jobs whose error mentions cancel were user-aborted → "cancelled". */
function effStatus(job: any): RestoreEffStatus {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "failed")
    return String(job.error ?? "").toLowerCase().includes("cancel") ? "cancelled" : "failed";
  return job.status; // success | running
}

const RESTORE_PANELS = [
  { key: "3x-ui", tag: "3X" },
  { key: "hmpanel", tag: "HM" },
  { key: "pasarguard", tag: "PG" },
  { key: "rebecca", tag: "RB" },
] as const;

type RestorePanelFilter = "all" | (typeof RESTORE_PANELS)[number]["key"];

function RestoreHistoryCard({ history, onRefresh, onRetry }: { history: any[]; onRefresh?: () => void; onRetry?: (job: any) => void }) {
  const { t } = useLang();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState<number | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | RestoreEffStatus>("all");
  const [panelFilter, setPanelFilter] = useState<RestorePanelFilter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = useMemo(
    () =>
      history.filter(
        (j) =>
          (statusFilter === "all" || effStatus(j) === statusFilter) &&
          (panelFilter === "all" || j.panel === panelFilter)
      ),
    [history, statusFilter, panelFilter]
  );

  // chip counts reflect the loaded history window (same policy as Backups)
  const statusCounts = useMemo(
    () => ({
      all: history.length,
      success: history.filter((j) => effStatus(j) === "success").length,
      failed: history.filter((j) => effStatus(j) === "failed").length,
      cancelled: history.filter((j) => effStatus(j) === "cancelled").length,
    }),
    [history]
  );
  const panelCounts = useMemo(() => {
    const base: Record<RestorePanelFilter, number> = { all: history.length, "3x-ui": 0, hmpanel: 0, pasarguard: 0, rebecca: 0 };
    for (const j of history) if (j.panel in base) base[j.panel as RestorePanelFilter] += 1;
    return base;
  }, [history]);

  // export the rows currently shown (both filters applied) as CSV — BOM first
  // so Excel opens UTF-8 names correctly
  function exportCsv() {
    const esc = (v: string | number | null) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = "id,time,panel,backup,source,server,duration_sec,status,error";
    const lines = rows.map((j) =>
      [
        j.id,
        j.startedAt,
        j.panel,
        j.backupName ?? `#${j.id}`,
        j.backupSource ?? "",
        `${j.sshUser}@${j.sshHost}:${j.sshPort}`,
        j.durationMs != null ? (j.durationMs / 1000).toFixed(1) : "",
        effStatus(j),
        j.error ? resolveText(j.error, "en").replace(/\r?\n/g, " ") : "",
      ].map(esc).join(",")
    );
    const blob = new Blob(["\uFEFF" + [head, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = url;
    a.download = `bkup-restore-history-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: t("csv_exported"), description: `${rows.length} ${t("activity_total")}` });
  }

  const fmtDuration = (ms: number | null) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  };
  const statusBadge = (status: string, error?: string) => {
    const eff = effStatus({ status, error });
    if (eff === "success") return <Badge className="bg-green-500/15 text-green-600 text-[9px] hover:bg-green-500/25 sm:text-[10px]">{t("success")}</Badge>;
    if (eff === "cancelled") return <Badge className="bg-amber-500/15 text-amber-600 text-[9px] hover:bg-amber-500/25 sm:text-[10px]">{t("status_cancelled")}</Badge>;
    if (eff === "failed") return <Badge variant="destructive" className="text-[9px] sm:text-[10px]">{t("failed")}</Badge>;
    return <Badge variant="outline" className="text-[9px] sm:text-[10px]">{t("running_now")}</Badge>;
  };
  const panelBadge = (panel: string) => panel === "hmpanel" ? "HM" : panel === "pasarguard" ? "PG" : panel === "rebecca" ? "RB" : "3X";

  // "select all" only ticks the rows currently shown (both filters applied)
  const allIds = rows.map((j: any) => j.id);
  const allSelected = allIds.length > 0 && allIds.every((id: number) => selected.has(id));

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
  }

  async function deleteOne(id: number) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/restore/history?id=${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast({ title: t("deleted") });
        setSelected((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
        onRefresh?.();
      } else {
        toast({ title: data.error || t("error"), variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || t("error"), variant: "destructive" });
    } finally {
      setDeleting(null);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const res = await fetch(`/api/restore/history`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast({ title: `${t("deleted")} · ${data.deleted}` });
        setSelected(new Set());
        onRefresh?.();
      } else {
        toast({ title: data.error || t("error"), variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || t("error"), variant: "destructive" });
    } finally {
      setBulkDeleting(false);
    }
  }

  async function deleteAll() {
    if (!confirm(t("restore_history_delete_all"))) return;
    setBulkDeleting(true);
    try {
      const res = await fetch(`/api/restore/history?all=true`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast({ title: `${t("deleted")} · ${data.deleted}` });
        setSelected(new Set());
        onRefresh?.();
      } else {
        toast({ title: data.error || t("error"), variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: e.message || t("error"), variant: "destructive" });
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg"><History className="h-4 w-4 shrink-0" />{t("restore_history")}</CardTitle>
          <CardDescription className="mt-1 text-xs sm:text-sm">{t("restore_history_desc")}</CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" className="h-8 gap-1 px-2.5 text-[11px]" onClick={deleteSelected} disabled={bulkDeleting}>
              {bulkDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              {t("delete_selected")} ({selected.size})
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={exportCsv} disabled={rows.length === 0} title={t("export_csv")}>
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("export_csv")}</span>
          </Button>
          {onRefresh && <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onRefresh} aria-label={t("refresh")}><RefreshCw className="h-3.5 w-3.5" /></Button>}
        </div>
      </CardHeader>
      <CardContent className="w-full">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {(["all", "success", "failed", "cancelled"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:px-3 ${
                  statusFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f === "all" ? t("filter_all") : f === "success" ? t("success") : f === "failed" ? t("failed") : t("status_cancelled")}
                <span
                  className={`rounded px-1 text-[10px] tabular-nums ${
                    statusFilter === f ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {statusCounts[f]}
                </span>
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border p-0.5">
            <button
              onClick={() => setPanelFilter("all")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                panelFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("filter_all")}
              <span
                className={`rounded px-1 text-[10px] tabular-nums ${
                  panelFilter === "all" ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {panelCounts.all}
              </span>
            </button>
            {RESTORE_PANELS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPanelFilter(p.key)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  panelFilter === p.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.tag}
                <span
                  className={`rounded px-1 text-[10px] tabular-nums ${
                    panelFilter === p.key ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {panelCounts[p.key]}
                </span>
              </button>
            ))}
          </div>
        </div>
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center text-muted-foreground">
            <Inbox className="mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">{t("restore_history_empty")}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center text-muted-foreground">
            <Inbox className="mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">{t("restore_filter_hint")}</p>
          </div>
        ) : (
          <div className="w-full overflow-hidden rounded-lg border">
            <div className="custom-scroll max-h-[60vh] w-full overflow-auto sm:max-h-[65vh] lg:max-h-[70vh]">
              <Table className="w-full">
                <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label={t("select_all")} />
                    </TableHead>
                    <TableHead className="min-w-[90px] text-[10px] sm:min-w-[110px] sm:text-xs">{t("col_time")}</TableHead>
                    <TableHead className="min-w-[140px] text-[10px] sm:min-w-[180px] sm:text-xs">{t("col_file")}</TableHead>
                    <TableHead className="hidden min-w-[120px] text-[10px] lg:table-cell sm:text-xs">{t("restore_col_server")}</TableHead>
                    <TableHead className="min-w-[60px] text-[10px] sm:text-xs">{t("restore_col_panel")}</TableHead>
                    <TableHead className="hidden min-w-[80px] text-[10px] sm:table-cell sm:text-xs">{t("col_duration")}</TableHead>
                    <TableHead className="min-w-[80px] text-[10px] sm:text-xs">{t("col_status")}</TableHead>
                    <TableHead className="w-14 text-end text-[10px] sm:w-20">{t("restore_col_actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((job) => {
                    const eff = effStatus(job);
                    const retryable = Boolean(onRetry) && (eff === "failed" || eff === "cancelled");
                    return (
                      <Fragment key={job.id}>
                        <TableRow className={`transition-colors ${selected.has(job.id) ? "bg-muted/50" : ""}`}>
                          <TableCell>
                            <Checkbox checked={selected.has(job.id)} onCheckedChange={() => toggleOne(job.id)} aria-label={`Select ${job.id}`} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-[10px] tabular-nums sm:text-xs"><TimeAgo date={job.startedAt} className="text-[10px] sm:text-xs" /></TableCell>
                          <TableCell className="max-w-[140px] sm:max-w-[220px] lg:max-w-[280px]"><span className="block truncate text-[10px] font-medium sm:text-xs" dir="ltr" title={job.backupName || `#${job.id}`}>{job.backupName || `#${job.id}`}</span></TableCell>
                          <TableCell className="hidden text-[10px] lg:table-cell sm:text-xs"><span className="block max-w-[140px] truncate font-mono" dir="ltr" title={`${job.sshUser}@${job.sshHost}:${job.sshPort}`}>{job.sshHost}</span></TableCell>
                          <TableCell><Badge variant="outline" className="text-[9px] uppercase sm:text-[10px]">{panelBadge(job.panel)}</Badge></TableCell>
                          <TableCell className="hidden whitespace-nowrap text-[10px] tabular-nums sm:table-cell sm:text-xs">{fmtDuration(job.durationMs)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-0.5">
                              {statusBadge(job.status, job.error)}
                              {job.error && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  title={t("restore_error_title")}
                                  aria-label={t("restore_error_title")}
                                  aria-expanded={expanded === job.id}
                                  onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                                >
                                  {expanded === job.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              {retryable && (
                                <Button variant="ghost" size="icon" className="h-7 w-7" title={t("restore_retry")} aria-label={t("restore_retry")} onClick={() => onRetry?.(job)} disabled={deleting === job.id}>
                                  <RotateCcw className="h-3.5 w-3.5 text-amber-600" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteOne(job.id)} disabled={deleting === job.id}>
                                {deleting === job.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3 text-red-500" />}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded === job.id && job.error && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={8}>
                              <div className="flex items-start justify-between gap-3 py-1">
                                <div className="min-w-0">
                                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("restore_error_title")}</p>
                                  <p className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-red-600" dir="ltr">{resolveText(job.error, "en")}</p>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 shrink-0 gap-1 text-[11px]"
                                  onClick={() => {
                                    navigator.clipboard.writeText(resolveText(job.error, "en"));
                                    toast({ title: t("copied") });
                                  }}
                                >
                                  <Copy className="h-3 w-3" /> {t("copy")}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

