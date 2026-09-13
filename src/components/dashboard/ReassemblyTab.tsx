"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Combine, Download, Trash2, UploadCloud, Inbox, Archive, Check, X, Search, ChevronRight, AlertTriangle, Plus, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import { TimeAgo } from "@/components/dashboard/TimeAgo";
import { formatBytes } from "@/components/dashboard/types";
import { compareParts, findPartGaps, parsePartIndex, stripPartFromName } from "@/lib/reassembly";

export interface ReassembledDTO {
  id: number;
  name: string;
  panel: string;
  parts: number;
  size: number;
  createdAt: string;
}

interface BackupChoice {
  id: number;
  fileName: string | null;
  fileSize: number | null;
  startedAt: string;
  panel: string;
}

// integrity result pinned to a history row (same tri-state as Backups verify)
interface VerifyResult {
  state: "ok" | "mismatch" | "missing";
  sha8: string;
}

const panelShort = (panel: string) =>
  panel === "hmpanel" ? "HM" : panel === "pasarguard" ? "PG" : panel === "rebecca" ? "RB" : "3X";

// "[2, 2, 5]" -> "P2 ×2, P5" — several sets can miss the same part number
const formatMissing = (parts: number[]) =>
  [...new Set(parts)]
    .sort((a, b) => a - b)
    .map((n) => {
      const count = parts.filter((x) => x === n).length;
      return count > 1 ? `P${n} ×${count}` : `P${n}`;
    })
    .join(", ");

// Memoized row: picking one backup only re-renders the two rows whose
// selection changed — not the whole list.
const BackupChoiceRow = memo(function BackupChoiceRow({
  choice, active, onToggle,
}: {
  choice: BackupChoice;
  active: boolean;
  onToggle: (id: number) => void;
}) {
  const part = choice.fileName ? parsePartIndex(choice.fileName) : null;
  return (
    <button
      type="button"
      onClick={() => onToggle(choice.id)}
      aria-pressed={active}
      className={`flex w-full items-center gap-3 rounded-md border p-2.5 text-start transition-all ${
        active ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/25" : "hover:bg-muted/50"
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${active ? "border-primary bg-primary" : "border-muted-foreground/40"}`}>
        {active && <Check className="h-3 w-3 text-primary-foreground" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium" dir="ltr" title={choice.fileName ?? `#${choice.id}`}>
          {choice.fileName ?? `#${choice.id}`}
        </span>
        <TimeAgo date={choice.startedAt} className="block text-[11px] text-muted-foreground" />
      </span>
      {part && (
        <Badge variant="outline" className="shrink-0 text-[10px] tabular-nums">
          P{part.index}{part.total ? `/${part.total}` : ""}
        </Badge>
      )}
      <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
        {panelShort(choice.panel)}
      </Badge>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(choice.fileSize ?? 0)}</span>
    </button>
  );
});

// Memoized history row: idles while unrelated parts of the tab re-render.
const HistoryRow = memo(function HistoryRow({
  row, busy, verifyState, verifying, onVerify, onDelete,
}: {
  row: ReassembledDTO;
  busy: boolean;
  verifyState: VerifyResult | undefined;
  verifying: boolean;
  onVerify: (row: ReassembledDTO) => void;
  onDelete: (row: ReassembledDTO) => void;
}) {
  const { t } = useLang();
  return (
    <TableRow className="group">
      <TableCell className="whitespace-nowrap text-xs tabular-nums"><TimeAgo date={row.createdAt} className="text-xs" /></TableCell>
      <TableCell className="max-w-64">
        <div className="flex items-center gap-1.5">
          <span className="block truncate text-xs font-medium" dir="ltr" title={row.name}>{row.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">{panelShort(row.panel)}</Badge>
        </div>
        {verifyState && (
          verifyState.state === "ok" ? (
            <span
              className="mt-0.5 inline-flex cursor-default items-center gap-1 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-700"
              title={`${t("verify_ok")} — ${t("verify_ok_hint")} (SHA-256 ${verifyState.sha8}…)`}
            >
              <ShieldCheck className="h-3 w-3" />
              {t("verify_chip")} · {verifyState.sha8}
            </span>
          ) : verifyState.state === "mismatch" ? (
            <span
              className="mt-0.5 inline-flex cursor-default items-center gap-1 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700"
              title={t("verify_size_mismatch_hint")}
            >
              <AlertTriangle className="h-3 w-3" />
              {t("verify_size_mismatch")} · {verifyState.sha8}
            </span>
          ) : (
            <span
              className="mt-0.5 inline-flex cursor-default items-center gap-1 rounded bg-red-500/10 px-1 py-0.5 text-[10px] font-medium text-red-700"
              title={t("verify_missing_hint")}
            >
              <AlertTriangle className="h-3 w-3" />
              {t("verify_missing")}
            </span>
          )
        )}
      </TableCell>
      <TableCell><Badge variant="outline" className="text-[10px]">{row.parts}</Badge></TableCell>
      <TableCell className="text-xs tabular-nums">{formatBytes(row.size)}</TableCell>
      <TableCell className="text-end">
        <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onVerify(row)}
            disabled={verifying}
            title={verifying ? t("verifying") : t("verify")}
            aria-label={t("verify")}
          >
            <ShieldCheck className={`h-3.5 w-3.5 ${verifying ? "animate-pulse" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
            <a href={`/api/reassembly/${row.id}/download`} download title={t("download")}>
              <Download className="h-3.5 w-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-red-600 hover:text-red-700"
            onClick={() => onDelete(row)}
            disabled={busy}
            title={t("delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
});

export function ReassemblyTab() {
  const { t } = useLang();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ReassembledDTO[]>([]);
  const [deleting, setDeleting] = useState<ReassembledDTO | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // per-row integrity results — recomputing SHA-256 on demand, same as Backups
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [verified, setVerified] = useState<Map<number, VerifyResult>>(new Map());

  // source selection: upload part files, or merge parts stored in Backups
  const [source, setSource] = useState<"upload" | "backups">("upload");
  const [choices, setChoices] = useState<BackupChoice[]>([]);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSize = useMemo(
    () => choices.reduce((n, c) => (selectedSet.has(c.id) ? n + (c.fileSize ?? 0) : n), 0),
    [choices, selectedSet]
  );
  // picker filter: matches the file name or the panel tag, case-insensitive
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return choices;
    return choices.filter(
      (c) => (c.fileName ?? `#${c.id}`).toLowerCase().includes(q) || c.panel.toLowerCase().includes(q)
    );
  }, [choices, query]);
  // the exact order the parts will be merged in — decided by the part number
  const orderedSelected = useMemo(
    () =>
      choices
        .filter((c) => selectedSet.has(c.id))
        .sort((a, b) => compareParts(a.fileName ?? "", b.fileName ?? "")),
    [choices, selectedSet]
  );
  // two selected files claiming the same part number is almost always a mistake
  const dupParts = useMemo(() => {
    const idx = orderedSelected
      .map((c) => (c.fileName ? parsePartIndex(c.fileName)?.index : undefined))
      .filter((n): n is number => typeof n === "number");
    return new Set(idx).size !== idx.length;
  }, [orderedSelected]);
  // incomplete part sets: a declared "partNofM" whose siblings were not picked
  // (or a hole between picked part numbers) — merging would corrupt the file
  const gaps = useMemo(
    () => findPartGaps(orderedSelected.map((c) => c.fileName ?? "")),
    [orderedSelected]
  );
  const missingParts = useMemo(
    () => gaps.flatMap((g) => g.missing).sort((a, b) => a - b),
    [gaps]
  );
  // the missing siblings that ARE available in the picker — one click fixes it
  const missingChoiceIds = useMemo(() => {
    if (gaps.length === 0) return [] as number[];
    const ids: number[] = [];
    for (const c of choices) {
      const fileName = c.fileName;
      if (selectedSet.has(c.id) || !fileName) continue;
      const p = parsePartIndex(fileName);
      if (!p) continue;
      const gap = gaps.find((g) => g.base === stripPartFromName(fileName));
      if (gap?.missing.includes(p.index)) ids.push(c.id);
    }
    return ids;
  }, [gaps, choices, selectedSet]);
  // merge-order chips with ghost placeholders so the hole is visible exactly
  // where it falls (P1 → P2? → P3) — only when every pick carries a part number
  const chipRow = useMemo(() => {
    if (missingParts.length === 0) {
      return orderedSelected.map((c) => ({
        key: `s${c.id}`,
        label: c.fileName ? (parsePartIndex(c.fileName) ? `P${parsePartIndex(c.fileName)!.index}` : (c.fileName ?? `#${c.id}`).slice(0, 12)) : `#${c.id}`,
        ghost: false,
      }));
    }
    if (!orderedSelected.every((c) => c.fileName && parsePartIndex(c.fileName))) return [];
    type Chip = { key: string; index: number; label: string; ghost: boolean };
    const chips: Chip[] = orderedSelected.map((c) => ({
      key: `s${c.id}`,
      index: parsePartIndex(c.fileName!)!.index,
      label: `P${parsePartIndex(c.fileName!)!.index}`,
      ghost: false,
    }));
    for (const n of missingParts) {
      if (chips.some((c) => c.index === n)) continue;
      chips.push({ key: `g${n}`, index: n, label: `P${n}`, ghost: true });
    }
    return chips.sort((a, b) => a.index - b.index);
  }, [orderedSelected, missingParts]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/reassembly");
      if (res.ok) {
        const rows = (await res.json()) as ReassembledDTO[];
        setHistory(rows);
        // drop verify results of rows that no longer exist
        setVerified((cur) => {
          const alive = new Set(rows.map((r) => r.id));
          let changed = false;
          const next = new Map<number, VerifyResult>();
          for (const [id, v] of cur) {
            if (alive.has(id)) next.set(id, v);
            else changed = true;
          }
          return changed ? next : cur;
        });
      }
    } catch { /* keep the old list */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const choicesLoadedAt = useRef(0);
  const loadChoices = useCallback(async (force = false) => {
    // fresh results are reused — switching between the two sources stays instant
    if (!force && Date.now() - choicesLoadedAt.current < 30_000) return;
    setChoicesLoading(true);
    try {
      const res = await fetch("/api/backups?limit=200");
      if (res.ok) {
        const rows = (await res.json()) as (BackupChoice & { status: string; filePath: string | null })[];
        setChoices(rows.filter((r) => r.status === "success" && r.filePath));
        choicesLoadedAt.current = Date.now();
      }
    } catch { /* keep the old list */ }
    setChoicesLoading(false);
  }, []);

  useEffect(() => {
    if (source === "backups") loadChoices();
  }, [source, loadChoices]);

  const toggleChoice = useCallback((id: number) => {
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  const clearSelection = useCallback(() => setSelectedIds([]), []);

  // ticks the picker rows that hold the missing parts of the selected sets
  const addMissingParts = useCallback(() => {
    setSelectedIds((cur) => Array.from(new Set([...cur, ...missingChoiceIds])));
  }, [missingChoiceIds]);

  // ticks every row that passes the current filter — existing picks are kept
  const selectShown = useCallback(() => {
    setSelectedIds((cur) => Array.from(new Set([...cur, ...filtered.map((c) => c.id)])));
  }, [filtered]);

  const askDelete = useCallback((row: ReassembledDTO) => {
    setDeleting(row);
  }, []);

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

  // merge the picked backup runs — parts of the same file — into one complete
  // backup; merge order is the part number, decided server-side and shown here
  async function reassembleFromBackup() {
    if (!selectedIds.length) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reassembly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupIds: orderedSelected.map((c) => c.id) }),
      });
      if (res.ok) {
        toast({ title: t("reassembled") });
        setSelectedIds([]);
        await loadHistory();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg = body?.error === "BACKUP_FILE_GONE" || body?.error === "BACKUP_NOT_COMPLETE"
          ? t("reassembly_backup_gone")
          : body?.error === "MISSING_PARTS"
            ? t("reassembly_blocked")
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

  // recompute the SHA-256 of the merged file on disk and compare it with the
  // recorded size — a corrupted reassembled file must never reach a restore
  async function doVerify(row: ReassembledDTO) {
    setVerifyingId(row.id);
    try {
      const res = await fetch(`/api/reassembly/${row.id}/verify`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        toast({ title: t("error"), variant: "destructive" });
        return;
      }
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
      setVerified((cur) => new Map(cur).set(row.id, result));
    } finally {
      setVerifyingId(null);
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
          <div className="flex w-full rounded-lg border p-0.5">
            {(["upload", "backups"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                aria-pressed={source === s}
                className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium transition-colors sm:px-3 ${
                  source === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "upload" ? <UploadCloud className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                {s === "upload" ? t("reassembly_source_upload") : t("reassembly_source_backups")}
              </button>
            ))}
          </div>

          {source === "upload" ? (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length > 0) setFiles(dropped);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-6 text-center transition-colors ${
                dragOver ? "border-primary bg-primary/5" : "hover:bg-muted/50"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <UploadCloud className={`h-6 w-6 transition-colors ${dragOver ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-sm font-medium">{t("reassembly_drop_hint")}</span>
              <span className="text-xs text-muted-foreground">{t("reassembly_pick")}</span>
            </label>
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
                    onClick={() => loadChoices(true)}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {t("refresh")}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("reassembly_search_ph")}
                    aria-label={t("reassembly_search_ph")}
                    className="h-8 ps-8 text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={selectShown}
                  disabled={filtered.length === 0}
                  className="shrink-0 whitespace-nowrap rounded-md border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("reassembly_select_all_shown")}
                </button>
              </div>
              <div className="custom-scroll max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-2">
                {filtered.length === 0 && choices.length > 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">{t("reassembly_no_match")}</div>
                ) : (
                  filtered.map((b) => (
                    <BackupChoiceRow key={b.id} choice={b} active={selectedSet.has(b.id)} onToggle={toggleChoice} />
                  ))
                )}
              </div>
              {selectedIds.length > 0 && (
                <div className="space-y-2 rounded-lg border p-3 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{t("reassembly_selected_backups")}:</span>
                    <Badge variant="outline" className="text-[10px] tabular-nums">{selectedIds.length} × backup</Badge>
                    <Badge variant="outline" className="text-[10px] tabular-nums">{formatBytes(selectedSize)}</Badge>
                    {dupParts && (
                      <Badge variant="destructive" className="text-[10px]">{t("reassembly_dup_parts")}</Badge>
                    )}
                    {missingParts.length > 0 && (
                      <Badge variant="destructive" className="gap-1 text-[10px] tabular-nums">
                        <AlertTriangle className="h-3 w-3" />
                        {t("reassembly_missing_lbl")}: {formatMissing(missingParts)}
                      </Badge>
                    )}
                    {missingChoiceIds.length > 0 && (
                      <button
                        type="button"
                        onClick={addMissingParts}
                        className="flex items-center gap-1 rounded-md border border-dashed border-primary/50 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                      >
                        <Plus className="h-3 w-3" />
                        {t("reassembly_add_missing")} ({missingChoiceIds.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="ms-auto flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      <X className="h-3 w-3" />
                      {t("reassembly_clear")}
                    </button>
                  </div>
                  {chipRow.length > 0 && (
                    <div
                      className="flex flex-wrap items-center gap-1"
                      title={orderedSelected.map((c) => c.fileName ?? `#${c.id}`).join(" → ")}
                    >
                      {chipRow.slice(0, 14).map((chip, i) =>
                        chip.ghost ? (
                          <span
                            key={chip.key}
                            className="inline-flex items-center gap-1"
                          >
                            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
                            <span
                              className="rounded border border-dashed border-destructive/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-destructive"
                              title={t("reassembly_missing_lbl")}
                            >
                              {chip.label}
                            </span>
                          </span>
                        ) : (
                          <span key={chip.key} className="inline-flex items-center gap-1">
                            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground/80">
                              {chip.label}
                            </span>
                          </span>
                        )
                      )}
                      {chipRow.length > 14 && (
                        <span className="text-[10px] tabular-nums text-muted-foreground">+{chipRow.length - 14}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
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
            disabled={busy || (source === "upload" ? sorted.length === 0 : selectedIds.length === 0)}
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
                    <HistoryRow
                      key={r.id}
                      row={r}
                      busy={busyId === r.id}
                      verifyState={verified.get(r.id)}
                      verifying={verifyingId === r.id}
                      onVerify={doVerify}
                      onDelete={askDelete}
                    />
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
