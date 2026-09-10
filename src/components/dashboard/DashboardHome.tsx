"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Files, CheckCircle2, XCircle, Timer, Link2, Send, Activity, Boxes,
  Clock, Server, MemoryStick, GitBranch, AlertTriangle, ChevronRight, Loader2, DatabaseBackup,
} from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import type { AppConfigDTO, BackupRunDTO, StatusDTO, SystemInfoDTO } from "@/components/dashboard/types";
import { formatBytes } from "@/components/dashboard/types";

function countdown(nextRunAt: number | null): string {
  if (!nextRunAt) return "—";
  const diff = Math.max(0, nextRunAt - Date.now());
  const s = Math.floor(diff / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function DashboardHome({
  config, status, info, runs, busy,
  onToggle, onBackupNow, onTestPanel, onTestTg, goto,
}: {
  config: AppConfigDTO | null;
  status: StatusDTO | null;
  info: SystemInfoDTO | null;
  runs: BackupRunDTO[];
  busy: boolean;
  onToggle: (v: boolean) => Promise<boolean>;
  onBackupNow: () => void;
  onTestPanel: () => void;
  onTestTg: () => void;
  goto: (tab: "backups" | "settings" | "system") => void;
}) {
  const { t } = useLang();
  const [, tick] = useState(0);
  // optimistic toggle: the switch reacts INSTANTLY; the polled status (4s)
  // catches up later — without this the switch visibly snaps back.
  // If the persist request FAILS, the override is dropped → switch reverts.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // clear the optimistic override once the authoritative polled status agrees
  // with it — done as setState-during-render (the React-sanctioned way to
  // adjust state in response to other state) so no effect is needed and the
  // rule react-hooks/set-state-in-effect stays satisfied.
  if (pendingEnabled !== null && status?.scheduler?.enabled === pendingEnabled) {
    setPendingEnabled(null);
  }

  const sched = status?.scheduler;
  const stats = status?.stats;
  const schedEnabled = pendingEnabled ?? Boolean(sched?.enabled);
  const isLive = schedEnabled && Boolean(sched?.nextRunAt || pendingEnabled === true);
  const setupReady = Boolean(status?.configReady?.panel && status?.configReady?.telegram);
  const n = (v: number) => v.toLocaleString("en-US");

  const panelLabel = status?.panelType === "hmpanel" ? t("panel_hm") : t("panel_3xui");
  void panelLabel; // legacy single-panel label — dual cards below

  const panelReadyState = (p: { enabled: boolean; ready: boolean } | undefined): boolean | null | undefined =>
    p ? (p.enabled ? p.ready : null) : undefined; // null = card off, undefined = loading

  const conns = [
    {
      icon: <Link2 className="h-4 w-4" />,
      label: t("panel_3xui"),
      ready: panelReadyState(status?.panels?.xui),
      onTest: onTestPanel,
    },
    {
      icon: <Boxes className="h-4 w-4" />,
      label: t("panel_hm"),
      ready: panelReadyState(status?.panels?.hm),
      onTest: onTestPanel,
    },
    {
      icon: <Boxes className="h-4 w-4" />,
      label: t("panel_pg"),
      ready: panelReadyState(status?.panels?.pg),
      onTest: onTestPanel,
    },
{
      icon: <Boxes className="h-4 w-4" />,
      label: t("panel_pg"),
      ready: panelReadyState(status?.panels?.rebecca),
      onTest: onTestPanel,
    },
    {
      icon: <Send className="h-4 w-4" />,
      label: t("telegram_conn"),
      ready: status?.configReady.telegram,
      onTest: onTestTg,
    },
    {
      icon: <Activity className="h-4 w-4" />,
      label: t("scheduler"),
      ready: isLive,
    },
  ];

  return (
    <div className="space-y-5">
      {/* ===== hero: next backup + toggle ===== */}
      <Card className="relative overflow-hidden bg-primary text-primary-foreground shadow-[0_0_70px_-20px_rgba(10,10,10,0.45)]">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(420px 200px at 85% -20%, rgba(255,255,255,0.16), transparent 60%)" }}
        />
        <CardContent className="relative flex flex-col items-start justify-between gap-5 p-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-black/15 ring-1 ring-black/20">
              <Timer className="h-7 w-7" />
            </div>
            <div>
              <p className="text-sm opacity-70">{t("next_backup")}</p>
              <p className="text-3xl font-black tabular-nums leading-tight" dir="ltr">
                {busy || sched?.running ? (
                  <span className="flex items-center gap-2 text-xl">
                    <Loader2 className="h-5 w-5 animate-spin" /> {t("in_progress")}
                  </span>
                ) : !schedEnabled ? (
                  <span className="text-2xl">{t("stopped_state")}</span>
                ) : isLive ? (
                  countdown(sched?.nextRunAt ?? null)
                ) : (
                  "—"
                )}
              </p>
              <p className="mt-0.5 text-xs opacity-70">
                {!schedEnabled
                  ? t("auto_off_desc")
                  : !setupReady
                    ? t("auto_pending_desc")
                    : config
                      ? `${t("every")} ${n(config.intervalSeconds)} ${t("seconds")}`
                      : t("auto_on_desc")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-end">
              <p className="text-sm font-semibold">{schedEnabled ? t("auto_on") : t("auto_off")}</p>
              <p className="text-xs opacity-70">{schedEnabled ? t("auto_on_desc") : t("auto_off_desc")}</p>
            </div>
            <Switch
              checked={schedEnabled}
              disabled={pendingEnabled !== null}
              variant="on-dark"
              onCheckedChange={(v) => {
                setPendingEnabled(v);
                void onToggle(v).then((ok) => {
                  if (!ok) setPendingEnabled(null); // persist failed → show the real (polled) state again
                });
              }}
              aria-label="auto backup"
            />
          </div>
        </CardContent>
      </Card>

      {/* ===== stat cards ===== */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Files className="h-4 w-4" />} label={t("total_backups")} value={stats ? n(stats.total) : "—"} />
        <Stat icon={<CheckCircle2 className="h-4 w-4" />} label={t("success_count")} value={stats ? n(stats.success) : "—"} accent="text-foreground" />
        <Stat icon={<XCircle className="h-4 w-4" />} label={t("failed_count")} value={stats ? n(stats.failed) : "—"} accent="text-red-600" />
        <Stat icon={<Clock className="h-4 w-4" />} label={t("last_24h")} value={stats ? n(stats.last24h) : "—"} accent="text-muted-foreground" />
      </div>

      {/* ===== setup warning ===== */}
      {status && (!status.configReady.panel || !status.configReady.telegram) && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
          <div className="text-sm">
            <p className="font-medium text-red-500">{t("setup_warning")}</p>
            <p className="mt-1 text-muted-foreground">
              {!status.configReady.panel && t("setup_warning_hint_panel")}
              {!status.configReady.telegram && t("setup_warning_hint_tg")}
              {t("setup_warning_hint_end")}
            </p>
            <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => goto("settings")}>
              {t("nav_settings")} <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ===== connections + system row ===== */}
      <div className="grid gap-3 lg:grid-cols-3">
        {conns.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${c.ready ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {c.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <div className={`text-sm font-bold ${c.ready ? "text-foreground" : "text-muted-foreground"}`}>
                  {c.ready === undefined ? <Skeleton className="h-4 w-16" /> : c.ready === null ? t("panel_off") : c.ready ? t("configured") : t("not_configured")}
                </div>
              </div>
              {c.onTest && (
                <Button variant="outline" size="sm" className="h-8" onClick={c.onTest} disabled={c.ready === undefined || c.ready === null}>
                  {t("test_now")}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Mini icon={<Clock className="h-4 w-4" />} label={t("uptime_app")} value={info ? fmtUptime(info.processUptimeSec) : "…"} />
        <Mini icon={<Server className="h-4 w-4" />} label={t("uptime_server")} value={info ? fmtUptime(info.osUptimeSec) : "…"} />
        <Mini
          icon={<GitBranch className="h-4 w-4" />}
          label={t("version_label")}
          value={info ? `v${info.appVersion}` : "…"}
          badge={info?.updateAvailable ? { text: t("update_badge"), onClick: () => goto("system") } : undefined}
        />
        <Mini icon={<MemoryStick className="h-4 w-4" />} label={t("memory")} value={info ? `${n(info.memoryMB)} MB` : "…"} />
      </div>

      {/* ===== recent backups ===== */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">{t("recent_backups")}</CardTitle>
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={() => goto("backups")}>
            {t("view_all")} <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="py-10 text-center">
              <DatabaseBackup className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">{t("no_backups_yet")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("no_backups_hint")}</p>
              <Button size="sm" className="mt-4" onClick={onBackupNow} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("backup_now")}
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {runs.slice(0, 5).map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      r.status === "success" ? "bg-primary" : r.status === "failed" ? "bg-red-500" : "bg-stone-500 animate-pulse"
                    }`}
                  />
                  <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                    {r.panel === "hmpanel" ? "HM" : r.panel === "pasarguard" ? "PG" : "3X"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-medium" dir="ltr">
                    {r.fileName ?? `#${r.id}`}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {new Intl.DateTimeFormat("en-GB", {
                      timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short",
                    }).format(new Date(r.startedAt))}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px] tabular-nums">
                    {formatBytes(r.fileSize)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted ${accent ?? "text-foreground"}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function Mini({ icon, label, value, badge }: { icon: React.ReactNode; label: string; value: string; badge?: { text: string; onClick: () => void } }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="text-sm font-bold tabular-nums">{value}</p>
        </div>
        {badge && (
          <button onClick={badge.onClick} className="shrink-0">
            <Badge className="bg-primary text-primary-foreground hover:bg-primary/90 text-[10px]">
              {badge.text}
            </Badge>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
