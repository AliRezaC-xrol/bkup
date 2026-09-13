"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/dashboard/lang";

/** One shared absolute-time formatter (Tehran, like every timestamp in the panel). */
const absoluteFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tehran",
  dateStyle: "short",
  timeStyle: "short",
});

function compactAgo(diffMs: number): string {
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * Relative timestamp with the absolute time on hover — "2h ago", title
 * "13/09/2026, 21:09". Ticks every 30 s so rows stay fresh without a
 * re-render storm (one interval per instance is fine at table scale).
 */
export function TimeAgo({
  date,
  className = "",
}: {
  date: string | number | Date;
  className?: string;
}) {
  const { t } = useLang();
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const d = new Date(date);
  const comp = compactAgo(Date.now() - d.getTime());
  const label = comp === "now" ? t("time_now") : t("time_ago").replace("{v}", comp);

  return (
    <time dateTime={d.toISOString()} title={absoluteFmt.format(d)} className={`tabular-nums ${className}`}>
      {label}
    </time>
  );
}
