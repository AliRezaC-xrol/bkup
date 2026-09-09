import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, GITHUB_REPO } from "@/lib/version";

const pexec = promisify(exec);

export type LatestInfo = {
  tag: string | null;
  version: string | null;
  commit: string | null;
  checkedAt: number;
  note: string | null;
};

export type SystemInfo = {
  appVersion: string;
  githubRepo: string;
  localCommit: string | null;
  port: number;
  platform: string;
  nodeVersion: string;
  hostname: string;
  processUptimeSec: number;
  osUptimeSec: number;
  startedAt: string;
  memoryMB: number;
  latest: LatestInfo | null;
  updateAvailable: boolean;
  updateState: UpdateState | null;
};

export type UpdateState = {
  state: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  fromVersion?: string;
  toVersion?: string;
  error?: string;
};

const cache: { latest?: LatestInfo } = {};
const CACHE_TTL = 5 * 60 * 1000;

export async function getLocalCommit(): Promise<string | null> {
  try {
    const { stdout } = await pexec("git rev-parse --short HEAD", { timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function fetchLatestFromGithub(): Promise<LatestInfo> {
  const now = Date.now();
  if (cache.latest && now - cache.latest.checkedAt < CACHE_TTL) return cache.latest;

  let info: LatestInfo = { tag: null, version: null, commit: null, checkedAt: now, note: null };
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "bkup",
    };
    // Auth precedence: GITHUB_TOKEN env → saved <app>/.github-token file.
    // The file fallback matters: installs created with a token (private /
    // flagged repo) must keep checking for updates even when the env var
    // is absent — update.sh already uses the same precedence.
    if (!process.env.GITHUB_TOKEN) {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const appDir = process.env.BKUP_APP_DIR || process.env.ABX_APP_DIR || process.cwd();
        const tokenFile = path.join(appDir, ".github-token");
        const saved = fs.readFileSync(tokenFile, "utf8").trim();
        if (saved) headers.Authorization = `Bearer ${saved}`;
      } catch {
        /* no saved token — anonymous is fine for public repos */
      }
    } else {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        tag_name?: string;
        target_commitish?: string;
        body?: string;
      };
      info.tag = data.tag_name ?? null;
      info.version = data.tag_name ? data.tag_name.replace(/^v/, "") : null;
      info.commit = data.target_commitish ?? null;
      info.note = data.body ? data.body.slice(0, 2000) : null;
    } else if (res.status === 404) {
      info.note = "NO_RELEASES";
    }
  } catch {
    info.note = "GITHUB_UNREACHABLE";
  }
  cache.latest = info;
  return info;
}

export function versionCompare(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function readUpdateState(): UpdateState | null {
  try {
    const file = path.join(process.cwd(), "data", "update-state.json");
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as UpdateState;
  } catch {
    return null;
  }
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const [localCommit, latest] = await Promise.all([getLocalCommit(), fetchLatestFromGithub()]);
  let updateAvailable = false;
  if (latest.version) {
    updateAvailable = versionCompare(latest.version, APP_VERSION) > 0;
  } else if (latest.commit && localCommit && latest.commit !== localCommit) {
    // fallback: commit compare when release tag missing
    updateAvailable = false; // only trust explicit releases for auto-update hint
  }
  return {
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    localCommit,
    port: Number(process.env.PORT || 3000),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    hostname: os.hostname(),
    processUptimeSec: Math.floor(process.uptime()),
    osUptimeSec: Math.floor(os.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    latest,
    updateAvailable,
    updateState: readUpdateState(),
  };
}
