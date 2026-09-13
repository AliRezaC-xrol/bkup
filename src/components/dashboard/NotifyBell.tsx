"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/components/dashboard/lang";

const LS_KEY = "bkup_notify_on";

/** Persisted on/off preference (permission itself lives in the browser). */
export function notifyEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(LS_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * Header bell — opts the operator into desktop notifications when a backup
 * FAILS. Off by default; enabling asks for the browser permission once.
 * The actual watching lives in page.tsx (it owns the polling loop).
 */
export function NotifyBell({ className }: { className?: string }) {
  const { t } = useLang();
  const { toast } = useToast();
  const [on, setOn] = useState(false);

  useEffect(() => {
    // read the stored preference after paint — same hydration-safe pattern
    // as ThemeToggle (satisfies react-hooks/set-state-in-effect)
    const raf = requestAnimationFrame(() => setOn(notifyEnabled()));
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggle = useCallback(async () => {
    if (on) {
      try { window.localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
      setOn(false);
      return;
    }
    if (typeof window === "undefined" || !("Notification" in window)) {
      toast({ title: t("notify_denied"), variant: "destructive" });
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast({ title: t("notify_denied"), variant: "destructive" });
      return;
    }
    try { window.localStorage.setItem(LS_KEY, "on"); } catch { /* private mode */ }
    setOn(true);
    toast({ title: t("notify_on") });
  }, [on, toast, t]);

  const label = on ? t("notify_disable") : t("notify_enable");

  return (
    <Button
      variant="outline"
      size="icon"
      className={className}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={() => void toggle()}
    >
      {on ? <Bell className="h-4 w-4 text-primary" /> : <BellOff className="h-4 w-4 text-muted-foreground" />}
    </Button>
  );
}
