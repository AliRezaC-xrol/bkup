"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Download, Trash2, RefreshCw, Inbox, ShieldCheck, ShieldAlert, ShieldX, FileDown, Search, X, Send } from "lucide-react";
import { firstTgMessageId, tgMessageUrl } from "@/lib/tg-link";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import { TimeAgo } from "@/components/dashboard/TimeAgo";
import type { BackupRunDTO } from "@/components/dashboard/types";
import { formatBytes, formatDuration } from "@/components/dashboard/types";
import { resolveText } from "@/lib/messages";

interface VerifyResult {
  state: "ok" | "missing" | "mismatch";
  sha8: string;
}

const PANELS = [
  { key: "3x-ui", tag: "3X" },
  { key: "hmpanel", tag: "HM" },
  { key: "pasarguard", tag: "PG" },
  { key: "rebecca", tag: "RB" },
] as const;

export type PanelFilter = "all" | (typeof PANELS)[number]["key"];

export function BackupsTab({
  runs, onRefresh,
  // lifted state — lets the Dashboard panel-health tiles drill into a panel
  panelFilter: panelFilterProp, onPanelFilterChange,
  // telegram routing info — powers the "Open in Telegram" row action
  tgChatId = "", tgThreadId = "",
}: {
  runs: BackupRunDTO[];
  onRefresh: () => void;
  panelFilter?: PanelFilter;
  onPanelFilterChange?: (p: PanelFilter) => void;
  tgChatId?: string;
  tgThreadId?: string;
}) {
  const { t } = useLang();
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "success" | "failed">("all");
  // works with EITHER the lifted state (dashboard drill-down) or local state
  const [panelFilterLocal, setPanelFilterLocal] = useState<PanelFilter>("all");
  const panelFilter = panelFilterProp ?? panelFilterLocal;
  const setPanelFilter = (p: PanelFilter) => {
    setPanelFilterLocal(p);
    onPanelFilterChange?.(p);
  };
  const [deleting, setDeleting] = useState<BackupRunDTO | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [verified, setVerified] = useState<Map<number, VerifyResult>>(new Map());
  // filename search — combines (AND) with the status/panel chips
  const [query, setQuery] = useState("");

  // drop ids that no longer exist so the selection never goes stale
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(runs.map((r) => r.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (panelFilter === "all" || r.panel === panelFilter) &&
        (!q || (r.fileName ?? `#${r.id}`).toLowerCase().includes(q))
    );
  }, [runs, filter, panelFilter, query]);

  // chip counts — reflect the loaded history window, so the numbers always
  // agree with what the table can actually show
  const statusCounts = useMemo(
    () => ({
      all: runs.length,
      success: runs.filter((r) => r.status === "success").length,
      failed: runs.filter((r) => r.status === "failed").length,
    }),
    [runs]
  );
  const panelCounts = useMemo(() => {
    const base: Record<PanelFilter, number> = { all: runs.length, "3x-ui": 0, hmpanel: 0, pasarguard: 0, rebecca: 0 };
    for (const r of runs) if (r.panel in base) base[r.panel as PanelFilter] += 1;
    return base;
  }, [runs]);

  // per-row Telegram deep link — built once per (chatId, run) pair
  const tgUrl = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of runs) {
      const u = tgMessageUrl(tgChatId, tgThreadId, firstTgMessageId(r.tgMessageId, r.tgMessageIds));
      if (u) m.set(r.id, u);
    }
    return m;
  }, [runs, tgChatId, tgThreadId]);

  const methodLabel = (m: string | null) =>
    m === "db" ? t("method_db") : m === "json" ? t("method_json") : m === "local" ? t("method_local") : m === "hm-full" ? t("method_hm_full") : m === "pg-full" ? t("method_pg_full") : m === "rb-full" ? t("method_rb_full") : "—";

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleRow(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) if (on) next.add(r.id); else next.delete(r.id);
      return next;
    });
  }
  async function doBulkDelete() {
    setBulkBusy(true);
    try {
      const ids = [...selected];
      const results = await Promise.allSettled(ids.map((id) => fetch(`/api/backups/${id}`, { method: "DELETE" })));
      const failed = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
      toast(failed ? { title: t("error"), variant: "destructive" } : { title: t("deleted") });
      setSelected(new Set());
      onRefresh();
    } finally {
      setBulkBusy(false);
      setBulkOpen(false);
    }
  }

  // drop verify results of rows that no longer exist
  useEffect(() => {
    setVerified((prev) => {
      const alive = new Set(runs.map((r) => r.id));
      const next = new Map([...prev].filter(([id]) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  async function doVerify(run: BackupRunDTO) {
    setVerifyingId(run.id);
    try {
      const res = await fetch(`/api/backups/${run.id}/verify`);
      if (!res.ok) {
        toast({ title: t("error"), variant: "destructive" });
        return;
      }
      const data = await res.json();
      let result: VerifyResult;
      if (!data.exists) {
        result = { state: "missing", sha8: "" };
        toast({ title: t("verify_missing"), description: t("verify_missing_hint"), variant: "destructive" });
      } else if (!data.sizeMatch) {
        result = { state: "mismatch", sha8: String(data.sha256 ?? "").slice(0, 8) };
        toast({ title: t("verify_size_mismatch"), description: t("verify_size_mismatch_hint"), variant: "destructive" });
      } else {
        result = { state: "ok", sha8: String(data.sha256 ?? "").slice(0, 8) };
        toast({ title: t("verify_ok"), description: `SHA-256 ${result.sha8}… · ${t("verify_ok_hint")}` });
      }
      setVerified((prev) => new Map(prev).set(run.id, result));
    } catch {
      toast({ title: t("network_error"), variant: "destructive" });
    } finally {
      setVerifyingId(null);
    }
  }

  async function doDelete(run: BackupRunDTO) {
    setBusyId(run.id);
    try {
      const res = await fetch(`/api/backups/${run.id}`, { method: "DELETE" });
      if (res.ok) {
        toast({ title: t("deleted") });
        onRefresh();
      } else {
        toast({ title: t("error"), variant: "destructive" });
      }
    } finally {
      setBusyId(null);
      setDeleting(null);
    }
  }

  // export the rows currently shown (both filters applied) as CSV — BOM first
  // so Excel opens UTF-8 names correctly
  function exportCsv() {
    const esc = (v: string | number | null) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = "id,time,panel,trigger,method,status,file,size_bytes,duration_sec,error";
    const lines = rows.map((r) =>
      [
        r.id,
        r.startedAt,
        r.panel,
        r.trigger,
        r.method ?? "",
        r.status,
        r.fileName ?? `#${r.id}`,
        r.fileSize ?? 0,
        r.durationMs != null ? (r.durationMs / 1000).toFixed(1) : "",
        r.error ? resolveText(r.error, "en").replace(/\r?\n/g, " ") : "",
      ].map(esc).join(",")
    );
    const blob = new Blob(["\uFEFF" + [head, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = url;
    a.download = `bkup-history-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: t("csv_exported"), description: `${rows.length} ${t("activity_total")}` });
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="text-base">{t("backups_title")}</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={exportCsv}
            disabled={rows.length === 0}
            title={t("export_csv")}
          >
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("export_csv")}</span>
          </Button>
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" className="h-8" onClick={() => setBulkOpen(true)} disabled={bulkBusy}>
              <Trash2 className="h-3.5 w-3.5" />
              {t("delete_selected")} ({selected.size})
            </Button>
          )}
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onRefresh} aria-label={t("refresh")}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {(["all", "success", "failed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f === "all" ? t("filter_all") : f === "success" ? t("success") : t("failed")}
                <span
                  className={`rounded px-1 text-[10px] tabular-nums ${
                    filter === f ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
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
            {PANELS.map((p) => (
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
          <div className="relative ms-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("backups_search_ph")}
              aria-label={t("backups_search_ph")}
              className="h-8 pe-8 ps-8 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("backups_search_clear")}
                title={t("backups_search_clear")}
                className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center text-muted-foreground">
            <Inbox className="mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">{runs.length === 0 ? t("no_backups_yet") : t("reassembly_no_match")}</p>
            <p className="mt-0.5 text-xs opacity-80">{runs.length === 0 ? t("no_backups_hint") : t("backups_filter_hint")}</p>
          </div>
        ) : (
          <div className="custom-scroll max-h-[62vh] overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      aria-label={t("select_all")}
                      onCheckedChange={(v) => toggleAll(v === true)}
                    />
                  </TableHead>
                  <TableHead className="min-w-40">{t("col_time")}</TableHead>
                  <TableHead className="min-w-44">{t("col_file")}</TableHead>
                  <TableHead>{t("col_method")}</TableHead>
                  <TableHead>{t("col_size")}</TableHead>
                  <TableHead>{t("col_duration")}</TableHead>
                  <TableHead>{t("col_status")}</TableHead>
                  <TableHead className="text-end">{t("col_actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="group data-[state=selected]:bg-primary/5" data-state={selected.has(r.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.id)}
                        aria-label={r.fileName ?? `#${r.id}`}
                        onCheckedChange={(v) => toggleRow(r.id, v === true)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      <TimeAgo date={r.startedAt} className="text-xs" />
                      <span className="ms-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {r.trigger === "auto" ? t("trigger_auto") : t("trigger_manual")}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="block truncate text-xs font-medium" dir="ltr" title={r.fileName ?? ""}>
                        {r.fileName ?? `#${r.id}`}
                      </span>
                      {verified.has(r.id) ? (
                        (() => {
                          const v = verified.get(r.id)!;
                          return v.state === "ok" ? (
                            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-700" title={`${t("verify_ok")} — ${t("verify_ok_hint")}`}>
                              <ShieldCheck className="h-3 w-3" />
                              {t("verify_chip")} · {v.sha8}
                            </span>
                          ) : v.state === "mismatch" ? (
                            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700" title={t("verify_size_mismatch_hint")}>
                              <ShieldAlert className="h-3 w-3" />
                              {t("verify_size_mismatch")} · {v.sha8}
                            </span>
                          ) : (
                            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-red-500/10 px-1 py-0.5 text-[10px] font-medium text-red-700" title={t("verify_missing_hint")}>
                              <ShieldX className="h-3 w-3" />
                              {t("verify_missing")}
                            </span>
                          );
                        })()
                      ) : r.error && (
                        <span className="block truncate text-[11px] text-red-600" title={resolveText(r.error, "en")}>
                          {t("error_msg")}: {resolveText(r.error, "en")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{methodLabel(r.method)}</Badge>
                      <Badge variant="outline" className="ms-1 text-[10px] uppercase">{r.panel === "hmpanel" ? "HM" : r.panel === "pasarguard" ? "PG" : r.panel === "rebecca" ? "RB" : "3X"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{formatBytes(r.fileSize)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatDuration(r.durationMs)}</TableCell>
                    <TableCell>
                      {r.status === "success" ? (
                        <Badge className="bg-primary text-primary-foreground text-[10px]">
                          {t("success")}
                        </Badge>
                      ) : r.status === "failed" ? (
                        <Badge variant="destructive" className="text-[10px]">{t("failed")}</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[10px] text-emerald-700">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                          {t("running_now")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                        {r.filePath && r.status === "success" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => doVerify(r)}
                            disabled={verifyingId === r.id}
                            title={verifyingId === r.id ? t("verifying") : t("verify")}
                            aria-label={t("verify")}
                          >
                            <ShieldCheck className={`h-3.5 w-3.5 ${verifyingId === r.id ? "animate-pulse" : ""}`} />
                          </Button>
                        )}
                        {r.filePath && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                            <a href={`/api/backups/${r.id}/download`} download title={t("download")}>
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        )}
                        {!r.tgDeleted && tgUrl.has(r.id) && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                            <a
                              href={tgUrl.get(r.id)}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={t("open_in_tg")}
                              aria-label={t("open_in_tg")}
                            >
                              <Send className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-600 hover:text-red-700"
                          onClick={() => setDeleting(r)}
                          disabled={busyId === r.id}
                          title={t("delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <AlertDialog open={bulkOpen} onOpenChange={(o) => !o && setBulkOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete_selected_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("delete_selected_confirm_desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                doBulkDelete();
              }}
            >
              {t("delete_selected")} ({selected.size})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("delete_confirm_desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleting) doDelete(deleting);
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
