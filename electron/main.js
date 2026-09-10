// electron/main.js — minimal desktop wrapper (ESM, Electron 28+)
//
// It spawns `node server.js` on a random localhost port and loads the web UI
// in a native window, giving a desktop "app" feel without bundling pi.
//
// Run with:  npm run desktop   (or: npx electron electron/main.js)

import { app, BrowserWindow, shell } from "electron";
import { spawn } from "child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PI_WEB_AGENT_PORT) || 8000 + Math.floor(Math.random() * 5000);

let serverProc = null;
let win = null;

function forwardArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    out.push(a);
    if (!a.includes("=") && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      out.push(argv[++i]);
    }
  }
  return out;
}

function startServer() {
  serverProc = spawn(
    process.execPath,
    [path.join(ROOT, "server.js"), "--host", HOST, "--port", String(PORT), ...forwardArgs(process.argv.slice(2))],
    { cwd: ROOT, stdio: "inherit" },
  );
  serverProc.on("exit", () => app.quit());
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) return reject(new Error("server did not start"));
          setTimeout(attempt, 250);
        });
    };
    attempt();
  });
}

app.whenReady().then(async () => {
  startServer();
  const url = `http://${HOST}:${PORT}`;
  await waitForServer(url);

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Pi Web Agent",
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("window-all-closed", () => {
  if (serverProc) serverProc.kill();
  app.quit();
});
