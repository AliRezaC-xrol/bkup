import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

/**
 * Web-panel authentication:
 *  - password stored as scrypt hash (salt per install)
 *  - session = HMAC-signed token:  v<version>.<expiresAtMs>.<hmac(exp|version)>
 *  - bumping sessionsVersion invalidates every issued session
 */

export const SESSION_COOKIE = "abx_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

export type SystemRow = {
  id: number;
  passwordHash: string;
  passwordSalt: string;
  sessionSecret: string;
  sessionsVersion: number;
};

export async function getSystem(): Promise<SystemRow> {
  let row = await db.systemConfig.findUnique({ where: { id: 1 } });
  if (!row) {
    row = await db.systemConfig.create({ data: { id: 1 } });
  }
  return row;
}

export function hashPassword(password: string, salt?: string) {
  const s = salt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash, salt: s };
}

export function verifyPassword(password: string, row: SystemRow): boolean {
  if (!row.passwordHash) return false;
  const { hash } = hashPassword(password, row.passwordSalt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(row.passwordHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** First-time setup: create the panel password (only works when not set). */
export async function setupPassword(password: string) {
  const row = await getSystem();
  if (row.passwordHash) throw new Error("PASSWORD_ALREADY_SET");
  const secret = crypto.randomBytes(32).toString("hex");
  const { hash, salt } = hashPassword(password);
  await db.systemConfig.update({
    where: { id: 1 },
    data: { passwordHash: hash, passwordSalt: salt, sessionSecret: secret },
  });
  return issueSession();
}

/** Set a new password knowing the old one. */
export async function changePassword(current: string, next: string) {
  const row = await getSystem();
  if (!verifyPassword(current, row)) throw new Error("WRONG_PASSWORD");
  const { hash, salt } = hashPassword(next);
  await db.systemConfig.update({
    where: { id: 1 },
    data: {
      passwordHash: hash,
      passwordSalt: salt,
      sessionsVersion: { increment: 1 },
    },
  });
}

/** Set password without knowing the old one (CLI only — guarded by CLI secret). */
export async function setPasswordDirect(password: string) {
  const row = await getSystem();
  const { hash, salt } = hashPassword(password);
  const data: Record<string, unknown> = { passwordHash: hash, passwordSalt: salt };
  if (!row.sessionSecret) data.sessionSecret = crypto.randomBytes(32).toString("hex");
  await db.systemConfig.update({ where: { id: 1 }, data });
}

export async function isPasswordSet(): Promise<boolean> {
  const row = await getSystem();
  return Boolean(row.passwordHash);
}

// ── sessions ────────────────────────────────────────────────────────────

export async function issueSession(): Promise<string> {
  const row = await getSystem();
  if (!row.sessionSecret) throw new Error("NO_SECRET");
  const exp = Date.now() + SESSION_TTL_MS;
  const mac = crypto
    .createHmac("sha256", row.sessionSecret)
    .update(`${exp}.${row.sessionsVersion}`)
    .digest("hex");
  return `${exp}.${row.sessionsVersion}.${mac}`;
}

export async function verifySession(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const [expRaw, verRaw, mac] = token.split(".");
  const exp = Number(expRaw);
  const ver = Number(verRaw);
  if (!exp || Number.isNaN(ver) || !mac) return false;
  if (exp < Date.now()) return false;
  const row = await getSystem();
  const expected = crypto
    .createHmac("sha256", row.sessionSecret)
    .update(`${exp}.${row.sessionsVersion}`)
    .digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Read + verify the session cookie of the current request. */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/** Guard for API routes: returns a 401 NextResponse when unauthorized. */
export async function requireAuth(): Promise<Response | null> {
  if (await isAuthenticated()) return null;
  return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** Guard for CLI-called routes: X-CLI-Secret must match the shared secret file. */
export function isCliAuthorized(req: Request): boolean {
  const candidates = [
    process.env.CLI_SECRET || "", // literal secret from env
    path.join(process.cwd(), ".cli-secret"), // secret files:
    "/opt/auto-backup-xui/.cli-secret",
    path.join(process.cwd(), "..", ".cli-secret"),
  ];
  const provided = req.headers.get("x-cli-secret") || "";
  if (!provided || provided.length < 16) return false;
  const providedBuf = Buffer.from(provided);
  for (const c of candidates) {
    if (!c) continue;
    let secret = "";
    if (c.includes("/") && (c.endsWith(".cli-secret") || fs.existsSync(c))) {
      try {
        if (!fs.existsSync(c)) continue;
        secret = fs.readFileSync(c, "utf8").trim();
      } catch {
        continue;
      }
    } else {
      secret = c.trim();
    }
    try {
      if (secret.length >= 16 && crypto.timingSafeEqual(providedBuf, Buffer.from(secret))) {
        return true;
      }
    } catch {
      /* length mismatch — keep trying */
    }
  }
  return false;
}

/** Guard: allow either a web session or the CLI secret. */
export async function requireAuthOrCli(req: Request): Promise<Response | null> {
  if (isCliAuthorized(req)) return null;
  return requireAuth();
}
