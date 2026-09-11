/**
 * Part-name helpers shared by the reassembly API route and the web panel.
 * Part files follow the "name.partNNofMM.ext" convention used by the
 * Telegram delivery (same approach as the reference panels).
 */

/** Extract the 1-based part index (and total when present) from a file name. */
export function parsePartIndex(name: string): { index: number; total: number } | null {
  const m = name.match(/part(\d+)(?:of(\d+))?/i);
  if (!m) return null;
  return { index: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : 0 };
}

/** Strip the ".partNNofMM" segment from a part name -> the original file name. */
export function stripPartFromName(name: string): string {
  const stripped = name.replace(/\.part\d+(?:of\d+)?(?=\.[^.]+$|$)/i, "");
  return stripped || name;
}

/** Best-effort panel hint parsed from the file name. */
export function detectPanel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("hmpanel") || n.startsWith("hm-") || n.includes("hm_")) return "hmpanel";
  if (n.includes("pasarguard")) return "pasarguard";
  if (n.includes("rebecca") || n.endsWith(".rbbackup")) return "rebecca";
  return "3x-ui";
}

/** Sort order of parts: by parsed index, then natural file-name order. */
export function compareParts(a: string, b: string): number {
  const pa = parsePartIndex(a);
  const pb = parsePartIndex(b);
  if (pa && pb && pa.index !== pb.index) return pa.index - pb.index;
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return a.localeCompare(b, "en", { numeric: true });
}
