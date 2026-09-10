"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Server, Send, Timer, Save, Loader2, ShieldCheck, Info, KeyRound, Eye, Boxes, Shield,
} from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import type { AppConfigDTO } from "./types";
import { resolveText } from "@/lib/messages";

interface Props {
  config: AppConfigDTO | null;
  onSaved: (cfg: AppConfigDTO) => void;
  onPasswordChanged: () => void;
}

export function SettingsTab({ config, onSaved, onPasswordChanged }: Props) {
  const { t } = useLang();
  const { toast } = useToast();
  const [form, setForm] = useState<AppConfigDTO | null>(config);
  const [saving, setSaving] = useState(false);
  const [testingXui, setTestingXui] = useState(false);
  const [testingHm, setTestingHm] = useState(false);
  const [testingPg, setTestingPg] = useState(false);
  const [testingRebecca, setTestingRebecca] = useState(false);
  const [testingTg, setTestingTg] = useState(false);
  // ⚡ per-key toggle persistence: switches save INSTANTLY (optimistic) and
  // revert automatically if the request fails — a switch never silently
  // snaps back or lies about its state. Multiple switches can be in-flight
  // at the same time; each one only locks itself.
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  // ⚡ dirty-key tracking: while the user types (URL, username, …) a poll or a
  // single-key toggle must NEVER wipe unsaved edits — incoming configs are
  // merged field-by-field, keeping local values for dirty keys only.
  const dirtyKeys = useRef<Set<string>>(new Set());

  // security form
  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confPass, setConfPass] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  useEffect(() => {
    if (!config) return;
    setForm((prev) => {
      if (!prev) return config;
      if (dirtyKeys.current.size === 0) return config;
      const merged: AppConfigDTO = { ...config };
      for (const k of dirtyKeys.current) {
        if (k in prev) (merged as unknown as Record<string, unknown>)[k] = (prev as unknown as Record<string, unknown>)[k];
      }
      return merged;
    });
  }, [config?.id, config?.updatedAt]);

  if (!form) return null;

  const set = <K extends keyof AppConfigDTO>(key: K, value: AppConfigDTO[K]) => {
    dirtyKeys.current.add(key as string);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  /** Flip a boolean setting NOW (optimistic) and persist it immediately. */
  async function setNow(key: "enabled" | "xuiEnabled" | "hmEnabled" | "pgEnabled" | "rebeccaEnabled" | "skipTlsVerify", value: boolean) {
    if (!form) return;
    const prev = form[key];
    if (prev === value) return;
    if (toggling.has(key)) return; // this exact switch is already in-flight
    set(key, value); // optimistic — the switch shows the new state instantly
    setToggling((s) => new Set(s).add(key));
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        set(key, prev); // revert on failure — never lie to the user
        toast({ title: t("error"), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
        return;
      }
      dirtyKeys.current.delete(key); // persisted — server value is authoritative now
      onSaved(data); // authoritative config → synced everywhere (also kills stale polls)
    } catch {
      set(key, prev);
      toast({ title: t("error"), variant: "destructive" });
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  const collectDirty = (): Partial<AppConfigDTO> => ({ ...form });

  async function saveAll(silent = false): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectDirty()),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: t("error"), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
        return false;
      }
      dirtyKeys.current.clear(); // everything saved → server is authoritative
      onSaved(data);
      if (!silent) toast({ title: t("settings_saved") });
      return true;
    } catch {
      toast({ title: t("error"), variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function testPanel(panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca") {
    const setter =
      panel === "hmpanel"
        ? setTestingHm
        : panel === "pasarguard"
          ? setTestingPg
          : panel === "rebecca"
            ? setTestingRebecca
            : setTestingXui;
    setter(true);
    try {
      const res = await fetch("/api/config/test-panel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: collectDirty(), save: true, panel }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: t("test_panel"), description: resolveText(data.messageBi ?? data.message, "en") });
        // test+save persisted values — refresh parent state
        const cfgRes = await fetch("/api/config");
        if (cfgRes.ok) onSaved(await cfgRes.json());
      } else {
        toast({ title: t("error"), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
      }
    } finally {
      setter(false);
    }
  }

  async function testTelegram() {
    setTestingTg(true);
    try {
      const res = await fetch("/api/config/test-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: collectDirty(), save: true }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: t("test_tg"), description: resolveText(data.messageBi ?? data.message, "en") });
      } else {
        toast({ title: t("error"), description: resolveText(data.errorBi ?? data.error, "en"), variant: "destructive" });
      }
    } finally {
      setTestingTg(false);
    }
  }

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (newPass !== confPass) {
      toast({ title: t("pass_mismatch"), variant: "destructive" });
      return;
    }
    setChangingPw(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: curPass, next: newPass }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast({ title: t("pass_changed") });
        setCurPass(""); setNewPass(""); setConfPass("");
        setTimeout(onPasswordChanged, 1200);
      } else if (data.error === "WRONG_PASSWORD") {
        toast({ title: t("wrong_pass"), variant: "destructive" });
      } else {
        toast({ title: t("error"), variant: "destructive" });
      }
    } finally {
      setChangingPw(false);
    }
  }

  /** Status chip shown next to every switch — text always matches the real state. */
  function stateLabel(on: boolean) {
    return (
      <span
        className={`min-w-[3.25rem] text-center text-xs font-semibold ${on ? "text-primary" : "text-muted-foreground"}`}
        aria-live="polite"
      >
        {on ? t("state_on") : t("state_off")}
      </span>
    );
  }

  return (
    <div className="space-y-5">
      {/* ===== Master auto-backup switch — same `enabled` field as the dashboard ===== */}
      <Card className={form.enabled ? "border-primary/40" : undefined}>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="space-y-0.5">
            <Label htmlFor="autoEnabled" className="text-base">{t("settings_auto")}</Label>
            <p className="text-xs text-muted-foreground">{t("settings_auto_desc")}</p>
          </div>
          <div className="flex items-center gap-2">
            {stateLabel(form.enabled)}
            <Switch id="autoEnabled" checked={form.enabled} disabled={toggling.has("enabled")} onCheckedChange={(v) => void setNow("enabled", v)} aria-label={t("settings_auto")} />
          </div>
        </CardContent>
      </Card>

      {/* ===== Dual panels intro ===== */}
      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="text-muted-foreground">{t("dual_panels_hint")}</p>
      </div>

      {/* ===== Panel 1: 3x-ui ===== */}
      <Card className={form.xuiEnabled ? "border-primary/40" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              {t("panel_type_3xui")}
            </CardTitle>
            <div className="flex items-center gap-2">
              {stateLabel(form.xuiEnabled)}
              <Switch checked={form.xuiEnabled} disabled={toggling.has("xuiEnabled")} onCheckedChange={(v) => void setNow("xuiEnabled", v)} aria-label="3x-ui enable" />
            </div>
          </div>
          <CardDescription>{t("xui_card_desc")}</CardDescription>
        </CardHeader>
        {form.xuiEnabled && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="panelUrl">{t("panel_url")}</Label>
                <Input
                  id="panelUrl" dir="ltr" className="text-start"
                  placeholder={t("panel_url_ph")}
                  value={form.panelUrl}
                  onChange={(e) => set("panelUrl", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="basePath">{t("panel_base")}</Label>
                <Input
                  id="basePath" dir="ltr" className="text-start"
                  placeholder={t("panel_base_ph")}
                  value={form.panelBasePath}
                  onChange={(e) => set("panelBasePath", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("auth_mode")}</Label>
                <Select value={form.authMode} onValueChange={(v) => set("authMode", v as AppConfigDTO["authMode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="session">{t("auth_session")}</SelectItem>
                    <SelectItem value="bearer">{t("auth_bearer")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.authMode === "session" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="username">{t("panel_user")}</Label>
                    <Input id="username" dir="ltr" className="text-start" autoComplete="off"
                      value={form.panelUsername} onChange={(e) => set("panelUsername", e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">{t("panel_pass")}</Label>
                    <Input id="password" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                      placeholder={form.panelPassword ? "••••••••" : ""}
                      value={form.panelPassword} onChange={(e) => set("panelPassword", e.target.value)} />
                  </div>
                </>
              ) : (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="apiToken">{t("api_token")}</Label>
                  <Input id="apiToken" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                    placeholder={form.apiToken ? "••••••••" : "Settings → API Tokens"}
                    value={form.apiToken} onChange={(e) => set("apiToken", e.target.value)} />
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Info className="h-3 w-3" /> {t("api_token_hint")}
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
                <div className="space-y-0.5">
                  <Label htmlFor="tls">{t("skip_tls")}</Label>
                </div>
                <div className="flex items-center gap-2">
                  {stateLabel(form.skipTlsVerify)}
                  <Switch id="tls" checked={form.skipTlsVerify} disabled={toggling.has("skipTlsVerify")} onCheckedChange={(v) => void setNow("skipTlsVerify", v)} aria-label={t("skip_tls")} />
                </div>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>{t("settings_backup")}</Label>
                <Select value={form.backupMode} onValueChange={(v) => set("backupMode", v as AppConfigDTO["backupMode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t("mode_auto")}</SelectItem>
                    <SelectItem value="db">{t("mode_db")}</SelectItem>
                    <SelectItem value="json">{t("mode_json")}</SelectItem>
                    <SelectItem value="local">{t("mode_local")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.backupMode === "local" && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="localPath">{t("local_path")}</Label>
                  <Input id="localPath" dir="ltr" className="text-start" placeholder="/etc/x-ui/x-ui.db"
                    value={form.localDbPath} onChange={(e) => set("localDbPath", e.target.value)} />
                </div>
              )}
            </div>
            <Button variant="outline" onClick={() => testPanel("3x-ui")} disabled={testingXui} className="w-full sm:w-auto">
              {testingXui ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {t("test_panel")}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* ===== Panel 2: HM Panel ===== */}
      <Card className={form.hmEnabled ? "border-primary/40" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              {t("panel_type_hm")}
              {form.hmPremium && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  Premium
                </span>
              )}
              {!form.hmPremium && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                Free
                              </span>
                            )}
            </CardTitle>
            <div className="flex items-center gap-2">
              {stateLabel(form.hmEnabled)}
              <Switch checked={form.hmEnabled} disabled={toggling.has("hmEnabled")} onCheckedChange={(v) => void setNow("hmEnabled", v)} aria-label="HM Panel enable" />
            </div>
          </div>
          <CardDescription>{t("hm_card_desc")}</CardDescription>
        </CardHeader>
        {form.hmEnabled && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="hmUrl">{t("panel_url")}</Label>
                <Input
                  id="hmUrl" dir="ltr" className="text-start"
                  placeholder={t("hm_url_ph")}
                  value={form.hmUrl}
                  onChange={(e) => set("hmUrl", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("hm_url_hint")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="hmUsername">{t("panel_user")}</Label>
                <Input id="hmUsername" dir="ltr" className="text-start" autoComplete="off"
                  value={form.hmUsername} onChange={(e) => set("hmUsername", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hmPassword">{t("panel_pass")}</Label>
                <Input id="hmPassword" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                  placeholder={form.hmPassword ? "••••••••" : ""}
                  value={form.hmPassword} onChange={(e) => set("hmPassword", e.target.value)} />
              </div>
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3 w-3" /> {t("panel_type_hm_desc")}
            </p>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t("settings_backup")}</Label>
              </div>
              <Input disabled className="w-44 text-center" value={t("method_hm_full")} />
            </div>
            <Button variant="outline" onClick={() => testPanel("hmpanel")} disabled={testingHm} className="w-full sm:w-auto">
              {testingHm ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {t("test_panel")}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* ===== Panel 3: PasarGuard ===== */}
      <Card className={form.pgEnabled ? "border-primary/40" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4" />
              {t("panel_type_pg")}
            </CardTitle>
            <div className="flex items-center gap-2">
              {stateLabel(form.pgEnabled)}
              <Switch checked={form.pgEnabled} disabled={toggling.has("pgEnabled")} onCheckedChange={(v) => void setNow("pgEnabled", v)} aria-label="PasarGuard enable" />
            </div>
          </div>
          <CardDescription>{t("pg_card_desc")}</CardDescription>
        </CardHeader>
        {form.pgEnabled && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="pgUrl">{t("panel_url")}</Label>
                <Input
                  id="pgUrl" dir="ltr" className="text-start"
                  placeholder={t("pg_url_ph")}
                  value={form.pgUrl}
                  onChange={(e) => set("pgUrl", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("pg_url_hint")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pgUsername">{t("panel_user")}</Label>
                <Input id="pgUsername" dir="ltr" className="text-start" autoComplete="off"
                  value={form.pgUsername} onChange={(e) => set("pgUsername", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pgPassword">{t("panel_pass")}</Label>
                <Input id="pgPassword" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                  placeholder={form.pgPassword ? "••••••••" : ""}
                  value={form.pgPassword} onChange={(e) => set("pgPassword", e.target.value)} />
              </div>
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3 w-3" /> {t("panel_type_pg_desc")}
            </p>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t("settings_backup")}</Label>
              </div>
              <Input disabled className="w-44 text-center" value={t("method_pg_full")} />
            </div>
            <Button variant="outline" onClick={() => testPanel("pasarguard")} disabled={testingPg} className="w-full sm:w-auto">
              {testingPg ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {t("test_panel")}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* ===== Panel 4: Rebecca ===== */}
      <Card className={form.rebeccaEnabled ? "border-primary/40" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" />
              {t("panel_type_rb")}
            </CardTitle>
            <div className="flex items-center gap-2">
              {stateLabel(form.rebeccaEnabled)}
              <Switch checked={form.rebeccaEnabled} disabled={toggling.has("rebeccaEnabled")} onCheckedChange={(v) => void setNow("rebeccaEnabled", v)} aria-label="Rebecca enable" />
            </div>
          </div>
          <CardDescription>{t("rb_card_desc")}</CardDescription>
        </CardHeader>
        {form.rebeccaEnabled && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="rebeccaUrl">{t("panel_url")}</Label>
                <Input
                  id="rebeccaUrl" dir="ltr" className="text-start"
                  placeholder={t("rb_url_ph")}
                  value={form.rebeccaUrl}
                  onChange={(e) => set("rebeccaUrl", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("rb_url_hint")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rebeccaUsername">{t("panel_user")}</Label>
                <Input id="rebeccaUsername" dir="ltr" className="text-start" autoComplete="off"
                  value={form.rebeccaUsername} onChange={(e) => set("rebeccaUsername", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rebeccaPassword">{t("panel_pass")}</Label>
                <Input id="rebeccaPassword" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                  placeholder={form.rebeccaPassword ? "••••••••" : ""}
                  value={form.rebeccaPassword} onChange={(e) => set("rebeccaPassword", e.target.value)} />
              </div>
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3 w-3" /> {t("panel_type_rb_desc")}
            </p>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t("settings_backup")}</Label>
              </div>
              <Input disabled className="w-44 text-center" value={t("method_rb_full")} />
            </div>
            <Button variant="outline" onClick={() => testPanel("rebecca")} disabled={testingRebecca} className="w-full sm:w-auto">
              {testingRebecca ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {t("test_panel")}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* ===== Telegram (shared destination) ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4" />
            {t("settings_tg")}
          </CardTitle>
          <CardDescription>{t("settings_tg_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tgToken">{t("tg_token")}</Label>
              <Input id="tgToken" dir="ltr" className="text-start" type="password" autoComplete="new-password"
                placeholder={form.telegramBotToken ? "••••••••" : "123456:ABC-DEF..."}
                value={form.telegramBotToken} onChange={(e) => set("telegramBotToken", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chatId">{t("tg_chat")}</Label>
              <Input id="chatId" dir="ltr" className="text-start"
                placeholder={t("tg_chat_ph")}
                value={form.telegramChatId} onChange={(e) => set("telegramChatId", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="threadId">{t("tg_thread")}</Label>
              <Input id="threadId" dir="ltr" className="text-start"
                value={form.telegramThreadId} onChange={(e) => set("telegramThreadId", e.target.value)} />
            </div>
          </div>

          <Button variant="outline" onClick={testTelegram} disabled={testingTg} className="w-full sm:w-auto">
            {testingTg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            {t("test_tg")}
          </Button>
        </CardContent>
      </Card>

      {/* ===== Scheduling ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4" />
            {t("settings_schedule")}
          </CardTitle>
          <CardDescription dir="ltr">{t("interval_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="interval">{t("interval")}</Label>
              <Input id="interval" dir="ltr" className="text-start" type="number" min={10} max={86400}
                value={form.intervalSeconds}
                onChange={(e) => set("intervalSeconds", Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="retention">{t("local_retention")}</Label>
              <Input id="retention" dir="ltr" className="text-start" type="number" min={0}
                value={form.localRetention} onChange={(e) => set("localRetention", Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tgKeep">{t("tg_keep")}</Label>
              <Input id="tgKeep" dir="ltr" className="text-start" type="number" min={0}
                value={form.tgAutoDeleteKeep} onChange={(e) => set("tgAutoDeleteKeep", Number(e.target.value))} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ===== Security ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            {t("security")}
          </CardTitle>
          <CardDescription>{t("security_desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePw} className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="curPw">{t("current_pass")}</Label>
              <Input id="curPw" type="password" dir="ltr" className="text-start" autoComplete="current-password"
                value={curPass} onChange={(e) => setCurPass(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPw">{t("new_pass")}</Label>
              <Input id="newPw" type="password" dir="ltr" className="text-start" autoComplete="new-password" minLength={4}
                value={newPass} onChange={(e) => setNewPass(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confPw">{t("confirm_pass")}</Label>
              <Input id="confPw" type="password" dir="ltr" className="text-start" autoComplete="new-password" minLength={4}
                value={confPass} onChange={(e) => setConfPass(e.target.value)} required />
            </div>
            <div className="sm:col-span-3">
              <Button type="submit" variant="outline" disabled={changingPw} className="gap-2">
                {changingPw ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t("change_pass")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 z-10">
        <Button onClick={() => saveAll()} disabled={saving} size="lg" className="w-full gap-2 shadow-lg">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("save")}
        </Button>
      </div>
    </div>
  );
}
