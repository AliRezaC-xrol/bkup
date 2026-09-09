"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  LayoutDashboard, DatabaseBackup, Settings, ScrollText, ServerCog,
  LogOut, Menu, Zap, Loader2,
} from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import type { DictKey } from "@/lib/i18n";

export type TabKey = "dashboard" | "backups" | "settings" | "logs" | "system";

const NAV: { key: TabKey; icon: React.ReactNode; label: DictKey }[] = [
  { key: "dashboard", icon: <LayoutDashboard className="h-4.5 w-4.5" />, label: "nav_dashboard" },
  { key: "backups", icon: <DatabaseBackup className="h-4.5 w-4.5" />, label: "nav_backups" },
  { key: "settings", icon: <Settings className="h-4.5 w-4.5" />, label: "nav_settings" },
  { key: "logs", icon: <ScrollText className="h-4.5 w-4.5" />, label: "nav_logs" },
  { key: "system", icon: <ServerCog className="h-4.5 w-4.5" />, label: "nav_system" },
];

export function NavItems({
  tab,
  onTab,
  updateAvailable,
}: {
  tab: TabKey;
  onTab: (k: TabKey) => void;
  updateAvailable?: boolean;
}) {
  const { t } = useLang();
  return (
    <>
      {NAV.map((item) => (
        <button
          key={item.key}
          onClick={() => onTab(item.key)}
          className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
            tab === item.key
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {item.icon}
          <span className="flex-1 text-start">{t(item.label)}</span>
          {item.key === "system" && updateAvailable && (
            <span className="pulse-dot h-2 w-2 rounded-full bg-primary" aria-label="update" />
          )}
        </button>
      ))}
    </>
  );
}

import type { SystemInfoDTO } from "@/components/dashboard/types";

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <DatabaseBackup className="h-5 w-5" />
      </div>
      {!compact && (
        <div className="leading-tight">
          <p className="text-sm font-extrabold tracking-wide" dir="ltr">bkup</p>
          <p className="text-[11px] text-muted-foreground" dir="ltr">3x-ui / HMPanel / PasarGuard → Telegram</p>
        </div>
      )}
    </div>
  );
}

export function Shell({
  tab,
  onTab,
  onLogout,
  onBackupNow,
  backupBusy,
  isLive,
  info,
  children,
}: {
  tab: TabKey;
  onTab: (k: TabKey) => void;
  onLogout: () => void;
  onBackupNow: () => void;
  backupBusy: boolean;
  isLive: boolean;
  info: SystemInfoDTO | null;
  children: React.ReactNode;
}) {
  const { t } = useLang();
  const [mobileOpen, setMobileOpen] = useState(false);

  const go = (k: TabKey) => {
    onTab(k);
    setMobileOpen(false);
  };

  /**
   * Sidebar body = navigation + footer ONLY.
   * The brand header is rendered exactly once per surface:
   *   - desktop aside → <Brand /> + body below
   *   - mobile sheet  → SheetHeader(<Brand />) + the SAME body below
   * (Previously the body also contained <Brand />, so the mobile drawer
   *  showed the brand block twice — the "duplicate bkup menu item" bug.)
   */
  const sidebarBody = (
    <>
      <nav className="flex flex-1 flex-col gap-1">
        <NavItems tab={tab} onTab={go} updateAvailable={info?.updateAvailable} />
      </nav>

      <div className="space-y-3 border-t pt-3">
        <div className="flex items-center justify-between px-1">
          <Badge variant="outline" className="tabular-nums" dir="ltr">
            v{info?.appVersion ?? "?"}
          </Badge>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={onLogout}>
            <LogOut className="h-3.5 w-3.5" />
            {t("logout")}
          </Button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* ===== desktop sidebar ===== */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-e bg-card/40 backdrop-blur lg:block">
        <div className="flex h-full flex-col gap-6 p-4">
          <div className="px-1 pt-1">
            <Brand />
          </div>
          {sidebarBody}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ===== top header (mobile nav + quick actions) ===== */}
        <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            {/* mobile menu — opened via hamburger, closes on nav or outside tap */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" className="lg:hidden" aria-label="menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetHeader className="border-b p-4 text-start">
                  <SheetTitle>
                    <Brand />
                  </SheetTitle>
                </SheetHeader>
                <div className="flex h-[calc(100%-5rem)] flex-col gap-6 p-4">
                  {sidebarBody}
                </div>
              </SheetContent>
            </Sheet>

            <div className="lg:hidden">
              <Brand compact />
            </div>

            <div className="ms-auto flex items-center gap-2.5">
              <div className="hidden items-center gap-2 rounded-full border px-3 py-1.5 sm:flex">
                <span className={`pulse-dot inline-block h-2 w-2 rounded-full ${isLive ? "bg-primary" : "bg-stone-500"}`} />
                <span className="text-xs font-medium">{isLive ? t("active") : t("stopped")}</span>
              </div>
              <Button onClick={onBackupNow} disabled={backupBusy} size="sm" className="gap-1.5">
                {backupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                <span className="hidden sm:inline">{t("backup_now")}</span>
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>

        <footer className="mt-auto border-t">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground sm:px-6">
            <span>{t("appTagline")}</span>
            <Badge variant="outline" className="tabular-nums" dir="ltr">
              bkup v{info?.appVersion ?? "?"}
            </Badge>
          </div>
        </footer>
      </div>
    </div>
  );
}
