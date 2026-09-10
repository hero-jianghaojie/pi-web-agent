// lib/sessions.js
//
// Best-effort session listing by reading pi's session JSONL files directly.
// This avoids importing the whole SDK just to show a sidebar list.
//
// Session location: <agentDir>/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl
//   where encoded-cwd = cwd with a leading slash stripped and `/`, `\`, `:`
//   replaced by `-` (mirrors pi's getDefaultSessionDirPath()).

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

export function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getSessionsRoot() {
  return join(getAgentDir(), "sessions");
}

function resolvePath(p) {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

/** Encode a cwd the same way pi does. */
export function encodeSessionDirName(cwd) {
  const resolved = resolvePath(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return safe;
}

export function getSessionDirForCwd(cwd, sessionDir) {
  if (sessionDir) return resolvePath(sessionDir);
  return join(getSessionsRoot(), encodeSessionDirName(cwd));
}

/** Parse the first line of a session file (the header). */
function readHeader(filePath) {
  try {
    const fd = readFileSync(filePath, "utf8");
    const newline = fd.indexOf("\n");
    const firstLine = (newline === -1 ? fd : fd.slice(0, newline)).trim();
    if (!firstLine) return null;
    const entry = JSON.parse(firstLine);
    if (entry.type !== "session" || typeof entry.id !== "string") return null;
    return entry;
  } catch {
    return null;
  }
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

/**
 * Summarize a session file into a sidebar-friendly object.
 * @param {string} filePath
 */
function describeSession(filePath) {
  try {
    const stat = statSync(filePath);
    const header = readHeader(filePath);
    if (!header) return null;

    let name;
    let firstUserMessage = "";
    let messageCount = 0;
    let lastActivity = 0;

    const content = readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name.trim() || undefined;
        continue;
      }
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "user" || msg.role === "assistant") messageCount++;
      if (msg.role === "user" && !firstUserMessage) {
        firstUserMessage = textOfContent(msg.content);
      }
      if (typeof msg.timestamp === "number" && msg.timestamp > lastActivity) {
        lastActivity = msg.timestamp;
      }
    }

    const headerTime =
      typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
    const modified = lastActivity > 0 ? lastActivity : Number.isNaN(headerTime) ? stat.mtimeMs : headerTime;

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name: name || undefined,
      created: Number.isNaN(headerTime) ? null : new Date(headerTime).toISOString(),
      modified: new Date(modified).toISOString(),
      messageCount,
      title: name || firstUserMessage || "(empty session)",
    };
  } catch {
    return null;
  }
}

/**
 * List sessions for a cwd (or a whole session dir / all sessions).
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} [opts.sessionDir]
 * @param {boolean} [opts.all=false]  list across every project dir
 */
export function listSessions({ cwd = process.cwd(), sessionDir, all = false } = {}) {
  const sessions = [];
  const pushDir = (dir) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const info = describeSession(join(dir, f));
      if (info) sessions.push(info);
    }
  };

  if (all) {
    const root = getSessionsRoot();
    if (existsSync(root)) {
      let dirs;
      try {
        dirs = readdirSync(root);
      } catch {
        dirs = [];
      }
      for (const d of dirs) {
        const p = join(root, d);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) pushDir(p);
      }
    }
  } else {
    pushDir(getSessionDirForCwd(cwd, sessionDir));
  }

  sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return sessions;
}

export { resolvePath, dirname };
