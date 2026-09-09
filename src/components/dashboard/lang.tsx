"use client";

import { createContext, useContext, useMemo } from "react";
import { dict, type DictKey } from "@/lib/i18n";

/**
 * Language context — bkup ships a single UI language: English.
 * The provider keeps the same hook surface (`lang`, `dir`, `t`) so every
 * component reads identical, SSR-stable values with zero hydration risk.
 * There is no language selector by design; server messages that arrive
 * bilingual (see src/lib/messages.ts) are resolved to their English side.
 */

export type Lang = "en";

type LangCtx = {
  lang: Lang;
  dir: "ltr";
  t: (k: DictKey) => string;
};

const Ctx = createContext<LangCtx | null>(null);

const value: LangCtx = {
  lang: "en",
  dir: "ltr",
  t: (k: DictKey) => dict[k] ?? String(k),
};

export function LangProvider({ children }: { children: React.ReactNode }) {
  const memo = useMemo(() => value, []);
  return <Ctx.Provider value={memo}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang outside LangProvider");
  return ctx;
}
