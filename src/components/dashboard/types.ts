export interface AppConfigDTO {
  id: number;
  panelType: "3x-ui" | "hmpanel"; // legacy v3.0 field
  xuiEnabled: boolean;
  panelUrl: string;
  panelBasePath: string;
  panelUsername: string;
  panelPassword: string;
  authMode: "session" | "bearer";
  apiToken: string;
  skipTlsVerify: boolean;
  hmEnabled: boolean;
  hmUrl: string;
  hmUsername: string;
  hmPassword: string;
  pgEnabled: boolean;
  pgUrl: string;
  pgUsername: string;
  pgPassword: string;
  hmPremium: boolean;
  rebeccaEnabled: boolean;
  rebeccaUrl: string;
  rebeccaUsername: string;
  rebeccaPassword: string;
  telegramApiBase: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramThreadId: string;
  intervalSeconds: number;
  enabled: boolean;
  backupMode: "auto" | "db" | "json" | "local";
  localDbPath: string;
  localRetention: number;
  tgAutoDeleteKeep: number;
  updatedAt: string;
}

export interface BackupRunDTO {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  trigger: "auto" | "manual";
  panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";
  method: "db" | "json" | "local" | "hm-full" | "pg-full" | "rb-full" | null;
  fileName: string | null;
  filePath: string | null;
  fileSize: number | null;
  tgMessageId: number | null;
  tgMessageIds: string | null;
  tgDeleted: boolean;
  error: string | null;
  durationMs: number | null;
}

export interface BackupCycleDTO {
  outcomes: BackupOutcomeDTO[];
  ok: boolean;
  durationMs: number;
}

export interface BackupOutcomeDTO {
  runId: number;
  panel: "3x-ui" | "hmpanel" | "pasarguard" | "rebecca";
  status: "success" | "failed" | "skipped";
  method?: string;
  fileName?: string;
  fileSize?: number;
  tgMessageId?: number;
  error?: string;
  durationMs: number;
}

export interface StatusDTO {
  scheduler: {
    enabled: boolean;
    running: boolean;
    nextRunAt: number | null;
    intervalSeconds: number;
    lastTickAt: number | null;
  };
  stats: { total: number; success: number; failed: number; last24h: number };
  lastRun: BackupRunDTO | null;
  panels: {
    xui: { enabled: boolean; ready: boolean };
    hm: { enabled: boolean; ready: boolean; premium?: boolean };
    pg: { enabled: boolean; ready: boolean };
    rebecca: { enabled: boolean; ready: boolean };
    anyEnabled: boolean;
    anyReady: boolean;
  };
  configReady: { panel: boolean; telegram: boolean };
  panelType: "3x-ui" | "hmpanel";
}

export interface AppLogDTO {
  id: number;
  ts: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
}


export interface LatestReleaseDTO {
  tag: string | null;
  version: string | null;
  commit: string | null;
  checkedAt: number;
  note: string | null;
}

export interface UpdateStateDTO {
  state: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  fromVersion?: string;
  toVersion?: string;
  error?: string;
}

export interface SystemInfoDTO {
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
  latest: LatestReleaseDTO | null;
  updateAvailable: boolean;
  updateState: UpdateStateDTO | null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatFaTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
