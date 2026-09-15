"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, DatabaseBackup, AlertCircle, Eye, EyeOff } from "lucide-react";
import { useLang } from "@/components/dashboard/lang";
import { ThemeToggle } from "@/components/dashboard/ThemeToggle";

export function LoginScreen({
  mode,
  onAuthed,
}: {
  mode: "login" | "setup";
  onAuthed: () => void;
}) {
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "setup" && password !== confirm) {
      setError(t("setup_mismatch"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, setup: mode === "setup" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onAuthed();
      } else if (data.error === "WRONG_PASSWORD") {
        setError(t("login_wrong"));
      } else if (data.error === "PASSWORD_TOO_SHORT") {
        setError(t("login_too_short"));
      } else if (data.error === "PASSWORD_ALREADY_SET") {
        setError(t("password_already_set"));
      } else if (data.error === "SETUP_REQUIRED") {
        setError(t("setup_required"));
      } else if (data.error === "LOGIN_FAILED") {
        setError(t("login_failed"));
      } else {
        setError(data.error || t("error"));
      }
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* light/dark switch — top corner, outside the card flow */}
      <div className="absolute end-4 top-4 z-10">
        <ThemeToggle />
      </div>
      {/* monochrome backdrop: soft neutral washes + faint grid.
          The palette lives in globals.css (`.login-backdrop` / `.login-grid`):
          dark ink washes on the light theme, faint light washes on the dark
          theme — before this the ink-only backdrop went invisible/patchy as
          soon as the dark palette was active. */}
      <div className="login-backdrop pointer-events-none absolute inset-0" />
      <div className="login-grid pointer-events-none absolute inset-0" />

      <Card className="w-full max-w-md border-border bg-card/90 shadow-[0_0_60px_-15px_rgba(10,10,10,0.25)] backdrop-blur dark:shadow-[0_0_70px_-20px_rgba(255,255,255,0.10)]">
        <CardHeader className="items-center pb-2 text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_0_30px_-6px_rgba(10,10,10,0.5)] dark:shadow-[0_0_30px_-6px_rgba(255,255,255,0.28)]">
            <DatabaseBackup className="h-8 w-8" />
          </div>
          <CardTitle className="text-xl font-bold">
            <span dir="ltr" className="tracking-wide">bkup</span>
          </CardTitle>
          <CardDescription className="mt-1">
            {mode === "setup" ? t("setup_desc") : t("login_desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pw">
                {mode === "setup" ? t("setup_password") : t("login_password")}
              </Label>
              <div className="relative">
                <Input
                  id="pw"
                  type={showPw ? "text" : "password"}
                  dir="ltr"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 text-start pe-10"
                  minLength={4}
                  required
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  aria-pressed={showPw}
                  className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {mode === "setup" && (
              <div className="space-y-2">
                <Label htmlFor="pw2">{t("setup_confirm")}</Label>
                <div className="relative">
                  <Input
                    id="pw2"
                    type={showPw2 ? "text" : "password"}
                    dir="ltr"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="h-11 text-start pe-10"
                    minLength={4}
                    required
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPw2((v) => !v)}
                    aria-label={showPw2 ? "Hide password" : "Show password"}
                    aria-pressed={showPw2}
                    className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPw2 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" className="h-11 w-full gap-2 text-base font-bold" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "setup" ? t("setup_create") : t("login_enter")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
