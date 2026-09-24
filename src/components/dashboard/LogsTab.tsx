"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Trash2, Radio, Search, Copy, Check, Download, ArrowDownToLine, Pause, Play, SearchX,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";
import type { AppLogDTO } from "./types";
import { resolveText } from "@/lib/messages";
import { copyTextToClipboard } from "@/lib/copy-text";

// Log console has a dark background — use light-theme level colors on it
const LEVEL_STYLE: Record<string, string> = {
  info: "text-stone-400",
  success: "text-white font-extrabold",
  warn: "text-stone-100 underline decoration-red-400 decoration-2 underline-offset-4",
  error: "text-red-400",
};

const LEVEL_LABEL: Record<string, string> = {
  info: "info",
  success: "ok",
  warn: "warn",
  error: "error",
};

// chip tint per level (light-theme colors on the dark console)
const LEVEL_CHIP: Record<string, string> = {
  info: "data-[on=true]:bg-stone-500/25 data-[on=true]:text-stone-200",
  success: "data-[on=true]:bg-emerald-600/25 data-[on=true]:text-emerald-200",
  warn: "data-[on=true]:bg-amber-600/25 data-[on=true]:text-amber-200",
  error: "data-[on=true]:bg-red-600/25 data-[on=true]:text-red-200",
};

const LEVELS = ["info", "success", "warn", "error"] as const;

export function LogsTab({
  logs,
  onClear,
}: {
  logs: AppLogDTO[];
  onClear: () => void;
}) {
  const { t } = useLang();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<"all" | (typeof LEVELS)[number]>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true); // stick to bottom while new rows arrive
  const [copied, setCopied] = useState(false); // transient "Copied!" button feedback
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { info: 0, success: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level] = (c[l.level] ?? 0) + 1;
    return c;
  }, [logs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (level === "all" || l.level === level) &&
        (q === "" || resolveText(l.message, "en").toLowerCase().includes(q))
    );
  }, [logs, level, query]);

  // follow: only pin to bottom when the user hasn't scrolled away
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const time = (ts: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));

  const shownText = () =>
    shown
      .map((l) => `${l.ts} [${LEVEL_LABEL[l.level] ?? l.level}] ${resolveText(l.message, "en")}`)
      .join("\n");

  async function copyShown() {
    // plain-HTTP panels have no navigator.clipboard at all — the helper
    // falls back to the legacy textarea path there
    const ok = await copyTextToClipboard(shownText());
    if (ok) {
      toast({ title: t("copied") });
      // visual confirmation on the button itself, not only a toast
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      toast({
        title: t("error"),
        description: "Copying to the clipboard is not available in this browser context",
        variant: "destructive",
      });
    }
  }

  function downloadShown() {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const blob = new Blob([shownText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bkup-logs-${stamp}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom && !follow) setFollow(true);
    else if (!atBottom && follow) setFollow(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 border-border text-foreground">
            <Radio className="h-3 w-3 animate-pulse" />
            {t("logs_live")}
          </Badge>
          <Badge
            variant="outline"
            className={`gap-1 ${follow ? "border-emerald-600/40 text-emerald-600" : "border-amber-600/40 text-amber-600"}`}
            title={follow ? t("logs_follow_on") : t("logs_follow_off")}
          >
            {follow ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {follow ? t("logs_follow_on") : t("logs_follow_off")}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={copyShown}
            disabled={shown.length === 0}
            className={`gap-1.5 transition-colors ${copied ? "border-emerald-600/50 text-emerald-600" : ""}`}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("logs_copied") : t("logs_copy")}
          </Button>
          <Button variant="outline" size="sm" onClick={downloadShown} disabled={shown.length === 0} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            {t("logs_download")}
          </Button>
          <Button variant="outline" size="sm" onClick={onClear} className="gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            {t("logs_clear")}
          </Button>
        </div>
      </div>

      {/* filter row: level chips with counts + text search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          <button
            onClick={() => setLevel("all")}
            data-on={level === "all"}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors data-[on=true]:bg-primary data-[on=true]:text-primary-foreground ${level === "all" ? "" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t("logs_level_all")} <span className="tabular-nums opacity-70">{logs.length}</span>
          </button>
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevel(lv)}
              data-on={level === lv}
              title={`${LEVEL_LABEL[lv]} (${counts[lv] ?? 0})`}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${LEVEL_CHIP[lv]} ${level === lv ? "" : "text-muted-foreground hover:text-foreground"}`}
            >
              {LEVEL_LABEL[lv]} <span className="tabular-nums opacity-70">{counts[lv] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-44 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("logs_search")}
            className="h-8 ps-8 text-xs"
            aria-label={t("logs_search")}
          />
        </div>
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="log-console custom-scroll h-[480px] overflow-y-auto rounded-xl border bg-black/60 p-4 text-stone-100"
        >
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-700 text-center text-stone-400">
              {logs.length === 0 ? (
                <>
                  <Radio className="h-8 w-8 opacity-40" />
                  <p className="text-sm">{t("logs_empty")}…</p>
                </>
              ) : (
                <>
                  <SearchX className="h-8 w-8 opacity-40" />
                  <p className="text-sm">{t("logs_no_match")}</p>
                </>
              )}
            </div>
          ) : (
            shown.map((l, i) => (
              <div
                key={l.id}
                className={`-mx-1 flex items-baseline gap-2 rounded px-1 hover:bg-white/5 ${i % 2 === 1 ? "bg-white/[0.03]" : ""}`}
              >
                <span className="shrink-0 text-muted-foreground/60 tabular-nums" dir="ltr">
                  {time(l.ts)}
                </span>
                <span className={`shrink-0 font-bold ${LEVEL_STYLE[l.level] ?? ""}`}>
                  [{LEVEL_LABEL[l.level] ?? l.level}]
                </span>
                <span className="break-all">{resolveText(l.message, "en")}</span>
              </div>
            ))
          )}
        </div>

        {/* jump-to-latest affordance while follow is paused */}
        {!follow && (
          <Button
            size="sm"
            className="absolute bottom-3 end-4 gap-1.5 shadow-lg"
            onClick={() => {
              setFollow(true);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            {t("logs_jump_bottom")}
          </Button>
        )}
      </div>
    </div>
  );
}
