"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Combine, Download, Trash2, UploadCloud, Inbox, Archive } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import { formatBytes } from "@/components/dashboard/types";
import { parsePartIndex } from "@/lib/reassembly";

export interface ReassembledDTO {
  id: number;
  name: string;
  panel: string;
  parts: number;
  size: number;
  createdAt: string;
}

const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "medium",
  }).format(new Date(iso));

interface BackupChoice {
  id: number;
  fileName: string | null;
  fileSize: number | null;
  startedAt: string;
  panel: string;
}

export function ReassemblyTab() {
  const { t } = useLang();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ReassembledDTO[]>([]);
  const [deleting, setDeleting] = useState<ReassembledDTO | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // source selection: upload part files, or use one of the stored backups
  const [source, setSource] = useState<"upload" | "backups">("upload");
  const [choices, setChoices] = useState<BackupChoice[]>([]);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/reassembly");
      if (res.ok) setHistory(await res.json());
    } catch { /* keep the old list */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const loadChoices = useCallback(async () => {
    setChoicesLoading(true);
    try {
      const res = await fetch("/api/backups?limit=200");
      if (res.ok) {
        const rows = (await res.json()) as (BackupChoice & { status: string; filePath: string | null })[];
        setChoices(rows.filter((r) => r.status === "success" && r.filePath));
      }
    } catch { /* keep the old list */ }
    setChoicesLoading(false);
  }, []);

  useEffect(() => {
    if (source === "backups") loadChoices();
  }, [source, loadChoices]);

  const sorted = useMemo(
    () => [...files].sort((a, b) => {
      const pa = parsePartIndex(a.name), pb = parsePartIndex(b.name);
      if (pa && pb && pa.index !== pb.index) return pa.index - pb.index;
      if (pa && !pb) return -1;
      if (!pa && pb) return 1;
      return a.name.localeCompare(b.name, "en", { numeric: true });
    }),
    [files]
  );
  const totalSize = sorted.reduce((n, f) => n + f.size, 0);
  const totals = sorted.map((f) => parsePartIndex(f.name)?.total ?? 0);
  const expected = Math.max(...totals, 0);
  const missing = expected ? expected - sorted.length : 0;

  async function reassemble() {
    if (!sorted.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of sorted) fd.append("files", f, f.name);
      const res = await fetch("/api/reassembly", { method: "POST", body: fd });
      if (res.ok) {
        toast({ title: t("reassembled") });
        setFiles([]);
        if (inputRef.current) inputRef.current.value = "";
        await loadHistory();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: body?.error ?? t("error"), variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  // store a backup picked from the Backups section as one complete reassembled file
  async function reassembleFromBackup() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reassembly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: selectedId }),
      });
      if (res.ok) {
        toast({ title: t("reassembled") });
        setSelectedId(null);
        await loadHistory();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg = body?.error === "BACKUP_FILE_GONE" || body?.error === "BACKUP_NOT_COMPLETE"
          ? t("reassembly_backup_gone")
          : body?.error ?? t("error");
        toast({ title: msg, variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(row: ReassembledDTO) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/reassembly/${row.id}`, { method: "DELETE" });
      if (res.ok) {
        toast({ title: t("deleted") });
        await loadHistory();
      } else {
        toast({ title: t("error"), variant: "destructive" });
      }
    } finally {
      setBusyId(null);
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Combine className="h-4 w-4" />
            {t("reassembly_title")}
          </CardTitle>
          <CardDescription>{source === "upload" ? t("reassembly_desc") : t("reassembly_backup_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex w-fit rounded-lg border p-0.5">
            {(["upload", "backups"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                aria-pressed={source === s}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  source === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "upload" ? <UploadCloud className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                {s === "upload" ? t("reassembly_source_upload") : t("reassembly_source_backups")}
              </button>
            ))}
          </div>

          {source === "upload" ? (
            <Input
              ref={inputRef}
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          ) : choices.length === 0 && !choicesLoading ? (
            <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              <Inbox className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {t("reassembly_no_backup_choices")}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">{t("reassembly_choose_backup")}</span>
                {choicesLoading ? (
                  <span className="text-xs text-muted-foreground">{t("loading")}</span>
                ) : (
                  <button
                    type="button"
                    onClick={loadChoices}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {t("refresh")}
                  </button>
                )}
              </div>
              <div className="custom-scroll max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-2">
                {choices.map((b) => {
                  const active = selectedId === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setSelectedId(active ? null : b.id)}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-3 rounded-md border p-2.5 text-start transition-colors ${
                        active ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                      }`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-primary" : "border-muted-foreground/40"}`}>
                        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium" dir="ltr" title={b.fileName ?? `#${b.id}`}>
                          {b.fileName ?? `#${b.id}`}
                        </span>
                        <span className="block text-[11px] tabular-nums text-muted-foreground">{fmtTime(b.startedAt)}</span>
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                        {b.panel === "hmpanel" ? "HM" : b.panel === "pasarguard" ? "PG" : b.panel === "rebecca" ? "RB" : "3X"}
                      </Badge>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(b.fileSize ?? 0)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {source === "upload" && sorted.length > 0 && (
            <div className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t("reassembly_selected")}:</span>
                <Badge variant="outline" className="text-[10px]">{sorted.length} × file</Badge>
                <Badge variant="outline" className="text-[10px]">{formatBytes(totalSize)}</Badge>
                {missing > 0 && (
                  <Badge variant="destructive" className="text-[10px]">
                    {missing} {t("reassembly_missing")}
                  </Badge>
                )}
              </div>
              <ol className="space-y-1">
                {sorted.map((f, i) => {
                  const p = parsePartIndex(f.name);
                  return (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="w-6 text-end tabular-nums text-muted-foreground">{i + 1}.</span>
                      <span className="truncate font-medium" dir="ltr">{f.name}</span>
                      {p && <Badge variant="outline" className="text-[10px]">Part {p.index}{p.total ? ` of ${p.total}` : ""}</Badge>}
                      <span className="ms-auto tabular-nums text-muted-foreground">{formatBytes(f.size)}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          <Button
            onClick={source === "upload" ? reassemble : reassembleFromBackup}
            disabled={busy || (source === "upload" ? sorted.length === 0 : !selectedId)}
            className="w-full gap-1.5"
          >
            {busy ? (
              <Combine className="h-4 w-4 animate-pulse" />
            ) : source === "upload" ? (
              <UploadCloud className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
            {t("reassembly_run")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("reassembly_history")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Inbox className="mx-auto mb-2 h-10 w-10 opacity-40" />
              <p className="text-sm">{t("reassembly_none_yet")}</p>
            </div>
          ) : (
            <div className="custom-scroll max-h-[55vh] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <TableRow>
                    <TableHead className="min-w-40">{t("col_time")}</TableHead>
                    <TableHead className="min-w-44">{t("col_file")}</TableHead>
                    <TableHead>{t("col_parts")}</TableHead>
                    <TableHead>{t("col_size")}</TableHead>
                    <TableHead className="text-end">{t("col_actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((r) => (
                    <TableRow key={r.id} className="group">
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtTime(r.createdAt)}</TableCell>
                      <TableCell className="max-w-56">
                        <span className="block truncate text-xs font-medium" dir="ltr" title={r.name}>{r.name}</span>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{r.parts}</Badge></TableCell>
                      <TableCell className="text-xs tabular-nums">{formatBytes(r.size)}</TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                            <a href={`/api/reassembly/${r.id}/download`} download title={t("download")}>
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </Button>
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
      </Card>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reassembly_delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reassembly_delete_confirm_desc")}</AlertDialogDescription>
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
    </div>
  );
}
