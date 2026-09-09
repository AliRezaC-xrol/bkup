/**
 * Bilingual message primitives — the single mechanism that keeps EVERY user
 * visible server string available in both panel languages.
 *
 * Backend layers (panel clients, backup service, API routes) produce `Bi`
 * pairs; the web panel picks the variant matching the active UI language.
 * Persian text stays the canonical fallback (DB rows, server console, legacy
 * clients) so nothing breaks for old consumers.
 */

export type Lang = "fa" | "en";

export interface Bi {
  fa: string;
  en: string;
}

/** Build a bilingual pair. */
export const bi = (fa: string, en: string): Bi => ({ fa, en });

/** Result failure carrying BOTH the canonical fa string and the Bi pair. */
export interface BiFail {
  ok: false;
  error: string; // canonical fa text (DB / console / legacy consumers)
  errorBi: Bi;
  status?: number;
}

/** Create a failure result: error (fa) + errorBi, spreadable into results. */
export function fail(fa: string, en: string, status?: number): BiFail {
  return { ok: false, error: fa, errorBi: bi(fa, en), ...(status !== undefined ? { status } : {}) };
}

/** Throw an Error whose message is the fa text but which carries the Bi pair. */
export function throwBi(fa: string, en: string): never {
  const e: Error & { bi?: Bi } = new Error(fa);
  e.bi = bi(fa, en);
  throw e;
}

/** Extract a Bi pair from a caught error (undefined when not bilingual). */
export function errorBiOf(e: unknown): Bi | undefined {
  return e instanceof Error ? (e as Error & { bi?: Bi }).bi : undefined;
}

/** Serialize a Bi pair for storage in a String DB column (or null if plain). */
export function storeBi(b: Bi | undefined, fallback: string): string {
  return b ? JSON.stringify(b) : fallback;
}

// ---------------------------------------------------------------------------
// Frontend helpers
// ---------------------------------------------------------------------------

/** Parse a value that may be a Bi pair (plain object or JSON string). */
export function parseBi(v: unknown): Bi | null {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.fa === "string" && typeof o.en === "string") return { fa: o.fa, en: o.en };
    return null;
  }
  if (typeof v === "string" && v.startsWith('{"')) {
    try {
      const o = JSON.parse(v) as Record<string, unknown>;
      if (typeof o.fa === "string" && typeof o.en === "string") return { fa: o.fa, en: o.en };
    } catch { /* legacy plain text */ }
  }
  return null;
}

/**
 * Resolve any user-visible server value for display:
 * Bi pair (object or JSON string) → active language; anything else → as-is.
 */
export function resolveText(v: unknown, lang: Lang): string {
  if (v == null) return "";
  const b = parseBi(v);
  if (b) return b[lang] || b.fa;
  return typeof v === "string" ? v : String(v);
}
