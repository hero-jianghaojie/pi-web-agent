// lib/rpc-client.js
//
// A thin, dependency-free client for the `pi --mode rpc` JSONL protocol.
// It spawns the pi process, correlates request/response by id, and broadcasts
// every event to listeners (the HTTP server forwards them to browsers via SSE).
//
// Framing notes (from docs/rpc.md):
//   - Records are LF-delimited JSONL. Split on "\n" ONLY (do not use Node's
//     readline, which also splits on U+2028/U+2029 inside JSON strings).
//   - Strip a single trailing "\r" to accept CRLF input.

import { randomUUID } from "node:crypto";
import { spawnCommand, killTree } from "./spawn.js";

export class PiRpcClient {
  /**
   * @param {object} opts
   * @param {string} [opts.piPath="pi"]   Path/name of the pi binary.
   * @param {string[]} [opts.args=[]]     Extra args passed after `--mode rpc`.
   * @param {string} [opts.cwd]           Working directory for the agent.
   * @param {object} [opts.env={}]        Extra environment variables.
   * @param {(chunk: string) => void} [opts.onStderr]
   */
  constructor({ piPath = "pi", args = [], cwd = process.cwd(), env = {}, onStderr } = {}) {
    this.piPath = piPath;
    this.args = args;
    this.cwd = cwd;
    this.onStderr = onStderr;

    this.proc = spawnCommand(piPath, ["--mode", "rpc", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AI_AGENT: "pi", ...env },
      windowsHide: true,
    });

    /** @type {Map<string, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
    this._buffer = "";
    this.closed = false;

    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (this.onStderr) this.onStderr(text);
      else process.stderr.write(text);
    });
    this.proc.on("error", (err) => this._onExit(err));
    this.proc.on("exit", (code, signal) => this._onExit(code, signal));
  }

  _onData(chunk) {
    this._buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this._buffer.indexOf("\n")) !== -1) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // skip malformed records
    }

    if (obj && obj.type === "response") {
      // Correlate by id. Parse errors / responses without an id are broadcast.
      const pending = obj.id != null ? this.pending.get(obj.id) : undefined;
      if (pending) {
        this.pending.delete(obj.id);
        if (obj.success === false) {
          pending.reject(new Error(obj.error || `Command failed: ${obj.command}`));
        } else {
          pending.resolve(obj);
        }
      }
      this._emit(obj);
    } else {
      this._emit(obj);
    }
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not kill the agent bridge */
      }
    }
  }

  _onExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(
      `pi process exited (code=${code ?? "n/a"}, signal=${signal ?? "n/a"})`,
    );
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
    this._emit({ type: "agent_process_exit", code, signal });
  }

  /**
   * Send a command and await its response object.
   * @param {object} command  e.g. { type: "prompt", message: "hi" }
   * @returns {Promise<object>}
   */
  send(command) {
    if (this.closed) {
      return Promise.reject(new Error("pi process is not running"));
    }
    const id = command.id ?? randomUUID();
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a command without waiting for its response (fire-and-forget).
   * @param {object} command
   * @returns {string} the id used for the command
   */
  sendNoWait(command) {
    const id = command.id ?? randomUUID();
    this.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    return id;
  }

  /** Subscribe to all non-response events (and responses, if desired). */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isClosed() {
    return this.closed;
  }

  kill() {
    this.closed = true;
    killTree(this.proc);
  }
}
