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
import { Download, Trash2, RefreshCw, Inbox } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import type { BackupRunDTO } from "@/components/dashboard/types";
import { formatBytes, formatDuration } from "@/components/dashboard/types";
import { resolveText } from "@/lib/messages";

export function BackupsTab({ runs, onRefresh }: { runs: BackupRunDTO[]; onRefresh: () => void }) {
  const { t } = useLang();
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "success" | "failed">("all");
  const [deleting, setDeleting] = useState<BackupRunDTO | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // drop ids that no longer exist so the selection never goes stale
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(runs.map((r) => r.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  const rows = useMemo(
    () => (filter === "all" ? runs : runs.filter((r) => r.status === filter)),
    [runs, filter]
  );

  const methodLabel = (m: string | null) =>
    m === "db" ? t("method_db") : m === "json" ? t("method_json") : m === "local" ? t("method_local") : m === "hm-full" ? t("method_hm_full") : m === "pg-full" ? t("method_pg_full") : m === "rb-full" ? t("method_rb_full") : "—";

  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "medium",
    }).format(new Date(iso));

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

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="text-base">{t("backups_title")}</CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {(["all", "success", "failed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f === "all" ? t("filter_all") : f === "success" ? t("success") : t("failed")}
              </button>
            ))}
          </div>
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
        {rows.length === 0 ? (
          <div className="py-14 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm">{t("no_backups_yet")}</p>
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
                  <TableRow key={r.id} className="group" data-state={selected.has(r.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.id)}
                        aria-label={r.fileName ?? `#${r.id}`}
                        onCheckedChange={(v) => toggleRow(r.id, v === true)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {fmtTime(r.startedAt)}
                      <span className="ms-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {r.trigger === "auto" ? t("trigger_auto") : t("trigger_manual")}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="block truncate text-xs font-medium" dir="ltr" title={r.fileName ?? ""}>
                        {r.fileName ?? `#${r.id}`}
                      </span>
                      {r.error && (
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
                        <Badge variant="outline" className="text-[10px]">{t("running_now")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                        {r.filePath && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                            <a href={`/api/backups/${r.id}/download`} download title={t("download")}>
                              <Download className="h-3.5 w-3.5" />
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
