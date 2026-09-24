/**
 * Target path validation for custom-path restore operations.
 * All checks are pure functions — no node imports, browser-safe.
 */

/**
 * Normalize a user-supplied restore target path:
 * - trim whitespace
 * - strip trailing slashes (except root "/")
 */
export function normalizeRestoreTargetPath(candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

/**
 * Validate a restore target path for SSH restore operations.
 * Returns null when valid, or a string error code when invalid.
 *
 * Rejected conditions:
 * - Empty path
 * - Relative paths (must be absolute starting with /)
 * - Paths containing ".." segments (escape prevention)
 * - Paths containing invalid characters (charset whitelist)
 * - System root paths (/, /bin, /boot, /dev, /etc, /home, /lib*, /opt, /proc, /root, /run, /sbin, /srv, /sys, /tmp, /usr, /var)
 * - Paths with depth < 2 (too broad: /foo is refused, /foo/bar is minimum)
 */
export function validateRestoreTargetPath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return "TARGET_PATH_REQUIRED";
  if (!trimmed.startsWith("/")) return "TARGET_PATH_MUST_BE_ABSOLUTE";
  if (/\.\./.test(trimmed)) return "TARGET_PATH_NO_DOTDOT";
  // Charset whitelist: ASCII alphanumerics, space, dot, underscore, plus, minus, slash
  if (/[^A-Za-z0-9 ._+\-/]/.test(trimmed)) return "TARGET_PATH_INVALID_CHARS";

  const normalized = normalizeRestoreTargetPath(trimmed);

  if (REFUSED_SYSTEM_ROOTS.includes(normalized)) return "TARGET_PATH_REFUSED";

  // Depth check: require at least 2 levels (/foo/bar minimum)
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return "TARGET_PATH_TOO_BROAD";

  return null;
}

/** System directories a directory restore must never be pointed at. */
export const REFUSED_SYSTEM_ROOTS: readonly string[] = [
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64",
  "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var",
];

/**
 * Validate the ORIGIN of a directory backup — the directory it was taken from,
 * recorded by bkup itself when the archive was created. A custom-path restore
 * always goes back to that directory ("restore where it came from"), so this
 * path is no longer user-typed input and the two-level depth rule does not
 * apply: a one-level directory such as /data is a legitimate backup source and
 * must be restorable back onto itself.
 *
 * Everything else still holds: it must be absolute, must not contain "..", and
 * must never be a system root (/etc, /usr, /var, …) or the filesystem root.
 */
export function validateRestoreOriginPath(candidate: string): string | null {
  const trimmed = (candidate ?? "").trim();
  if (!trimmed) return "TARGET_PATH_REQUIRED";
  if (!trimmed.startsWith("/")) return "TARGET_PATH_MUST_BE_ABSOLUTE";
  if (trimmed.includes("..")) return "TARGET_PATH_NO_DOTDOT";
  if (/[^A-Za-z0-9 ._+\-/]/.test(trimmed)) return "TARGET_PATH_INVALID_CHARS";

  const normalized = normalizeRestoreTargetPath(trimmed);
  if (REFUSED_SYSTEM_ROOTS.includes(normalized)) return "TARGET_PATH_REFUSED";

  return null;
}
