"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, Radio } from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import type { AppLogDTO } from "./types";
import { resolveText } from "@/lib/messages";

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

export function LogsTab({
  logs,
  onClear,
}: {
  logs: AppLogDTO[];
  onClear: () => void;
}) {
  const { t } = useLang();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const time = (ts: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 border-border text-foreground">
            <Radio className="h-3 w-3 animate-pulse" />
            {t("logs_live")}
          </Badge>
          <p className="text-sm text-muted-foreground">{t("logs_title")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClear} className="gap-1.5">
          <Trash2 className="h-3.5 w-3.5" />
          {t("logs_clear")}
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="log-console custom-scroll h-[480px] overflow-y-auto rounded-xl border bg-black/60 p-4 text-stone-100"
      >
        {logs.length === 0 ? (
          <p className="text-stone-400">{t("logs_empty")}…</p>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="flex items-baseline gap-2">
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
    </div>
  );
}
