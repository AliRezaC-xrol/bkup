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
  const stripped = name.replace(/\.part\d+(?:of\d+)?(?=\.[^.]+$|\.[^.]+\.[^.]+$|$)/i, "");
  return stripped || name;
}

/** Every value detectPanel may return — "custom" is NOT a panel: it is one of
 *  bkup's own directory archives and is restored by unpacking, never by
 *  importing into a panel database. */
export type DetectedPanel = "3x-ui" | "hmpanel" | "pasarguard" | "rebecca" | "custom";

/**
 * Best-effort panel hint parsed from the file name.
 *
 * Must recognise the REAL file names each type produces — bkup never renames a
 * panel backup, so the name is whatever the source panel called it:
 *   3x-ui:      x-ui-backup-YYYYMMDD-HHMMSS.db        (panel's own database)
 *   HMPanel:    backup_full_<timestamp>.tar.gz        (panel's official archive id)
 *   PasarGuard: pasarguard_full_<timestamp>.tar.gz    (bkup full snapshot)
 *   Rebecca:    rebecca-backup-<ts>.rbbackup          (panel's official export)
 *   custom dir: bkup-custom_<label>_<hash>_<stamp>.tar.gz   (bkup custom path)
 *               custom_<label>_<hash>_<stamp>.tar.gz        (pre-1.3.1 name)
 * Getting this wrong once meant a reassembled HMPanel archive was labelled
 * "3x-ui" and the restore tried to push it into x-ui.db — a broken restore.
 *
 * Issue #10: the SAME mistake happened the other way round for custom-path
 * archives. Their name embeds the user's label, so `custom_pasarguard_<hash>_…`
 * matched the pasarguard rule and a directory archive was offered as a panel
 * restore. The custom prefix is therefore checked FIRST — it is bkup's own
 * naming, so no panel can ever produce it, and everything after it (including
 * a panel name inside the label) is just decoration.
 */
export function detectPanel(name: string): DetectedPanel {
  const n = (name.split(/[\\/]/).pop() || name).toLowerCase();

  // ── CUSTOM FIRST — bkup's own directory archives ──
  if (n.startsWith("bkup-custom_") || n.startsWith("custom_")) return "custom";

  if (
    n.includes("hmpanel") ||
    n.startsWith("hm-") ||
    n.includes("hm_") ||
    n.startsWith("backup_full_") || // HMPanel's official archive naming
    n.startsWith("backup_") && n.endsWith(".tar.gz") && !n.startsWith("backup_db_")
  )
    return "hmpanel";
  if (n.includes("pasarguard") || n.startsWith("pg-") || n.includes("pg_")) return "pasarguard";
  if (n.includes("rebecca") || n.endsWith(".rbbackup") || n.startsWith("rb-")) return "rebecca";
  return "3x-ui";
}

/** A part set whose declared parts are not all present in a selection. */
export interface PartGap {
  base: string; // stripped file name the parts belong to
  total: number; // declared part count (0 = unknown)
  have: number[]; // part numbers present in the selection
  missing: number[]; // part numbers of the set that are NOT selected
}

/**
 * Detect incomplete part sets inside a selection of file names.
 * A set is incomplete when any of its files declares "partNofM" and the
 * selection does not cover 1..M, or (without a declared total) when the
 * picked part numbers leave a hole (e.g. P1 and P3 but no P2). Files
 * without a part marker are complete backups — never reported.
 */
export function findPartGaps(names: string[]): PartGap[] {
  const groups = new Map<string, { index: number; total: number }[]>();
  for (const raw of names) {
    const name = raw.split(/[\\/]/).pop() || raw;
    const part = parsePartIndex(name);
    if (!part) continue; // complete file — nothing to account for
    const base = stripPartFromName(name);
    const list = groups.get(base) ?? [];
    list.push(part);
    groups.set(base, list);
  }
  const gaps: PartGap[] = [];
  for (const [base, parts] of groups) {
    const have = [...new Set(parts.map((p) => p.index))].sort((a, b) => a - b);
    const declared = Math.max(0, ...parts.map((p) => p.total));
    const missing: number[] = [];
    if (declared > 0) {
      // the set declares its size — every part 1..total must be picked
      const haveSet = new Set(have);
      for (let i = 1; i <= declared; i++) if (!haveSet.has(i)) missing.push(i);
    } else if (have.length >= 2) {
      // no declared total — at least flag a hole between the picked parts
      const haveSet = new Set(have);
      for (let i = have[0]; i <= have[have.length - 1]; i++) if (!haveSet.has(i)) missing.push(i);
    }
    if (missing.length > 0) gaps.push({ base, total: declared, have, missing });
  }
  return gaps;
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
