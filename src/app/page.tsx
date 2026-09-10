"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { LangProvider, useLang } from "@/components/dashboard/lang";
import { LoginScreen } from "@/components/dashboard/LoginScreen";
import { Shell, type TabKey } from "@/components/dashboard/Shell";
import { DashboardHome } from "@/components/dashboard/DashboardHome";
import { BackupsTab } from "@/components/dashboard/BackupsTab";
import { SettingsTab } from "@/components/dashboard/SettingsTab";
import { LogsTab } from "@/components/dashboard/LogsTab";
import { SystemTab } from "@/components/dashboard/SystemTab";
import type {
  AppConfigDTO, AppLogDTO, BackupRunDTO, StatusDTO, SystemInfoDTO,
} from "@/components/dashboard/types";
import { resolveText } from "@/lib/messages";

/** Fill {placeholders} in a dict template. */
function tr(tpl: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    tpl
  );
}

type AuthPhase = "loading" | "setup" | "login" | "app";

function App() {
  const { toast } = useToast();
  const { t } = useLang();
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [tab, setTab] = useState<TabKey>("dashboard");

  const [config, setConfig] = useState<AppConfigDTO | null>(null);
  const [status, setStatus] = useState<StatusDTO | null>(null);
  const [info, setInfo] = useState<SystemInfoDTO | null>(null);
  const [runs, setRuns] = useState<BackupRunDTO[]>([]);
  const [logs, setLogs] = useState<AppLogDTO[]>([]);
  const [logCursor, setLogCursor] = useState(0);
  const [manualRunning, setManualRunning] = useState(false);
  // ⚡ stale-response guard: every loadCore run gets an id; only the LATEST
  // run may apply its results. Without this, an out-of-order older poll
  // overwrote fresh state and visually snapped the on/off switches back.
  const coreSeq = useRef(0);
  // ⚡ config revision guard: ANY config write (PUT/toggle/save) updates this
  // stamp; a poll that STARTED before the write but RESOLVES after it carries
  // an older updatedAt and is dropped here instead of reverting the switches.
  // This closes the poll-vs-write race the seq guard alone cannot catch.
  const configStamp = useRef("");
  const applyConfig = useCallback((c: AppConfigDTO | null | undefined) => {
    if (!c) return;
    const ts = typeof c.updatedAt === "string" ? c.updatedAt : "";
    if (ts && configStamp.current && ts < configStamp.current) return; // stale — never revert fresh state
    if (ts) configStamp.current = ts;
    setConfig(c);
  }, []);

  // ── auth probe ────────────────────────────────────────────────
  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/state", { cache: "no-store" });
      const data = await res.json();
      if (data.authenticated) setPhase("app");
      else setPhase(data.passwordSet ? "login" : "setup");
    } catch {
      // keep loading state; dev server may be restarting
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // ── core polling: config + status + info (4s) ─────────────────
  const loadCore = useCallback(async (): Promise<boolean> => {
    const seq = ++coreSeq.current; // claim this run
    try {
      const [c, s, i] = await Promise.all([
        fetch("/api/config").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/status").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/system/info").then((r) => (r.ok ? r.json() : null)),
      ]);
      if (seq !== coreSeq.current) return false; // a newer run started → discard stale results
      applyConfig(c);
      if (s) setStatus(s);
      if (i) setInfo(i);
      if (i === null && s === null) {
        // 401 → session expired
        checkAuth();
      }
      return true;
    } catch {
      return false; /* transient */
    }
  }, [checkAuth, applyConfig]);

  useEffect(() => {
    if (phase !== "app") return;
    loadCore();
    const id = setInterval(loadCore, 4000);
    return () => clearInterval(id);
  }, [phase, loadCore]);

  // ── history polling when visible ──────────────────────────────
  const loadRuns = useCallback(async () => {
    try {
      const d = await fetch("/api/backups?limit=60").then((r) => (r.ok ? r.json() : null));
      if (d) setRuns(d);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (phase !== "app" || tab !== "backups") return;
    loadRuns();
    const id = setInterval(loadRuns, 5000);
    return () => clearInterval(id);
  }, [phase, tab, loadRuns]);

  // small run list for dashboard
  useEffect(() => {
    if (phase !== "app" || tab !== "dashboard") return;
    fetch("/api/backups?limit=5")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRuns(d))
      .catch(() => {});
  }, [phase, tab, status]);

  // ── logs incremental polling ──────────────────────────────────
  useEffect(() => {
    if (phase !== "app" || tab !== "logs") return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/logs?after=${logCursor}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        if (data.rows?.length) {
          setLogs((prev) => [...prev, ...data.rows].slice(-500));
          setLogCursor(data.cursor);
        }
      } catch { /* ignore */ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [phase, tab, logCursor]);

  // ── actions ───────────────────────────────────────────────────
  const persistEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      try {
        const res = await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        const data = await res.json();
        if (res.ok) {
          applyConfig(data);
          toast({
            title: enabled ? t("auto_on_toast") : t("auto_off_toast"),
            description: enabled ? t("auto_on_toast_desc") : t("auto_off_toast_desc"),
          });
          await loadCore(); // authoritative refresh (seq-guarded)
          return true;
        } else if (res.status === 401) {
          setPhase("login");
          return false;
        } else {
          toast({ title: t("error"), description: data.error, variant: "destructive" });
          return false;
        }
      } catch {
        toast({ title: t("network_error"), variant: "destructive" });
        return false;
      }
    },
    [toast, loadCore, applyConfig, t]
  );

  const manualBackup = useCallback(async () => {
    setManualRunning(true);
    try {
      const res = await fetch("/api/backup/run", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        outcomes?: { panel: string; status: string; fileName?: string; error?: string; errorBi?: { fa: string; en: string } }[];
        durationMs?: number;
      };
      const outcomes = data.outcomes ?? [];
      const okCount = outcomes.filter((o) => o.status === "success").length;
      const failCount = outcomes.filter((o) => o.status === "failed").length;
      if (outcomes.length === 0) {
        toast({ title: t("no_panels_enabled"), description: t("no_panels_enabled_desc"), variant: "destructive" });
      } else if (failCount === 0) {
        toast({
          title: t("manual_ok"),
          description: outcomes.map((o) => `${o.panel}: ${o.fileName ?? "-"}`).join(" — "),
        });
      } else {
        const failed = outcomes.filter((o) => o.status === "failed");
        toast({
          title: tr(t("manual_partial"), { ok: okCount, fail: failCount }),
          description: failed.map((o) => `${o.panel}: ${o.errorBi ? resolveText(o.errorBi, "en") : o.error ?? t("error")}`).join(" | "),
          variant: "destructive",
        });
      }
      loadCore();
    } catch {
      toast({ title: t("manual_net_err"), variant: "destructive" });
    } finally {
      setManualRunning(false);
    }
  }, [toast, loadCore, t]);

  const testPanel = useCallback(async () => {
    // tests whichever panels are enabled — each with its own credentials
    try {
      const targets: ("3x-ui" | "hmpanel" | "pasarguard")[] = [];
      if (config?.xuiEnabled) targets.push("3x-ui");
      if (config?.hmEnabled) targets.push("hmpanel");
      if (config?.pgEnabled) targets.push("pasarguard");
      if (targets.length === 0) {
        toast({ title: t("no_panels_enabled"), description: t("no_panels_enabled_desc"), variant: "destructive" });
        return;
      }
      for (const panel of targets) {
        const res = await fetch("/api/config/test-panel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config, panel }),
        });
        const data = await res.json();
        const name = panel === "hmpanel" ? "HMPanel" : panel === "pasarguard" ? "PasarGuard" : "3x-ui";
        if (data.ok) {
          toast({ title: tr(t("panel_conn_ok"), { name }), description: resolveText(data.messageBi ?? data.message, "en") });
        } else {
          toast({ title: tr(t("panel_conn_fail"), { name }), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
        }
      }
      loadCore(); // re-fetch config so a newly detected edition (e.g. HM Panel Premium) shows immediately
    } catch {
      toast({ title: t("network_error"), variant: "destructive" });
    }
  }, [config, toast, t, loadCore]);

  const testTg = useCallback(async () => {
    try {
      const res = await fetch("/api/config/test-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (data.ok) toast({ title: t("tg_test_ok"), description: resolveText(data.messageBi ?? data.message, "en") });
      else toast({ title: t("tg_test_fail"), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
    } catch {
      toast({ title: t("network_error"), variant: "destructive" });
    }
  }, [config, toast, t]);

  const clearLogs = useCallback(async () => {
    await fetch("/api/logs", { method: "DELETE" });
    setLogs([]);
    setLogCursor(0);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setPhase("login");
  }, []);

  // ── render ────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md space-y-4 p-6">
          <Skeleton className="mx-auto h-16 w-16 rounded-2xl" />
          <Skeleton className="mx-auto h-8 w-56" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    );
  }

  if (phase === "setup" || phase === "login") {
    return (
      <LoginScreen
        key={phase}
        mode={phase === "setup" ? "setup" : "login"}
        onAuthed={() => setPhase("app")}
      />
    );
  }

  const sched = status?.scheduler;
  const isLive = Boolean(sched?.enabled && sched?.nextRunAt);

  return (
    <Shell
      tab={tab}
      onTab={setTab}
      onLogout={logout}
      onBackupNow={manualBackup}
      backupBusy={manualRunning}
      isLive={isLive}
      info={info}
    >
      {tab === "dashboard" && (
        <DashboardHome
          config={config}
          status={status}
          info={info}
          runs={runs}
          busy={manualRunning}
          onToggle={persistEnabled}
          onBackupNow={manualBackup}
          onTestPanel={testPanel}
          onTestTg={testTg}
          goto={(k) => setTab(k)}
        />
      )}
      {tab === "backups" && <BackupsTab runs={runs} onRefresh={loadRuns} />}
      {tab === "settings" && (
        <SettingsTab
          config={config}
          onSaved={(cfg) => {
            // a write just landed → kill any in-flight poll so its older
            // snapshot can never revert the switches the user just set
            coreSeq.current++;
            applyConfig(cfg);
          }}
          onPasswordChanged={() => {
            setPhase("login");
          }}
        />
      )}
      {tab === "logs" && <LogsTab logs={logs} onClear={clearLogs} />}
      {tab === "system" && <SystemTab info={info} onRefreshInfo={loadCore} />}
    </Shell>
  );
}

export default function Page() {
  return (
    <LangProvider>
      <App />
    </LangProvider>
  );
}
