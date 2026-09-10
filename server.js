// server.js — Pi Web Agent
//
// A zero-dependency HTTP server that bridges a browser UI to a `pi --mode rpc`
// subprocess. Events stream to the browser over Server-Sent Events (SSE);
// commands go back over small JSON POST endpoints.
//
// Run:  node server.js [--cwd /path --model sonnet ...]
// Open: http://127.0.0.1:8420

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PiRpcClient } from "./lib/rpc-client.js";
import { listSessions } from "./lib/sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    port: 8420,
    host: "127.0.0.1",
    cwd: process.cwd(),
    pi: "pi",
    piArgs: [],
    sessionDir: undefined,
    open: false,
    onStderr: undefined,
  };

  const repeatable = new Set(["extension", "skill", "prompt-template", "theme", "models"]);
  const passthrough = new Map([
    ["provider", "--provider"],
    ["model", "--model"],
    ["api-key", "--api-key"],
    ["thinking", "--thinking"],
    ["name", "--name"],
    ["tools", "--tools"],
    ["exclude-tools", "--exclude-tools"],
  ]);

  let i = 0;
  const next = () => argv[++i];

  for (; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        args.port = Number(next());
        break;
      case "--host":
        args.host = next();
        break;
      case "--cwd":
        args.cwd = path.resolve(next());
        break;
      case "--pi":
        args.pi = next();
        break;
      case "--session-dir":
        args.sessionDir = path.resolve(next());
        args.piArgs.push("--session-dir", args.sessionDir);
        break;
      case "--no-session":
        args.piArgs.push("--no-session");
        break;
      case "--open":
        args.open = true;
        break;
      case "--no-builtin-tools":
        args.piArgs.push("--no-builtin-tools");
        break;
      case "--no-tools":
        args.piArgs.push("--no-tools");
        break;
      case "--no-extensions":
        args.piArgs.push("--no-extensions");
        break;
      case "--no-skills":
        args.piArgs.push("--no-skills");
        break;
      case "--no-prompt-templates":
        args.piArgs.push("--no-prompt-templates");
        break;
      case "--no-themes":
        args.piArgs.push("--no-themes");
        break;
      case "--no-context-files":
        args.piArgs.push("--no-context-files");
        break;
      case "--approve":
        args.piArgs.push("--approve");
        break;
      case "--no-approve":
        args.piArgs.push("--no-approve");
        break;
      case "-e":
      case "--extension":
        args.piArgs.push("--extension", next());
        break;
      case "--skill":
        args.piArgs.push("--skill", next());
        break;
      case "--prompt-template":
        args.piArgs.push("--prompt-template", next());
        break;
      case "--theme":
        args.piArgs.push("--theme", next());
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default: {
        if (arg.startsWith("--")) {
          const name = arg.slice(2);
          const key = name.split("=")[0];
          if (passthrough.has(key)) {
            if (name.includes("=")) {
              args.piArgs.push(passthrough.get(key), name.split("=").slice(1).join("="));
            } else {
              args.piArgs.push(passthrough.get(key), next());
            }
            break;
          }
          if (repeatable.has(key)) {
            args.piArgs.push(`--${key}`, next());
            break;
          }
          console.warn(`[pi-web-agent] unknown option ignored: ${arg}`);
        }
      }
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Pi Web Agent — run pi as a Codex-style web app.

Usage: node server.js [options]

  --port <n>              Port to listen on (default 8420)
  --host <addr>           Bind address (default 127.0.0.1)
  --cwd <dir>             Working directory for the agent
  --pi <path>             Path to the pi binary (default "pi")
  --session-dir <dir>     Custom session storage directory
  --no-session            Ephemeral mode (don't persist sessions)
  --open                  Open the browser once the server is listening

Model / auth:
  --provider <name>       Provider (anthropic, openai, google, ...)
  --model <pattern>       Model pattern/ID (supports provider/id and :<thinking>)
  --api-key <key>         API key (overrides env vars)
  --thinking <level>      off|minimal|low|medium|high|xhigh|max
  --models <patterns>     Comma-separated models for cycling

Resources:
  -e, --extension <src>   Load extension (repeatable)
  --skill <path>          Load skill (repeatable)
  --prompt-template <p>   Load prompt template (repeatable)
  --theme <path>          Load theme (repeatable)
  --no-extensions         Disable extension discovery
  --no-skills             Disable skill discovery
  --no-context-files      Disable AGENTS.md/CLAUDE.md discovery

Tools:
  --tools <list>          Allowlist tools
  --exclude-tools <list>  Disable specific tools
  --no-builtin-tools      Disable built-in tools only
  --no-tools              Disable all tools

Environment: PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR, ANTHROPIC_API_KEY, ...
`);
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

const CLI = parseArgs(process.argv.slice(2));
if (CLI.sessionDir) process.env.PI_CODING_AGENT_SESSION_DIR = CLI.sessionDir;

/** @type {PiRpcClient | null} */
let rpc = null;

function startAgent() {
  if (rpc) {
    rpc.kill();
    rpc = null;
  }
  const client = new PiRpcClient({
    piPath: CLI.pi,
    args: CLI.piArgs,
    cwd: CLI.cwd,
    onStderr: (text) => console.error("[pi stderr]", text.trimEnd()),
  });
  client.onEvent((event) => broadcast(event));
  rpc = client;
  return client;
}

// ---------------------------------------------------------------------------
// SSE client management
// ---------------------------------------------------------------------------

/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      /* drop broken clients */
    }
  }
}

// Heartbeat keeps proxies/connections from going idle.
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }
}, 25000).unref();

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(readFileSync(filePath));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

// ---------------------------------------------------------------------------
// HTTP request routing
// ---------------------------------------------------------------------------

// Flags whose value must never be sent to the browser or any HTTP client.
const SECRET_FLAGS = new Set(["--api-key"]);

/** Copy of argv with secret flag values replaced by "***". */
function redactArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SECRET_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push("***");
        i++;
      }
      continue;
    }
    let redacted = a;
    for (const f of SECRET_FLAGS) {
      if (a.startsWith(`${f}=`)) {
        redacted = `${f}=***`;
        break;
      }
    }
    out.push(redacted);
  }
  return out;
}

async function handleApi(req, res, pathname) {
  // ---- config & state ----
  if (pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, {
      cwd: CLI.cwd,
      piPath: CLI.pi,
      piArgs: redactArgs(CLI.piArgs),
      port: CLI.port,
      version: "1.0.0",
    });
    return;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_state" });
      sendJson(res, 200, r.data ?? {});
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  if (pathname === "/api/messages" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_messages" });
      sendJson(res, 200, r.data ?? { messages: [] });
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  if (pathname === "/api/session-stats" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_session_stats" });
      sendJson(res, 200, r.data ?? {});
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  if (pathname === "/api/models" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_available_models" });
      sendJson(res, 200, r.data ?? { models: [] });
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  if (pathname === "/api/thinking-levels" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_available_thinking_levels" });
      sendJson(res, 200, r.data ?? { levels: [] });
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  if (pathname === "/api/commands" && req.method === "GET") {
    try {
      const r = await rpc.send({ type: "get_commands" });
      sendJson(res, 200, r.data ?? { commands: [] });
    } catch (e) {
      sendJson(res, 503, { error: e.message });
    }
    return;
  }

  // ---- sessions (from disk) ----
  if (pathname === "/api/sessions" && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://x");
      const all = url.searchParams.get("all") === "1";
      const sessions = listSessions({
        cwd: CLI.cwd,
        sessionDir: CLI.sessionDir,
        all,
      });
      sendJson(res, 200, { sessions });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ---- generic RPC passthrough ----
  if (pathname === "/api/rpc" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body.type !== "string") {
        sendJson(res, 400, { error: "Missing command type" });
        return;
      }
      const result = await rpc.send(body);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ---- extension UI responses (dialogs) ----
  if (pathname === "/api/ui-response" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== "string") {
        sendJson(res, 400, { error: "Missing dialog id" });
        return;
      }
      rpc.sendNoWait({ type: "extension_ui_response", ...body });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // ---- restart the agent subprocess ----
  if (pathname === "/api/restart" && req.method === "POST") {
    startAgent();
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- shut down the whole server (like 停止.bat) ----
  if (pathname === "/api/shutdown" && req.method === "POST") {
    sendJson(res, 200, { ok: true });
    res.on("finish", () => {
      console.log("Shutdown requested from the web UI.");
      setTimeout(() => shutdown(), 50);
    });
    return;
  }

  // ---- export session to HTML ----
  if (pathname === "/api/export" && req.method === "POST") {
    try {
      const r = await rpc.send({ type: "export_html" });
      sendJson(res, 200, r.data ?? {});
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;

  if (pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

startAgent();

const browserHost = CLI.host === "0.0.0.0" ? "127.0.0.1" : CLI.host;
const browserUrl = `http://${browserHost}:${CLI.port}`;

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* best-effort only */
  }
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${CLI.port} is already in use — an instance is already running.`);
    if (CLI.open) {
      console.log(`Opening ${browserUrl} ...`);
      openBrowser(browserUrl);
    }
    process.exit(0);
  }
  throw err;
});

server.listen(CLI.port, CLI.host, () => {
  console.log("");
  console.log("  Pi Web Agent");
  console.log(`  → ${browserUrl}`);
  console.log(`  cwd: ${CLI.cwd}`);
  if (CLI.piArgs.length) console.log(`  pi args: ${redactArgs(CLI.piArgs).join(" ")}`);
  console.log("");
  if (CLI.open) openBrowser(browserUrl);
});

function shutdown() {
  if (rpc) rpc.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
