"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  RefreshCw, Download, ServerCog, GitBranch, Globe, Cpu, HardDrive,
  TerminalSquare, Loader2, CheckCircle2, AlertTriangle, Clock, Play, Square, RotateCcw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import type { SystemInfoDTO } from "@/components/dashboard/types";
import { resolveText } from "@/lib/messages";

export function SystemTab({
  info,
  onRefreshInfo,
}: {
  info: SystemInfoDTO | null;
  onRefreshInfo: () => void;
}) {
  const { t } = useLang();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateLog, setUpdateLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [port, setPort] = useState<string>("");
  const [confirmPort, setConfirmPort] = useState<number | null>(null);
  const [changingPort, setChangingPort] = useState(false);
  const [svc, setSvc] = useState<{ supported: boolean; state: string } | null>(null);
  const [svcBusy, setSvcBusy] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (info?.port) setPort(String(info.port));
  }, [info?.port]);

  // service state
  const loadSvc = useCallback(async () => {
    try {
      const res = await fetch("/api/system/service");
      if (res.ok) setSvc(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadSvc();
    const id = setInterval(loadSvc, 8000);
    return () => clearInterval(id);
  }, [loadSvc]);

  const controlService = useCallback(async (action: "start" | "stop" | "restart") => {
    setSvcBusy(action);
    try {
      const res = await fetch("/api/system/service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const msgKey = action === "start" ? "service_started" : action === "stop" ? "service_stopped" : "service_restarted";
        toast({ title: t(msgKey) });
        setSvc((s) => (s ? { ...s, state: data.state ?? s.state } : s));
      } else {
        toast({ title: t("error"), description: data.error, variant: "destructive" });
      }
    } finally {
      setSvcBusy(null);
      loadSvc();
    }
  }, [t, toast, loadSvc]);

  // poll while updating
  useEffect(() => {
    if (!updating) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/system/update");
        const data = await res.json();
        if (data.state?.state !== "running") {
          clearInterval(id);
          if (data.state?.state === "done") {
            toast({ title: t("update_done_toast") });
          } else if (data.state?.state === "error") {
            toast({ title: t("error"), description: data.state.error, variant: "destructive" });
          }
          setUpdating(false);
          onRefreshInfo();
        }
      } catch {
        /* app restarting — keep polling */
      }
    }, 4000);
    return () => clearInterval(id);
  }, [updating, t, toast, onRefreshInfo]);

  // stream log while updating
  useEffect(() => {
    if (!updating && !showLog) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/system/update?log=1");
        const text = await res.text();
        setUpdateLog(text);
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(id);
  }, [updating, showLog]);

  const checkUpdate = useCallback(async () => {
    setChecking(true);
    try {
      await fetch("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      onRefreshInfo();
    } finally {
      setChecking(false);
    }
  }, [onRefreshInfo]);

  const runUpdate = useCallback(async () => {
    setUpdating(true);
    setShowLog(true);
    try {
      const res = await fetch("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: t("error"), description: data.error, variant: "destructive" });
        setUpdating(false);
      }
    } catch {
      // the app may restart mid-request — that's expected
    }
  }, [t, toast]);

  async function changePort() {
    if (confirmPort == null) return;
    setChangingPort(true);
    try {
      const res = await fetch("/api/system/change-port", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: confirmPort }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: t("port_changed_hint"), duration: 8000 });
      } else {
        const desc = data.error === "INVALID_PORT" ? t("invalid_port") : data.error === "SAME_PORT" ? t("same_port") : resolveText(data.errorBi ?? data.error, "en");
        toast({ title: t("error"), description: desc, variant: "destructive" });
      }
    } finally {
      setChangingPort(false);
      setConfirmPort(null);
    }
  }

  const n = (v: number) => v.toLocaleString("en-US");
  const latest = info?.latest;

  return (
    <div className="space-y-5">
      {/* ===== update card ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4 text-primary" />
            {t("sys_title")}
          </CardTitle>
          <CardDescription dir="ltr">{info?.githubRepo}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">{t("current_version")}</p>
              <p className="mt-1 text-2xl font-black tabular-nums" dir="ltr">v{info?.appVersion ?? "…"}</p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">{t("latest_version")}</p>
              <p className="mt-1 text-2xl font-black tabular-nums" dir="ltr">
                {latest ? (latest.version ? `v${latest.version}` : "—") : "…"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {latest?.note === "NO_RELEASES"
                  ? t("no_release")
                  : latest?.note === "GITHUB_UNREACHABLE"
                    ? t("github_unreachable")
                    : latest?.tag ?? ""}
              </p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">{t("local_commit")}</p>
              <p className="mt-1 font-mono text-sm font-bold" dir="ltr">{info?.localCommit ?? "—"}</p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {info ? new Intl.DateTimeFormat("en-GB", {
                  timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short",
                }).format(new Date(info.startedAt)) : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {info?.updateAvailable ? (
              <Badge className="border-border bg-primary text-primary-foreground">
                <AlertTriangle className="me-1 h-3 w-3" />
                {t("update_badge")}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-border text-foreground">
                <CheckCircle2 className="me-1 h-3 w-3" />
                {t("up_to_date")}
              </Badge>
            )}
            <div className="ms-auto flex flex-wrap gap-2">
              <Button variant="outline" onClick={checkUpdate} disabled={checking} className="gap-2">
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {checking ? t("checking") : t("check_update")}
              </Button>
              <Button
                onClick={runUpdate}
                disabled={updating || !info?.updateAvailable}
                className="gap-2"
              >
                {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {updating ? t("updating") : t("update_now")}
              </Button>
            </div>
          </div>

          {(updating || showLog) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <TerminalSquare className="h-3.5 w-3.5" />
                  {t("update_log")}
                </Label>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowLog(false)}>
                  {t("close")}
                </Button>
              </div>
              <pre
                ref={logRef}
                className="log-console custom-scroll max-h-56 overflow-auto rounded-lg border bg-zinc-950 p-3 text-zinc-100"
                dir="ltr"
              >
                {updateLog || "…"}
              </pre>
              {updating && (
                <p className="text-xs text-muted-foreground">{t("update_hint")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== port ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" />
            {t("port_label")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40 space-y-2">
              <Label htmlFor="port">{t("new_port")}</Label>
              <Input id="port" dir="ltr" className="text-start tabular-nums" type="number" min={1} max={65535}
                value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={changingPort || !port || Number(port) === info?.port}
              onClick={() => setConfirmPort(Number(port))}
              className="gap-2"
            >
              {changingPort ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
              {t("change_port")}
            </Button>
            <span className="pb-2.5 text-sm text-muted-foreground tabular-nums" dir="ltr">
              → http://SERVER_IP:{info?.port ?? "…"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ===== service control ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerCog className="h-4 w-4" />
            {t("service_title")}
          </CardTitle>
          <CardDescription>{t("service_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {svc && !svc.supported ? (
            <p className="text-sm text-muted-foreground">{t("service_unsupported")}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-full border px-3 py-1.5">
                <span
                  className={`pulse-dot inline-block h-2 w-2 rounded-full ${
                    svc?.state === "active" ? "bg-primary" : svc?.state ? "bg-red-500" : "bg-zinc-400"
                  }`}
                />
                <span className="text-xs font-medium tabular-nums" dir="ltr">
                  {t("service_state")}: {svc?.state ?? "…"}
                </span>
              </div>
              <div className="ms-auto flex flex-wrap gap-2">
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  disabled={svcBusy !== null || svc?.state === "active"}
                  onClick={() => controlService("start")}
                >
                  {svcBusy === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  {t("service_start")}
                </Button>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  disabled={svcBusy !== null || svc?.state !== "active"}
                  onClick={() => controlService("stop")}
                >
                  {svcBusy === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  {t("service_stop")}
                </Button>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  disabled={svcBusy !== null || svc?.state !== "active"}
                  onClick={() => controlService("restart")}
                >
                  {svcBusy === "restart" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  {t("service_restart")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== system info ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4 text-primary" />
            {t("sys_info")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Row icon={<ServerCog className="h-3.5 w-3.5" />} label={t("hostname")} value={info?.hostname ?? "…"} />
            <Row icon={<HardDrive className="h-3.5 w-3.5" />} label={t("platform")} value={info?.platform ?? "…"} ltr />
            <Row icon={<Cpu className="h-3.5 w-3.5" />} label={t("node_ver")} value={info?.nodeVersion ?? "…"} ltr />
            <Row icon={<GitBranch className="h-3.5 w-3.5" />} label={t("repo_label")} value={info?.githubRepo ?? "…"} ltr />
            <Row icon={<Memory className="h-3.5 w-3.5" />} label={t("memory")} value={info ? `${n(info.memoryMB)} MB` : "…"} />
            <Row icon={<Clock className="h-3.5 w-3.5" />} label={t("started_at")} value={info ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "medium" }).format(new Date(info.startedAt)) : "…"} />
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmPort != null} onOpenChange={(o) => !o && setConfirmPort(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle dir="ltr">{t("change_port")} → {confirmPort}</AlertDialogTitle>
            <AlertDialogDescription>{t("port_changed_hint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); changePort(); }}>
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({ icon, label, value, ltr }: { icon: React.ReactNode; label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b pb-2.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">{icon}{label}</span>
      <span className="min-w-0 truncate font-medium" title={value} dir={ltr ? "ltr" : undefined}>{value}</span>
    </div>
  );
}

function Memory(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  );
}
