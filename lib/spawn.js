// lib/spawn.js
//
// Cross-platform spawning helpers for launching the `pi` CLI.
//
// On Windows, the npm global `pi` binary is a `.cmd` shim which Node's spawn()
// cannot execute directly (ENOENT). We therefore run it through `cmd.exe /d /s /c`
// with each argument quoted, and provide a tree-kill so restarting the agent
// does not leave orphaned `node` processes behind.
//
// On POSIX, the `pi` shim is an executable shell script, so plain spawn() works.

import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";

/** Quote a single argument for the Windows cmd.exe command line. */
function quoteWinArg(a) {
  const s = String(a);
  if (s === "") return '""';
  if (/[\s"&|<>^()%!]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

/**
 * Spawn `command args...` returning a child process, working around the Windows
 * `.cmd` shim limitation.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} opts
 */
export function spawnCommand(command, args, opts) {
  if (IS_WIN) {
    const cmdLine = [command, ...args].map(quoteWinArg).join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", cmdLine], opts);
  }
  return spawn(command, args, opts);
}

/**
 * Kill a spawned process and (on Windows) its whole descendant tree.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killTree(child) {
  if (!child || child.killed) return;
  if (IS_WIN && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}
