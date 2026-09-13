/**
 * Cloudflare API helper — supports API Token (Bearer) and Global API Key (Email+Key)
 * Used for optional DNS management during restore.
 */

export interface CfCredentials {
  token?: string; // API Token (preferred)
  email?: string; // for Global API Key
  globalKey?: string; // Global API Key
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string;
}

function buildHeaders(creds: CfCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (creds.token && creds.token.trim()) {
    headers["Authorization"] = `Bearer ${creds.token.trim()}`;
  } else if (creds.email && creds.globalKey) {
    headers["X-Auth-Email"] = creds.email.trim();
    headers["X-Auth-Key"] = creds.globalKey.trim();
  } else {
    throw new Error("Missing Cloudflare credentials: provide API Token or Email+Global Key");
  }
  return headers;
}

async function cfFetch(
  path: string,
  creds: CfCredentials,
  init?: RequestInit
): Promise<any> {
  const headers = buildHeaders(creds);
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers as any) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const errMsg =
      data.errors?.[0]?.message ||
      data.errors?.[0] ||
      data.message ||
      `Cloudflare API error ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

export async function verifyCloudflare(creds: CfCredentials): Promise<{ ok: boolean; zones: CfZone[]; email?: string }> {
  // Try to list zones with per_page=1 to verify credentials
  const data = await cfFetch("/zones?per_page=1", creds, { method: "GET" });
  // If we get here, credentials are valid. Now fetch more zones.
  const zonesData = await cfFetch("/zones?per_page=50&order=name&direction=asc", creds, { method: "GET" });
  const zones: CfZone[] = (zonesData.result || []).map((z: any) => ({
    id: z.id,
    name: z.name,
    status: z.status,
    name_servers: z.name_servers,
  }));
  return { ok: true, zones };
}

export async function listZones(creds: CfCredentials, page = 1, perPage = 50): Promise<{ zones: CfZone[]; total: number }> {
  const data = await cfFetch(`/zones?per_page=${perPage}&page=${page}&order=name&direction=asc`, creds);
  const zones: CfZone[] = (data.result || []).map((z: any) => ({
    id: z.id,
    name: z.name,
    status: z.status,
    name_servers: z.name_servers,
  }));
  const total = data.result_info?.total_count || zones.length;
  return { zones, total };
}

export async function listDnsRecords(
  creds: CfCredentials,
  zoneId: string,
  opts?: { type?: string; name?: string; perPage?: number }
): Promise<CfDnsRecord[]> {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.name) params.set("name", opts.name);
  params.set("per_page", String(opts?.perPage || 100));
  const data = await cfFetch(`/zones/${zoneId}/dns_records?${params.toString()}`, creds);
  return (data.result || []).map((r: any) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: r.ttl,
    comment: r.comment,
  }));
}

export async function createDnsRecord(
  creds: CfCredentials,
  zoneId: string,
  record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; comment?: string }
): Promise<CfDnsRecord> {
  const data = await cfFetch(`/zones/${zoneId}/dns_records`, creds, {
    method: "POST",
    body: JSON.stringify({
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl || 1,
      proxied: record.proxied ?? false,
      comment: record.comment || "Created via bkup restore",
    }),
  });
  const r = data.result;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: r.ttl,
    comment: r.comment,
  };
}

export async function deleteDnsRecord(
  creds: CfCredentials,
  zoneId: string,
  recordId: string
): Promise<void> {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, creds, {
    method: "DELETE",
  });
}

export async function updateDnsRecord(
  creds: CfCredentials,
  zoneId: string,
  recordId: string,
  updates: { content?: string; name?: string; type?: string; proxied?: boolean; ttl?: number; comment?: string }
): Promise<CfDnsRecord> {
  const data = await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, creds, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  const r = data.result;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: !!r.proxied,
    ttl: r.ttl,
    comment: r.comment,
  };
}

export async function upsertDnsRecord(
  creds: CfCredentials,
  zoneId: string,
  zoneName: string,
  subName: string,
  ip: string,
  opts?: { proxied?: boolean; type?: string }
): Promise<{ action: "created" | "updated"; record: CfDnsRecord }> {
  const type = opts?.type || "A";
  // Build full DNS name: if subName is @ or zoneName itself, use zoneName, else subName.zoneName or if subName already contains zoneName use as is
  let fullName: string;
  if (!subName || subName === "@" || subName === zoneName) {
    fullName = zoneName;
  } else if (subName.endsWith(`.${zoneName}`)) {
    fullName = subName;
  } else if (subName.includes(".")) {
    // if user gave full subdomain like sub.example.com, keep it
    fullName = subName;
  } else {
    fullName = `${subName}.${zoneName}`;
  }

  // Search existing records for this name and type
  const existing = await listDnsRecords(creds, zoneId, { type, name: fullName, perPage: 100 });
  const match = existing.find((r) => r.name === fullName || r.name === subName);

  if (match) {
    const proxiedWanted = opts?.proxied ?? match.proxied;
    if (match.content === ip && match.proxied === proxiedWanted) {
      return { action: "updated", record: match }; // already correct
    }
    const updated = await updateDnsRecord(creds, zoneId, match.id, {
      content: ip,
      name: fullName,
      type,
      proxied: proxiedWanted,
      ttl: 1,
    });
    return { action: "updated", record: updated };
  } else {
    const created = await createDnsRecord(creds, zoneId, {
      type,
      name: fullName,
      content: ip,
      ttl: 1,
      proxied: opts?.proxied ?? false,
    });
    return { action: "created", record: created };
  }
}

// Optional: create API Token using Global API Key (requires email+globalKey)
// Permissions: Zone Read + DNS Edit for all zones
// Correct IDs verified from Cloudflare docs + Terraform provider drift logs:
// Zone Read = c8fed203ed3043cba015a93ad1616f1f
// DNS Edit  = 4755a26eedb94da69e1066d98aa820be (DNS Write)
export async function createApiToken(
  creds: CfCredentials,
  name: string,
  opts?: { zoneIds?: string[] }
): Promise<{ token: string; id: string }> {
  if (!creds.email || !creds.globalKey) {
    throw new Error("Creating API token requires Email + Global API Key");
  }

  // Preferred correct IDs
  const ZONE_READ_ID = "c8fed203ed3043cba015a93ad1616f1f";
  const DNS_EDIT_ID = "4755a26eedb94da69e1066d98aa820be";

  const resources = opts?.zoneIds?.length
    ? Object.fromEntries(opts.zoneIds.map((id) => [`com.cloudflare.api.account.zone.${id}`, "*"]))
    : { "com.cloudflare.api.account.zone.*": "*" };

  const body: any = {
    name: name || `bkup-${Date.now()}`,
    policies: [
      {
        effect: "allow",
        resources,
        permission_groups: [
          { id: ZONE_READ_ID, name: "Zone Read" },
          { id: DNS_EDIT_ID, name: "DNS Write" },
        ],
      },
    ],
    not_before: new Date().toISOString(),
    expires_on: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };

  try {
    const data = await cfFetch("/user/tokens", creds, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { token: data.result.value, id: data.result.id };
  } catch (e: any) {
    // Fallback without names, only IDs — some accounts require simpler payload
    const altBody = {
      name: name || `bkup-${Date.now()}`,
      policies: [
        {
          effect: "allow",
          resources: { "com.cloudflare.api.account.zone.*": "*" },
          permission_groups: [
            { id: ZONE_READ_ID },
            { id: DNS_EDIT_ID },
          ],
        },
      ],
    };
    const data = await cfFetch("/user/tokens", creds, {
      method: "POST",
      body: JSON.stringify(altBody),
    });
    return { token: data.result.value, id: data.result.id };
  }
}
