"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Files, CheckCircle2, XCircle, Timer, Link2, Send, Activity, Boxes,
  Clock, Server, MemoryStick, GitBranch, AlertTriangle, ChevronRight, Loader2, DatabaseBackup,
  ChartColumn, CalendarDays,
} from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import { TimeAgo } from "@/components/dashboard/TimeAgo";
import type { AppConfigDTO, BackupRunDTO, StatusDTO, SystemInfoDTO } from "@/components/dashboard/types";
import { formatBytes } from "@/components/dashboard/types";
import type { PanelFilter } from "@/components/dashboard/BackupsTab";
import { firstTgMessageId, tgMessageUrl } from "@/lib/tg-link";

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

interface DailyPoint { day: string; success: number; failed: number; bytes: number }

const HEALTH_PANELS = [
  { key: "3x-ui", tag: "3X", label: "panel_3xui" },
  { key: "hmpanel", tag: "HM", label: "panel_hm" },
  { key: "pasarguard", tag: "PG", label: "panel_pg" },
  { key: "rebecca", tag: "RB", label: "panel_rb" },
] as const;

/**
 * Per-panel health tiles — last backup age, window success rate and run
 * count for each of the four panels. Clicking a tile opens Backups
 * pre-filtered to that panel (drill-down via lifted filter state).
 * Self-fetches a wider window than the 5-row recent list.
 */
function PanelHealth({ runsHeadId, onDrill }: { runsHeadId: number; onDrill: (p: PanelFilter) => void }) {
  const { t } = useLang();
  const [hist, setHist] = useState<BackupRunDTO[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/backups?limit=60", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && Array.isArray(d)) setHist(d as BackupRunDTO[]); })
      .catch(() => { /* keep the old data */ });
    return () => { alive = false; };
  }, [runsHeadId]);

  const tiles = useMemo(
    () =>
      HEALTH_PANELS.map((p) => {
        const rs = (hist ?? []).filter((r) => r.panel === p.key);
        const ok = rs.filter((r) => r.status === "success").length;
        const done = rs.filter((r) => r.status !== "running").length;
        return {
          ...p,
          count: rs.length,
          rate: done > 0 ? Math.round((ok / done) * 100) : null,
          last: rs[0] as BackupRunDTO | undefined, // newest-first from the API
        };
      }),
    [hist]
  );

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((p) => {
        const dot =
          !p.last ? "bg-muted-foreground/30" :
          p.last.status === "success" ? "bg-primary" :
          p.last.status === "failed" ? "bg-red-500" : "bg-stone-500 animate-pulse";
        return (
          <Card
            key={p.key}
            role="button"
            tabIndex={0}
            title={t("health_open_hint")}
            onClick={() => onDrill(p.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDrill(p.key);
              }
            }}
            className="cursor-pointer transition-shadow hover:ring-1 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          >
            <CardContent className="flex items-center gap-3 p-4">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-[11px] font-black tracking-wide text-muted-foreground">
                {p.tag}
                <span className={`absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background ${dot}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-muted-foreground">{t(p.label)}</p>
                <div className="truncate text-sm font-bold">
                  {hist === null ? (
                    <Skeleton className="h-4 w-16" />
                  ) : p.last ? (
                    <TimeAgo date={p.last.startedAt} className="text-sm" />
                  ) : (
                    <span className="text-muted-foreground">{t("health_no_runs")}</span>
                  )}
                </div>
                <p className="mt-0.5 truncate whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                  {p.rate !== null ? `${p.rate}% ${t("stat_success_rate")} · ${p.count}` : "—"}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** 14-day backup activity — refetched whenever a new run shows up in the poll. */
function ActivityChart({ runsHeadId }: { runsHeadId: number }) {
  const { t } = useLang();
  const [days, setDays] = useState<DailyPoint[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/stats/daily", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.days) setDays(d.days as DailyPoint[]); })
      .catch(() => { /* keep the old chart */ });
    return () => { alive = false; };
  }, [runsHeadId]);

  const max = useMemo(() => Math.max(1, ...(days ?? []).map((d) => d.success + d.failed)), [days]);
  const totals = useMemo(() => {
    const list = days ?? [];
    return {
      runs: list.reduce((n, d) => n + d.success + d.failed, 0),
      bytes: list.reduce((n, d) => n + d.bytes, 0),
    };
  }, [days]);

  const dayLabel = (day: string) => day.slice(8); // "2026-09-07" -> "07"
  const niceDate = (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <Card>
      <CardHeader className="@container/card-header flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <ChartColumn className="h-4 w-4" />
          {t("activity_title")}
          <span className="text-xs font-normal text-muted-foreground">· {t("activity_window")}</span>
        </CardTitle>
        {days && totals.runs > 0 && (
          <div data-slot="card-action" className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{totals.runs} {t("activity_total")}</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">{formatBytes(totals.bytes)}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {!days ? (
          <Skeleton className="h-28 w-full rounded-lg" />
        ) : totals.runs === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center">
            <ChartColumn className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t("activity_empty")}</p>
          </div>
        ) : (
          <>
            <div className="flex h-28 items-stretch gap-[3px] sm:gap-1.5">
              {days.map((d, i) => {
                const isToday = i === days.length - 1;
                const okH = (d.success / max) * 100;
                const failH = (d.failed / max) * 100;
                const tip = `${niceDate(d.day)} — ${d.success} ok, ${d.failed} failed, ${formatBytes(d.bytes)}`;
                return (
                  <div
                    key={d.day}
                    title={tip}
                    className={`group flex min-w-0 flex-1 cursor-default flex-col justify-end gap-px rounded pb-0 transition-colors ${
                      isToday ? "bg-primary/[0.04] ring-1 ring-inset ring-primary/15" : "hover:bg-muted/40"
                    }`}
                  >
                    {d.failed > 0 && (
                      <div
                        className="w-full rounded-t-[3px] bg-red-500/70 transition-colors group-hover:bg-red-500"
                        style={{ height: `${Math.max(failH, 3)}%` }}
                      />
                    )}
                    {d.success > 0 && (
                      <div
                        className={`w-full bg-primary/85 transition-colors group-hover:bg-primary ${
                          d.failed === 0 ? "rounded-t-[3px]" : ""
                        }`}
                        style={{ height: `${Math.max(okH, 3)}%` }}
                      />
                    )}
                    {d.success + d.failed === 0 && (
                      <div className="mx-auto mb-px h-0.5 w-full rounded-full bg-muted-foreground/15" />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-[3px] sm:gap-1.5">
              {days.map((d, i) => (
                <span
                  key={d.day}
                  className={`min-w-0 flex-1 text-center text-[9px] tabular-nums ${
                    i === days.length - 1 ? "font-bold text-primary" : "text-muted-foreground/60"
                  }`}
                >
                  {i === days.length - 1 ? t("activity_today") : dayLabel(d.day)}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-primary/85" /> success</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-red-500/70" /> failed</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardHome({
  config, status, info, runs, busy,
  onToggle, onBackupNow, onTestPanel, onTestTg, goto, onDrillPanel,
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
  onDrillPanel: (p: PanelFilter) => void;
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
      label: t("panel_rb"),
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
        <Stat
          icon={<CheckCircle2 className="h-4 w-4" />}
          label={t("success_count")}
          value={stats ? n(stats.success) : "—"}
          accent="text-foreground"
          sub={
            stats && stats.success + stats.failed > 0 ? (() => {
              const rate = Math.round((stats.success / (stats.success + stats.failed)) * 100);
              return (
                <div className="mt-1.5 w-full">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${rate >= 90 ? "bg-primary" : rate >= 60 ? "bg-amber-500" : "bg-red-500"}`}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                    {rate}% {t("stat_success_rate")}
                  </p>
                </div>
              );
            })() : undefined
          }
        />
        <Stat icon={<XCircle className="h-4 w-4" />} label={t("failed_count")} value={stats ? n(stats.failed) : "—"} accent="text-red-600" />
        <Stat icon={<Clock className="h-4 w-4" />} label={t("last_24h")} value={stats ? n(stats.last24h) : "—"} accent="text-muted-foreground" />
      </div>

      {/* ===== panel health (drill-down tiles) ===== */}
      <PanelHealth runsHeadId={runs[0]?.id ?? 0} onDrill={onDrillPanel} />

      {/* ===== 14-day activity chart ===== */}
      <ActivityChart runsHeadId={runs[0]?.id ?? 0} />

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
              {runs.slice(0, 5).map((r) => {
                const tg = tgMessageUrl(
                  config?.telegramChatId ?? "",
                  config?.telegramThreadId ?? "",
                  firstTgMessageId(r.tgMessageId, r.tgMessageIds)
                );
                return (
                  <div key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        r.status === "success" ? "bg-primary" : r.status === "failed" ? "bg-red-500" : "bg-stone-500 animate-pulse"
                      }`}
                    />
                    <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                      {r.panel === "hmpanel" ? "HM" : r.panel === "pasarguard" ? "PG" : r.panel === "rebecca" ? "RB" : "3X"}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-medium" dir="ltr">
                      {r.fileName ?? `#${r.id}`}
                    </span>
                    <TimeAgo date={r.startedAt} className="shrink-0 text-xs text-muted-foreground" />
                    <Badge variant="outline" className="shrink-0 text-[10px] tabular-nums">
                      {formatBytes(r.fileSize)}
                    </Badge>
                    {!r.tgDeleted && tg && (
                      <a
                        href={tg}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={t("open_in_tg")}
                        aria-label={t("open_in_tg")}
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon, label, value, accent, sub }: { icon: React.ReactNode; label: string; value: string; accent?: string; sub?: React.ReactNode }) {
  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted ${accent ?? "text-foreground"}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold tabular-nums">{value}</p>
          {sub}
        </div>
      </CardContent>
    </Card>
  );
}

function Mini({ icon, label, value, badge }: { icon: React.ReactNode; label: string; value: string; badge?: { text: string; onClick: () => void } }) {
  return (
    <Card className="transition-shadow hover:shadow-sm">
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
