import http from "node:http";
import https from "node:https";

/**
 * Process-wide shared HTTP(S) agents.
 *
 * Every outbound client (3x-ui, HMPanel, PasarGuard, Rebecca) previously built
 * its own keep-alive agents per request — sockets and their timers piled up in
 * the long-running server process (slow, unbounded RAM growth). These cached
 * singletons are reused by every client instead; Node's shared agents handle
 * socket reuse and cleanup deterministically.
 */
let strictHttp: http.Agent | null = null;
let strictHttps: https.Agent | null = null;
let looseHttps: https.Agent | null = null;

export function sharedHttpAgent(): http.Agent {
  if (!strictHttp) strictHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
  return strictHttp;
}

export function sharedHttpsAgent(insecure: boolean): https.Agent {
  if (insecure) {
    if (!looseHttps) {
      looseHttps = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 64 });
    }
    return looseHttps;
  }
  if (!strictHttps) strictHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });
  return strictHttps;
}
