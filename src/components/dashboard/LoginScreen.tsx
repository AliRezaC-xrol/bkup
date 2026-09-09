"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, DatabaseBackup, AlertCircle } from "lucide-react";
import { useLang } from "@/components/dashboard/lang";

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
      {/* monochrome backdrop: soft neutral washes + faint grid */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 420px at 12% -5%, rgba(10,10,10,0.06), transparent 65%), radial-gradient(700px 520px at 95% 108%, rgba(10,10,10,0.045), transparent 65%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #0a0a0a 1px, transparent 1px), linear-gradient(to bottom, #0a0a0a 1px, transparent 1px)",
          backgroundSize: "36px 36px",
        }}
      />

      <Card className="w-full max-w-md border-border bg-card/90 shadow-[0_0_60px_-15px_rgba(10,10,10,0.25)] backdrop-blur">
        <CardHeader className="items-center pb-2 text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_0_30px_-6px_rgba(10,10,10,0.5)]">
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
              <Input
                id="pw"
                type="password"
                dir="ltr"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 text-start"
                minLength={4}
                required
              />
            </div>
            {mode === "setup" && (
              <div className="space-y-2">
                <Label htmlFor="pw2">{t("setup_confirm")}</Label>
                <Input
                  id="pw2"
                  type="password"
                  dir="ltr"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11 text-start"
                  minLength={4}
                  required
                />
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
