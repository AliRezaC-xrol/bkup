import { Client, type ConnectConfig } from "ssh2";
import fs from "node:fs";
import { EventEmitter } from "node:events";

/**
 * Promise-based SSH client built on top of ssh2.
 * Supports password and private-key auth, command execution with live
 * stdout/stderr streaming, and SFTP file upload with progress.
 *
 * All error messages are in English only — no Persian text anywhere.
 */

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string; // PEM-encoded private key content
  passphrase?: string; // private key passphrase
  timeout?: number;     // connect timeout ms (default 20s)
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
}

export interface SshExecOptions {
  /** Per-command timeout in ms. If exceeded the connection is killed. */
  timeout?: number;
  /** Stream stdout/stderr chunks as they arrive. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Environment variables to set for the command. */
  env?: Record<string, string>;
}

export class SshError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "SshError";
  }
}

export class SshClient extends EventEmitter {
  private conn: Client | null = null;
  private connected = false;

  get isConnected(): boolean {
    return this.connected;
  }

  /** Establish an SSH connection. Throws SshError on failure. */
  async connect(opts: SshOptions): Promise<void> {
    const cfg: ConnectConfig = {
      host: opts.host.trim(),
      port: opts.port || 22,
      username: opts.username.trim(),
      readyTimeout: opts.timeout ?? 20000,
      keepaliveInterval: 10000,
      algorithms: {
        serverHostKey: [
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "rsa-sha2-512",
          "rsa-sha2-256",
          "ssh-rsa",
          "ssh-dss",
        ],
      },
    };

    if (opts.password) {
      cfg.password = opts.password;
    } else if (opts.privateKey) {
      cfg.privateKey = opts.privateKey;
      if (opts.passphrase) cfg.passphrase = opts.passphrase;
    } else {
      throw new SshError(
        "No authentication method provided (password or private key required)",
        "NO_AUTH"
      );
    }

    return new Promise<void>((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;

      const timer = setTimeout(() => {
        try { conn.end(); } catch { /* ignore */ }
        reject(
          new SshError(
            "Connection to the server timed out",
            "ETIMEDOUT"
          )
        );
      }, opts.timeout ?? 20000);

      conn.on("ready", () => {
        clearTimeout(timer);
        this.connected = true;
        this.emit("connected");
        resolve();
      });

      conn.on("error", (err: Error & { code?: string; level?: string }) => {
        clearTimeout(timer);
        if (!this.connected) {
          const code = err.code || err.level || "ESSH";
          let msg: string;
          if (code === "ENOTFOUND") {
            msg = "Host not found — check the server IP address";
          } else if (code === "ECONNREFUSED") {
            msg = "Connection refused — check the SSH port";
          } else if (code === "ETIMEDOUT") {
            msg = "Connection timed out";
          } else if (err.level === "client-authentication" || code === "ECONNABORTED") {
            msg = "Authentication failed — check the username and password/key";
          } else {
            msg = `SSH connection error: ${err.message}`;
          }
          reject(new SshError(msg, code));
        } else {
          this.emit("error", err);
        }
      });

      conn.on("close", () => {
        this.connected = false;
        this.emit("close");
      });

      conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        const answers = prompts.map(() => opts.password ?? "");
        finish(answers);
      });

      try {
        conn.connect(cfg);
      } catch (e: unknown) {
        clearTimeout(timer);
        reject(
          new SshError(
            `SSH initialization error: ${e instanceof Error ? e.message : String(e)}`,
            "EINIT"
          )
        );
      }
    });
  }

  /** Execute a command and return the full stdout/stderr. */
  async exec(command: string, opts: SshExecOptions = {}): Promise<ExecResult> {
    if (!this.conn || !this.connected) {
      throw new SshError(
        "SSH connection is not established",
        "NOT_CONNECTED"
      );
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const conn = this.conn!;
      const env = opts.env || {};
      const envPrefix = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");

      const fullCommand = envPrefix ? `${envPrefix} ${command}` : command;

      const timer = setTimeout(() => {
        try { stream.close(); } catch { /* ignore */ }
        reject(
          new SshError(
            `Command timed out: ${command.slice(0, 80)}`,
            "ECMDTIMEOUT"
          )
        );
      }, opts.timeout ?? 5 * 60 * 1000);

      let stream: any;
      // Check for restore-cancel.flag every second to abort immediately on cancel
      const cancelCheck = setInterval(() => {
        try {
          const flagPath = `${process.cwd()}/data/restore-cancel.flag`;
          if (fs.existsSync(flagPath)) {
            clearInterval(cancelCheck);
            clearTimeout(timer);
            try { stream?.close(); } catch {}
            reject(new Error("RESTORE_CANCELLED"));
          }
        } catch {}
      }, 1000);

      conn.exec(fullCommand, { pty: false }, (err, s) => {
        if (err) {
          clearTimeout(timer);
          clearInterval(cancelCheck);
          reject(
            new SshError(
              `Command execution failed: ${err.message}`,
              "EEXEC"
            )
          );
          return;
        }
        stream = s;
        let stdout = "";
        let stderr = "";

        s.on("close", (code: number | null, signal: string) => {
          clearTimeout(timer);
          clearInterval(cancelCheck);
          resolve({ stdout, stderr, exitCode: code, signal: signal || undefined });
        });

        s.stdout.on("data", (chunk: any) => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          stdout += text;
          opts.onStdout?.(text);
        });

        s.stderr.on("data", (chunk: any) => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          stderr += text;
          opts.onStderr?.(text);
        });

        s.on("error", (e: Error) => {
          clearTimeout(timer);
          clearInterval(cancelCheck);
          reject(
            new SshError(
              `Stream error: ${e.message}`,
              "ESTREAM"
            )
          );
        });
      });
    });
  }

  /** Upload a local file to the remote server via SFTP. */
  async uploadFile(localPath: string, remotePath: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    if (!this.conn || !this.connected) {
      throw new SshError(
        "SSH connection is not established",
        "NOT_CONNECTED"
      );
    }

    if (!fs.existsSync(localPath)) {
      throw new SshError(
        `Local file does not exist: ${localPath}`,
        "ENOENT"
      );
    }

    const totalSize = fs.statSync(localPath).size;

    return new Promise<void>((resolve, reject) => {
      const conn = this.conn!;
      conn.sftp((err, sftp) => {
        if (err) {
          reject(
            new SshError(
              `SFTP initialization failed: ${err.message}`,
              "ESFTP"
            )
          );
          return;
        }

        const rs = fs.createReadStream(localPath);
        const ws = sftp.createWriteStream(remotePath, {
          mode: 0o644,
          flags: "w",
        });

        let sent = 0;
        const cancelCheck = setInterval(() => {
          try {
            const flagPath = `${process.cwd()}/data/restore-cancel.flag`;
            if (fs.existsSync(flagPath)) {
              clearInterval(cancelCheck);
              try { rs.destroy(); } catch {}
              try { ws.destroy(); } catch {}
              try { sftp.end(); } catch {}
              reject(new Error("RESTORE_CANCELLED"));
            }
          } catch {}
        }, 1000);

        rs.on("data", (chunk: any) => {
          sent += chunk.length;
          onProgress?.(sent, totalSize);
        });

        ws.on("close", () => {
          clearInterval(cancelCheck);
          try { sftp.end(); } catch { /* ignore */ }
          resolve();
        });

        ws.on("error", (e: Error) => {
          clearInterval(cancelCheck);
          try { rs.destroy(); sftp.end(); } catch { /* ignore */ }
          reject(
            new SshError(
              `File upload failed: ${e.message}`,
              "EUPLOAD"
            )
          );
        });

        rs.on("error", (e: Error) => {
          clearInterval(cancelCheck);
          try { ws.destroy(); sftp.end(); } catch { /* ignore */ }
          reject(
            new SshError(
              `Reading local file failed: ${e.message}`,
              "EREAD"
            )
          );
        });

        rs.pipe(ws);
      });
    });
  }

  /** Write content directly to a remote file via SFTP. */
  async writeRemoteFile(remotePath: string, content: string | Buffer, mode: number = 0o644): Promise<void> {
    if (!this.conn || !this.connected) {
      throw new SshError(
        "SSH connection is not established",
        "NOT_CONNECTED"
      );
    }

    return new Promise<void>((resolve, reject) => {
      const conn = this.conn!;
      conn.sftp((err, sftp) => {
        if (err) {
          reject(
            new SshError(
              `SFTP initialization failed: ${err.message}`,
              "ESFTP"
            )
          );
          return;
        }

        const ws = sftp.createWriteStream(remotePath, { mode, flags: "w" });

        ws.on("close", () => {
          try { sftp.end(); } catch { /* ignore */ }
          resolve();
        });

        ws.on("error", (e: Error) => {
          try { sftp.end(); } catch { /* ignore */ }
          reject(
            new SshError(
              `Writing remote file failed: ${e.message}`,
              "EWRITE"
            )
          );
        });

        ws.end(content);
      });
    });
  }

  /** Close the SSH connection. */
  disconnect(): void {
    if (this.conn) {
      try {
        this.conn.end();
      } catch { /* ignore */ }
      this.conn = null;
      this.connected = false;
    }
  }
}
