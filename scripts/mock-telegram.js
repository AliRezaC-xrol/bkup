/**
 * Mock Telegram Bot API server — verifies our bot would really upload files.
 *   POST /bot<token>/sendDocument  -> stores file, returns { ok, result:{ message_id } }
 *   POST /bot<token>/sendMessage   -> { ok: true }
 *   POST /bot<token>/deleteMessage -> { ok: true }
 * Received documents are written to scripts/mock-tg-received/
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3031;
const SAVE_DIR = require("path").resolve(__dirname, "mock-tg-received");
fs.mkdirSync(SAVE_DIR, { recursive: true });

let msgId = 100;

function parseMultipart(body, boundary) {
  // latin1 keeps a 1:1 byte<->char mapping so we can slice then re-buffer safely
  const s = body.toString("latin1");
  const parts = {};
  const chunks = s.split(`--${boundary}`);
  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerBlock = chunk.slice(0, headerEnd);
    const content = chunk.slice(headerEnd + 4);
    // strip trailing \r\n
    const cleaned = content.endsWith("\r\n") ? content.slice(0, -2) : content;
    const nameMatch = headerBlock.match(/name="([^"]+)"/);
    const fileMatch = headerBlock.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    parts[name] = fileMatch
      ? { filename: fileMatch[1], data: Buffer.from(cleaned, "latin1") }
      : Buffer.from(cleaned, "latin1").toString("utf8");
  }
  return parts;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[MOCK-TG] ${req.method} ${url.pathname}`);

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (url.pathname.endsWith("/sendDocument")) {
      const boundary = (req.headers["content-type"] || "").match(/boundary=(.+)$/)?.[1];
      const parts = parseMultipart(body, boundary);
      const doc = parts.document;
      if (doc && doc.data && doc.data.length > 0) {
        fs.writeFileSync(path.join(SAVE_DIR, doc.filename), doc.data);
        console.log(`[MOCK-TG] received document: ${doc.filename} (${doc.data.length} bytes), chat=${parts.chat_id}`);
      }
      msgId++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
      return;
    }

    if (url.pathname.endsWith("/sendMessage")) {
      console.log(`[MOCK-TG] sendMessage to chat=${(() => { try { return JSON.parse(body.toString()).chat_id; } catch { return "?"; } })()}`);
      msgId++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
      return;
    }

    if (url.pathname.endsWith("/deleteMessage")) {
      console.log(`[MOCK-TG] deleteMessage: ${body.toString()}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "method not found" }));
  });
});

server.listen(PORT, () => console.log(`[MOCK-TG] listening on :${PORT}`));
