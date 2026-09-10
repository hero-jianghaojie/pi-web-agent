// public/app.js — Pi Web Agent frontend
//
// A single-page Codex-style chat UI. It talks to the local server over SSE
// (server → client events) and small JSON POST endpoints (client → server).

"use strict";

/* ============================== state ================================== */

const state = {
  config: null,
  view: [],            // messages currently displayed
  streaming: false,
  inTurn: false,
  model: null,         // current model object (from get_state)
  thinkingLevel: "off",
  models: [],          // available models
  thinkingLevels: [],
  sessions: [],
  commands: [],
  stats: null,         // get_session_stats
  usage: null,         // live usage from message_update
  sessionInfo: null,   // get_state payload
  attachments: [],     // pending images
  detailsOpen: new Map(), // key -> boolean (user overrides for <details>)
};

/* ============================== dom refs =============================== */

const $ = (sel) => document.querySelector(sel);

const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#btn-send");
const abortBtn = $("#btn-abort");
const sessionListEl = $("#session-list");
const modelSelect = $("#model-select");
const thinkingSelect = $("#thinking-select");
const sessionTitleEl = $("#session-title");
const cwdLabel = $("#cwd-label");
const connLabel = $("#conn-label");
const connBanner = $("#conn-banner");
const statStreaming = $("#stat-streaming");
const statModel = $("#stat-model");
const statThinking = $("#stat-thinking");
const statUsage = $("#stat-usage");
const statContext = $("#stat-context");
const attachmentsEl = $("#attachments");
const toastRoot = $("#toast-root");
const dialogRoot = $("#dialog-root");

/* ============================== utils ================================== */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && b.type === "image").length;
}

async function api(path, opts = {}) {
  const init = {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.headers || {},
  };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function toast(text, ms = 4000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ============================ markdown ================================= */

function mdToHtml(text) {
  if (!text) return "";
  const stash = [];
  const stashAdd = (html) => {
    stash.push(html);
    return `\u0001${stash.length - 1}\u0002`;
  };

  // Extract fenced code blocks first.
  let src = String(text).replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    return stashAdd(renderCode(code, lang.trim()));
  });

  const inline = (s) => {
    s = s.replace(/`([^`\n]+)`/g, (m, c) => stashAdd('<code class="inline">' + escapeHtml(c) + "</code>"));
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s;
  };

  const lines = src.split("\n");
  let html = "";
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html += "<p>" + inline(para.join(" ")) + "</p>";
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      html += "</" + list + ">";
      list = null;
    }
  };
  const isStash = (l) => /^\u0001\d+\u0002$/.test(l.trim());

  for (const raw of lines) {
    const t = raw.trim();
    if (isStash(t)) {
      flushPara();
      closeList();
      html += t;
      continue;
    }
    if (t === "") {
      flushPara();
      closeList();
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      html += "<hr/>";
      continue;
    }
    if (t.startsWith(">")) {
      flushPara();
      closeList();
      html += "<blockquote>" + inline(t.replace(/^>\s?/, "")) + "</blockquote>";
      continue;
    }
    const ul = t.match(/^[-*+]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        list = want;
        html += "<" + want + ">";
      }
      html += "<li>" + inline((ul || ol)[1]) + "</li>";
      continue;
    }
    para.push(t);
  }
  flushPara();
  closeList();

  return html.replace(/\u0001(\d+)\u0002/g, (m, i) => stash[Number(i)] ?? "");
}

function renderCode(code, lang) {
  const clean = code.replace(/\n$/, "");
  return (
    '<pre>' +
    '<button class="copy-btn" type="button">Copy</button>' +
    "<code>" +
    escapeHtml(clean) +
    "</code></pre>"
  );
}

/* ============================ rendering ================================ */

function collectToolResults(messages) {
  const map = new Map();
  for (const m of messages) {
    if (m && m.role === "toolResult" && m.toolCallId) {
      map.set(m.toolCallId, m);
    }
  }
  return map;
}

function renderUser(m) {
  const text = contentToText(m.content);
  const imgs = countImages(m.content);
  const imgNote = imgs > 0 ? `<div style="font-size:11px;opacity:.75;margin-top:4px">📎 ${imgs} image${imgs > 1 ? "s" : ""}</div>` : "";
  return `<div class="msg user"><div class="bubble">${escapeHtml(text || "(attachment)")}${imgNote}</div></div>`;
}

function renderThinking(b, bi) {
  const t = b.thinking || "";
  return (
    `<details class="thinking" data-block-idx="${bi}" data-short="${t.length < 400 ? 1 : 0}"${t.length < 400 ? " open" : ""}>` +
    "<summary>Thinking</summary>" +
    `<div class="thinking-body">${escapeHtml(t)}</div>` +
    "</details>"
  );
}

function renderToolCall(b, result, bi) {
  let args = "";
  try {
    args = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}, null, 2);
  } catch {
    args = String(b.arguments ?? "");
  }
  const status = b._status || (result ? (result.isError ? "error" : "done") : "running");
  const output = b._output !== undefined ? b._output : result ? contentToText(result.content) : "";
  let out = "";
  if (output) {
    out = `<div class="tc-out">${escapeHtml(output)}</div>`;
  } else if (status === "running") {
    out = `<div class="tc-out" style="color:var(--text-faint)">…</div>`;
  }
  return (
    `<details class="toolcall ${status}" data-tool-id="${escapeHtml(b.id)}" data-block-idx="${bi}"${status === "running" ? " open" : ""}>` +
    `<summary><span class="tc-name">${escapeHtml(b.name)}</span><span class="tc-status">${status}</span></summary>` +
    `<div class="tc-body">${args ? `<div class="tc-args"><code>${escapeHtml(args)}</code></div>` : ""}${out}</div>` +
    "</details>"
  );
}

function renderAssistant(m, toolResults, idx, isLive) {
  const blocks = Array.isArray(m.content) ? m.content : [];
  let body = "";
  let bi = 0;
  for (const b of blocks) {
    if (!b) {
      bi++;
      continue;
    }
    if (b.type === "text") {
      body += `<div class="prose" data-block-idx="${bi}">${mdToHtml(b.text || "")}</div>`;
    } else if (b.type === "thinking") {
      body += renderThinking(b, bi);
    } else if (b.type === "toolCall") {
      body += renderToolCall(b, toolResults.get(b.id), bi);
    } else if (b.type === "image") {
      body += `<img src="data:${escapeHtml(b.mimeType || "image/png")};base64,${escapeHtml(b.data || "")}" alt="image" style="max-width:100%;border-radius:8px;margin:4px 0" />`;
    }
    bi++;
  }
  const model = m.model ? `<span class="meta">${escapeHtml(m.model)}</span>` : "";
  const idAttr = isLive ? ' id="live-assistant"' : "";
  return (
    `<div class="msg assistant" data-msg-idx="${idx}"${idAttr}>` +
    '<div class="wrap"><div class="who"><span class="dot">π</span><span class="name">Pi</span>' +
    model +
    "</div>" +
    body +
    "</div></div>"
  );
}

function renderOther(m) {
  let label = "";
  let text = "";
  if (m.role === "branchSummary") {
    label = "Branch summary";
    text = m.summary || "";
  } else if (m.role === "compactionSummary") {
    label = "Compaction";
    text = m.summary || "";
  } else if (m.role === "custom") {
    label = "Note";
    text = contentToText(m.content);
  } else if (m.role === "bashExecution") {
    label = "Bash";
    text = (m.command || "") + "\n" + (m.output || "");
  } else {
    label = String(m.role || "message");
    text = contentToText(m.content);
  }
  if (!text) return "";
  return (
    `<div class="msg assistant"><div class="wrap">` +
    `<div class="who"><span class="dot">·</span><span class="name" style="color:var(--text-dim)">${escapeHtml(label)}</span></div>` +
    `<div class="prose"><pre style="margin:0"><code>${escapeHtml(text)}</code></pre></div>` +
    "</div></div>"
  );
}

function lastAssistantIndex() {
  for (let i = state.view.length - 1; i >= 0; i--) {
    if (state.view[i].role === "assistant") return i;
  }
  return -1;
}

function renderAll() {
  const stick = isNearBottom();
  const toolResults = collectToolResults(state.view);
  const liveIdx = state.streaming ? lastAssistantIndex() : -1;
  const html = [];

  state.view.forEach((m, i) => {
    if (!m) return;
    if (m.role === "user") html.push(renderUser(m));
    else if (m.role === "assistant") html.push(renderAssistant(m, toolResults, i, i === liveIdx));
    else if (m.role === "toolResult") {
      /* rendered inside tool cards */
    } else html.push(renderOther(m));
  });

  messagesEl.innerHTML = html.join("");
  applyOpenStates();
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function applyOpenStates() {
  for (const details of messagesEl.querySelectorAll("details")) {
    const key = detailsKey(details);
    if (state.detailsOpen.has(key)) {
      details.open = state.detailsOpen.get(key);
    }
  }
}

function detailsKey(details) {
  const toolId = details.getAttribute("data-tool-id");
  if (toolId) return "tool:" + toolId;
  const bi = details.getAttribute("data-block-idx");
  const mi = details.closest(".msg")?.getAttribute("data-msg-idx");
  return "think:" + mi + ":" + bi;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}

function autoscroll() {
  if (isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

/* ----------------------- targeted live updates ------------------------ */

function updateLiveText(idx, text) {
  const el = messagesEl.querySelector(`#live-assistant [data-block-idx="${idx}"]`);
  if (!el) return scheduleRender();
  el.innerHTML = mdToHtml(text);
  autoscroll();
}

function updateLiveThinking(idx, text) {
  const el = messagesEl.querySelector(`#live-assistant [data-block-idx="${idx}"] .thinking-body`);
  if (!el) return scheduleRender();
  el.textContent = text;
  autoscroll();
}

function updateToolOutput(id, output, status) {
  const card = messagesEl.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
  if (!card) return scheduleRender();
  let outEl = card.querySelector(".tc-out");
  if (!outEl && output) {
    card.querySelector(".tc-body")?.insertAdjacentHTML("beforeend", '<div class="tc-out"></div>');
    outEl = card.querySelector(".tc-out");
  }
  if (outEl) outEl.textContent = output || "…";
  const stEl = card.querySelector(".tc-status");
  if (stEl) stEl.textContent = status;
  card.classList.remove("running", "done", "error");
  card.classList.add(status);
  if (status === "running") card.open = true;
  autoscroll();
}

/* ==================== live message assembly (events) =================== */

function getOrCreateLiveAssistant() {
  const last = state.view[state.view.length - 1];
  if (last && last.role === "assistant" && last._live) return last;
  const msg = { role: "assistant", content: [], _live: true };
  state.view.push(msg);
  return msg;
}

function ensureBlock(msg, idx, fallback) {
  while (msg.content.length <= idx) msg.content.push(null);
  if (!msg.content[idx]) msg.content[idx] = { ...fallback };
  return msg.content[idx];
}

function applyDelta(msg, idx, d) {
  switch (d.type) {
    case "text_start":
      ensureBlock(msg, idx, { type: "text", text: "" });
      break;
    case "text_delta":
      ensureBlock(msg, idx, { type: "text", text: "" }).text += d.delta || "";
      break;
    case "text_end":
      msg.content[idx] = { type: "text", text: d.content || "" };
      break;
    case "thinking_start":
      ensureBlock(msg, idx, { type: "thinking", thinking: "" });
      break;
    case "thinking_delta":
      ensureBlock(msg, idx, { type: "thinking", thinking: "" }).thinking += d.delta || "";
      break;
    case "thinking_end":
      msg.content[idx] = { type: "thinking", thinking: d.content || "" };
      break;
    case "toolcall_start":
      ensureBlock(msg, idx, { type: "toolCall", id: d.id, name: d.toolName, arguments: "", _status: "running", _output: "" });
      break;
    case "toolcall_delta":
      ensureBlock(msg, idx, { type: "toolCall", id: "", name: "", arguments: "" }).arguments += d.delta || "";
      break;
    case "toolcall_end": {
      const b = ensureBlock(msg, idx, { type: "toolCall", id: "", name: "", arguments: "" });
      Object.assign(b, d.toolCall || {}, { _status: "running", _output: "" });
      break;
    }
  }
}

function findToolCallBlock(id) {
  for (let i = state.view.length - 1; i >= 0; i--) {
    const m = state.view[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === "toolCall" && b.id === id) return b;
    }
  }
  return null;
}

/* ============================ event handling =========================== */

function handleEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  switch (ev.type) {
    case "hello":
      setConn(true);
      break;

    case "agent_start":
      state.streaming = true;
      updateStreamingBadge();
      break;

    case "agent_settled":
      state.streaming = false;
      state.inTurn = false;
      updateStreamingBadge();
      refreshMessages();
      refreshState();
      refreshStats();
      break;

    case "message_start":
      if (ev.message?.role === "assistant") {
        state.view.push({ role: "assistant", content: [], _live: true });
        scheduleRender();
      }
      break;

    case "message_update": {
      if (ev.usage) {
        state.usage = ev.usage;
        updateStatus();
      }
      const d = ev.assistantMessageEvent;
      if (!d) break;
      const msg = getOrCreateLiveAssistant();
      const idx = d.contentIndex ?? 0;
      applyDelta(msg, idx, d);
      if (d.type === "text_delta") updateLiveText(idx, msg.content[idx]?.text || "");
      else if (d.type === "text_end") updateLiveText(idx, msg.content[idx]?.text || "");
      else if (d.type === "thinking_delta") updateLiveThinking(idx, msg.content[idx]?.thinking || "");
      else if (d.type === "thinking_end") updateLiveThinking(idx, msg.content[idx]?.thinking || "");
      else scheduleRender();
      break;
    }

    case "message_end": {
      const m = ev.message;
      if (m?.role === "assistant") {
        const idx = lastAssistantIndex();
        if (idx >= 0) state.view[idx] = { ...m, _live: false };
        else state.view.push(m);
        scheduleRender();
      }
      break;
    }

    case "tool_execution_start": {
      const b = findToolCallBlock(ev.toolCallId);
      if (b) {
        b._status = "running";
        b._output = "";
        if (!b.name) b.name = ev.toolName;
      }
      scheduleRender();
      break;
    }

    case "tool_execution_update": {
      const b = findToolCallBlock(ev.toolCallId);
      if (b) b._output = contentToText(ev.partialResult?.content);
      updateToolOutput(ev.toolCallId, b?._output ?? "", "running");
      break;
    }

    case "tool_execution_end": {
      const b = findToolCallBlock(ev.toolCallId);
      const status = ev.isError ? "error" : "done";
      if (b) {
        b._status = status;
        b._output = contentToText(ev.result?.content);
      }
      updateToolOutput(ev.toolCallId, b?._output ?? "", status);
      break;
    }

    case "turn_start":
      state.inTurn = true;
      updateStreamingBadge();
      break;

    case "turn_end":
      state.inTurn = false;
      updateStreamingBadge();
      break;

    case "extension_ui_request":
      onUiRequest(ev);
      break;

    case "agent_process_exit":
      setConn(false);
      toast("pi process exited. Click “Restart agent” to reconnect.");
      break;

    case "queue_update":
      break;

    default:
      break;
  }
}

/* ============================ data refresh ============================= */

async function refreshMessages() {
  try {
    const data = await api("/api/messages");
    state.view = Array.isArray(data.messages) ? data.messages : [];
    renderAll();
  } catch (e) {
    /* ignore transient errors */
  }
}

async function refreshState() {
  try {
    state.sessionInfo = await api("/api/state");
    state.model = state.sessionInfo.model || null;
    state.thinkingLevel = state.sessionInfo.thinkingLevel || "off";
    updateHeader();
    updateStatus();
    syncSelectors();
  } catch (e) {
    /* ignore */
  }
}

async function refreshStats() {
  try {
    state.stats = await api("/api/session-stats");
    updateStatus();
  } catch (e) {
    /* ignore */
  }
}

async function refreshModels() {
  try {
    const data = await api("/api/models");
    state.models = data.models || [];
    renderModelSelect();
  } catch (e) {
    /* ignore */
  }
}

async function refreshThinkingLevels() {
  try {
    const data = await api("/api/thinking-levels");
    state.thinkingLevels = data.levels || [];
    renderThinkingSelect();
  } catch (e) {
    /* ignore */
  }
}

async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
    renderSessions();
  } catch (e) {
    /* ignore */
  }
}

async function refreshCommands() {
  try {
    const data = await api("/api/commands");
    state.commands = data.commands || [];
  } catch (e) {
    /* ignore */
  }
}

/* ============================ status/header ============================ */

function setConn(online) {
  connLabel.textContent = online ? "● connected" : "○ disconnected";
  connLabel.className = "conn " + (online ? "online" : "offline");
  connBanner.hidden = online;
}

function updateStreamingBadge() {
  abortBtn.hidden = !state.streaming;
  sendBtn.textContent = state.streaming ? "Queue" : "Send";
  if (state.streaming) {
    statStreaming.textContent = state.inTurn ? "● working…" : "● finishing…";
  } else {
    statStreaming.textContent = "";
  }
}

function modelLabel(m) {
  if (!m) return "";
  return m.name || m.id || "";
}

function updateHeader() {
  const info = state.sessionInfo || {};
  const name = info.sessionName || info.sessionId || "Session";
  sessionTitleEl.textContent = name;
  cwdLabel.textContent = state.config?.cwd || info.sessionFile || "";
}

function updateStatus() {
  const info = state.sessionInfo || {};
  const m = state.model || info.model;
  statModel.textContent = m ? modelLabel(m) : "—";
  statThinking.textContent = (state.thinkingLevel || info.thinkingLevel || "off").toLowerCase();

  const usage = state.usage || state.stats?.tokens;
  if (usage) {
    const up = usage.input ?? 0;
    const down = usage.output ?? 0;
    statUsage.textContent = `↑${up} ↓${down}`;
    if (state.stats?.cost != null) {
      statUsage.textContent += ` · $${Number(state.stats.cost).toFixed(4)}`;
    }
  } else {
    statUsage.textContent = "";
  }

  const ctx = state.stats?.contextUsage;
  if (ctx && typeof ctx.percent === "number") {
    statContext.textContent = `ctx ${ctx.percent}%`;
    statContext.style.color = ctx.percent > 90 ? "var(--red)" : ctx.percent > 70 ? "var(--yellow)" : "";
  } else {
    statContext.textContent = "";
  }
}

/* ============================ selectors ================================ */

function renderModelSelect() {
  const current = state.model;
  const isCurrent = (m) => current && current.provider === m.provider && current.id === m.id;
  const opts = state.models.map((m, i) => {
    const label = `${m.provider}/${m.id}`;
    return `<option value="${i}"${isCurrent(m) ? " selected" : ""}>${escapeHtml(label)}</option>`;
  });
  modelSelect.innerHTML = opts.length ? opts.join("") : '<option value="">(no models)</option>';
}

function renderThinkingSelect() {
  const levels = state.thinkingLevels.length ? state.thinkingLevels : ["off", "minimal", "low", "medium", "high"];
  const current = state.thinkingLevel || "off";
  thinkingSelect.innerHTML = levels
    .map((l) => `<option value="${escapeHtml(l)}"${l === current ? " selected" : ""}>${escapeHtml(l)}</option>`)
    .join("");
}

function syncSelectors() {
  renderModelSelect();
  renderThinkingSelect();
}

/* ============================ sessions list ============================ */

function renderSessions() {
  const currentPath = state.sessionInfo?.sessionFile;
  if (!state.sessions.length) {
    sessionListEl.innerHTML = '<div style="padding:10px;color:var(--text-faint);font-size:12px">No sessions yet</div>';
    return;
  }
  sessionListEl.innerHTML = state.sessions
    .map((s) => {
      const active = currentPath && s.path === currentPath ? " active" : "";
      const when = new Date(s.modified).toLocaleString();
      return (
        `<div class="session-item${active}" data-path="${escapeHtml(s.path)}" title="${escapeHtml(s.path)}">` +
        `<div class="t">${escapeHtml(s.title)}</div>` +
        `<div class="m">${escapeHtml(when)} · ${s.messageCount} msgs</div>` +
        "</div>"
      );
    })
    .join("");
}

/* ============================ composer ================================= */

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
}

function pushLocalUserMessage(text, images) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  state.view.push({ role: "user", content: content.length === 1 && text ? text : content });
  scheduleRender();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearAttachments() {
  state.attachments = [];
  attachmentsEl.innerHTML = "";
}

function renderAttachments() {
  attachmentsEl.innerHTML = state.attachments
    .map(
      (a, i) =>
        `<div class="att"><img src="${escapeHtml(a.preview)}" alt="attachment" /><button class="rm" data-i="${i}" type="button">✕</button></div>`,
    )
    .join("");
}

async function sendPrompt() {
  const text = inputEl.value.trim();
  const images = state.attachments.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
  if (!text && images.length === 0) return;

  inputEl.value = "";
  autoResize();
  clearAttachments();
  pushLocalUserMessage(text, images);

  const cmd = { type: "prompt", message: text };
  if (images.length) cmd.images = images;
  if (state.streaming) cmd.streamingBehavior = "followUp";

  try {
    await api("/api/rpc", { method: "POST", body: cmd });
    if (state.streaming) toast("Queued (delivered when the agent finishes).");
  } catch (e) {
    toast("Error: " + e.message);
  }
}

async function abort() {
  try {
    await api("/api/rpc", { method: "POST", body: { type: "abort" } });
  } catch (e) {
    toast("Error: " + e.message);
  }
}

/* ============================ extension UI ============================= */

function onUiRequest(ev) {
  switch (ev.method) {
    case "notify":
      toast(ev.message || "", 5000);
      break;
    case "select":
      showSelectDialog(ev).then((value) => respondUi(ev.id, { value }));
      break;
    case "confirm":
      showConfirmDialog(ev).then((confirmed) => respondUi(ev.id, { confirmed }));
      break;
    case "input":
      showInputDialog(ev).then((value) => respondUi(ev.id, { value }));
      break;
    case "editor":
      showEditorDialog(ev).then((value) => respondUi(ev.id, { value }));
      break;
    default:
      // setStatus/setWidget/setTitle/set_editor_text are fire-and-forget.
      break;
  }
}

async function respondUi(id, payload) {
  try {
    await api("/api/ui-response", { method: "POST", body: { id, ...payload } });
  } catch (e) {
    toast("Error responding to prompt: " + e.message);
  }
}

function showSelectDialog(ev) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const options = (ev.options || []).map(
      (o) => `<button type="button" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`,
    );
    overlay.innerHTML =
      `<div class="dialog"><h3>${escapeHtml(ev.title || "Select")}</h3>` +
      `<div class="options">${options.join("")}</div>` +
      `<div class="dialog-actions"><button class="btn" data-c="cancel">Cancel</button></div></div>`;
    dialogRoot.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const v = e.target.getAttribute("data-v");
      if (v != null) {
        overlay.remove();
        resolve(v);
        return;
      }
      if (e.target.getAttribute("data-c") === "cancel") {
        overlay.remove();
        resolve(undefined);
      }
    });
  });
}

function showConfirmDialog(ev) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      `<div class="dialog"><h3>${escapeHtml(ev.title || "Confirm")}</h3>` +
      `<p class="dialog-msg">${escapeHtml(ev.message || "")}</p>` +
      `<div class="dialog-actions"><button class="btn" data-c="0">Cancel</button><button class="btn btn-primary" data-c="1">Confirm</button></div></div>`;
    dialogRoot.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const c = e.target.getAttribute("data-c");
      if (c != null) {
        overlay.remove();
        resolve(c === "1");
      }
    });
  });
}

function showInputDialog(ev) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      `<div class="dialog"><h3>${escapeHtml(ev.title || "Input")}</h3>` +
      `<input type="text" placeholder="${escapeHtml(ev.placeholder || "")}" />` +
      `<div class="dialog-actions"><button class="btn" data-c="0">Cancel</button><button class="btn btn-primary" data-c="1">OK</button></div></div>`;
    dialogRoot.appendChild(overlay);
    const input = overlay.querySelector("input");
    input.focus();
    const done = (c) => {
      overlay.remove();
      resolve(c === "1" ? input.value : undefined);
    };
    overlay.addEventListener("click", (e) => {
      const c = e.target.getAttribute("data-c");
      if (c != null) done(c);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done("1");
      if (e.key === "Escape") done("0");
    });
  });
}

function showEditorDialog(ev) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      `<div class="dialog"><h3>${escapeHtml(ev.title || "Edit")}</h3>` +
      `<textarea>${escapeHtml(ev.prefill || "")}</textarea>` +
      `<div class="dialog-actions"><button class="btn" data-c="0">Cancel</button><button class="btn btn-primary" data-c="1">Submit</button></div></div>`;
    dialogRoot.appendChild(overlay);
    const ta = overlay.querySelector("textarea");
    ta.focus();
    const done = (c) => {
      overlay.remove();
      resolve(c === "1" ? ta.value : undefined);
    };
    overlay.addEventListener("click", (e) => {
      const c = e.target.getAttribute("data-c");
      if (c != null) done(c);
    });
  });
}

/* ======================== slash command menu =========================== */

function maybeShowSlashMenu() {
  const val = inputEl.value;
  if (!val.startsWith("/")) return hideSlashMenu();
  const q = val.slice(1).toLowerCase();
  const matches = state.commands
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice(0, 12);
  if (!matches.length) return hideSlashMenu();
  showSlashMenu(matches);
}

function showSlashMenu(items) {
  hideSlashMenu();
  const menu = document.createElement("div");
  menu.id = "slash-menu";
  menu.innerHTML = items
    .map(
      (c) =>
        `<button type="button" data-cmd="${escapeHtml(c.name)}">` +
        `<span class="n">/${escapeHtml(c.name)}</span>` +
        `<span class="d">${escapeHtml(c.description || "")}</span></button>`,
    )
    .join("");
  inputEl.parentElement.style.position = "relative";
  inputEl.parentElement.appendChild(menu);
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cmd]");
    if (btn) {
      inputEl.value = "/" + btn.getAttribute("data-cmd") + " ";
      inputEl.focus();
      autoResize();
      hideSlashMenu();
    }
  });
}

function hideSlashMenu() {
  document.getElementById("slash-menu")?.remove();
}

/* ============================ rain on glass ============================ */

function initRain() {
  const rain = document.getElementById("rain");
  if (!rain) return;
  // Respect users who prefer less motion.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const count = Math.max(10, Math.min(20, Math.round(window.innerWidth / 90)));
  const variants = ["rainfall", "rainfall2", "rainfall3"];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const drop = document.createElement("span");
    drop.className = "drop";

    // Mix of small / medium / large drops (large ones read as clear windows).
    const r = Math.random();
    const w =
      r < 0.6 ? 4 + Math.random() * 6 : // small  4–10px
      r < 0.88 ? 10 + Math.random() * 8 : // medium 10–18px
      18 + Math.random() * 12; // large  18–30px
    const h = w * (1.02 + Math.random() * 0.45); // slightly taller → teardrop
    const trail = Math.random() < 0.35 ? 0 : w * (1 + Math.random() * 3); // longer trail for bigger drops
    const duration = 7 + Math.random() * 8 + w * 0.16; // bigger drops fall a bit slower
    const delay = -Math.random() * duration; // already mid-fall on load

    drop.style.left = (Math.random() * 100).toFixed(2) + "%";
    drop.style.setProperty("--w", w.toFixed(1) + "px");
    drop.style.setProperty("--h", h.toFixed(1) + "px");
    drop.style.setProperty("--trail", trail.toFixed(0) + "px");
    drop.style.opacity = (0.85 + Math.random() * 0.15).toFixed(2);
    drop.style.animationName = variants[Math.floor(Math.random() * variants.length)];
    drop.style.animationDuration = duration.toFixed(2) + "s";
    drop.style.animationDelay = delay.toFixed(2) + "s";
    if (trail > 0) {
      const tail = document.createElement("i");
      tail.className = "tail";
      drop.appendChild(tail);
    }
    frag.appendChild(drop);
  }
  rain.appendChild(frag);
}

/* ============================ init / wiring ============================ */

async function init() {
  // config first (needed for header cwd)
  try {
    state.config = await api("/api/config");
  } catch (e) {
    /* ignore */
  }

  await Promise.all([
    refreshModels(),
    refreshThinkingLevels(),
    refreshSessions(),
    refreshCommands(),
    refreshState(),
    refreshMessages(),
    refreshStats(),
  ]);

  updateHeader();
  updateStatus();

  // ---- composer events ----
  inputEl.addEventListener("input", () => {
    autoResize();
    maybeShowSlashMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
    if (e.key === "Escape") hideSlashMenu();
  });
  inputEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const comma = dataUrl.indexOf(",");
          const mime = file.type || "image/png";
          const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
          state.attachments.push({ data, mimeType: mime, preview: dataUrl });
          renderAttachments();
        };
        reader.readAsDataURL(file);
        handled = true;
      }
    }
    if (handled) e.preventDefault();
  });

  sendBtn.addEventListener("click", () => sendPrompt());
  abortBtn.addEventListener("click", () => abort());

  attachmentsEl.addEventListener("click", (e) => {
    const rm = e.target.closest(".rm");
    if (rm) {
      const i = Number(rm.getAttribute("data-i"));
      state.attachments.splice(i, 1);
      renderAttachments();
    }
  });

  modelSelect.addEventListener("change", async () => {
    const m = state.models[Number(modelSelect.value)];
    if (!m) return;
    try {
      await api("/api/rpc", { method: "POST", body: { type: "set_model", provider: m.provider, modelId: m.id } });
      refreshState();
    } catch (e) {
      toast("Error switching model: " + e.message);
      syncSelectors();
    }
  });

  thinkingSelect.addEventListener("change", async () => {
    try {
      await api("/api/rpc", { method: "POST", body: { type: "set_thinking_level", level: thinkingSelect.value } });
      state.thinkingLevel = thinkingSelect.value;
      updateStatus();
    } catch (e) {
      toast("Error: " + e.message);
    }
  });

  sessionListEl.addEventListener("click", async (e) => {
    const item = e.target.closest(".session-item");
    if (!item) return;
    const sessionPath = item.getAttribute("data-path");
    try {
      const r = await api("/api/rpc", { method: "POST", body: { type: "switch_session", sessionPath } });
      if (r.data?.cancelled) {
        toast("Session switch cancelled.");
        return;
      }
      await Promise.all([refreshState(), refreshMessages(), refreshStats(), refreshSessions()]);
    } catch (err) {
      toast("Error switching session: " + err.message);
    }
  });

  $("#btn-new-session").addEventListener("click", async () => {
    try {
      await api("/api/rpc", { method: "POST", body: { type: "new_session" } });
      await Promise.all([refreshState(), refreshMessages(), refreshStats(), refreshSessions()]);
      toast("New session started.");
    } catch (e) {
      toast("Error: " + e.message);
    }
  });

  $("#btn-export").addEventListener("click", async () => {
    try {
      const r = await api("/api/export", { method: "POST" });
      toast(r.path ? `Exported to ${r.path}` : "Exported.");
    } catch (e) {
      toast("Error exporting: " + e.message);
    }
  });

  $("#btn-restart").addEventListener("click", async () => {
    try {
      await api("/api/restart", { method: "POST" });
      toast("Agent restarted.");
      setTimeout(() => {
        refreshState();
        refreshMessages();
        refreshModels();
      }, 800);
    } catch (e) {
      toast("Error restarting: " + e.message);
    }
  });

  $("#btn-shutdown").addEventListener("click", async () => {
    const ok = await showConfirmDialog({
      title: "关闭服务？",
      message: "这会停止 Pi Web Agent 服务。之后请双击「启动.bat」重新启动。",
    });
    if (!ok) return;
    try {
      await api("/api/shutdown", { method: "POST" });
      toast("服务已停止。");
      setConn(false);
    } catch (e) {
      // server may have already exited before the response fully flushed
      toast("服务已停止。");
      setConn(false);
    }
  });

  // details open/close tracking (preserve user toggles across re-renders)
  messagesEl.addEventListener("toggle", (e) => {
    const details = e.target;
    if (details.tagName !== "DETAILS") return;
    const key = detailsKey(details);
    if (key) state.detailsOpen.set(key, details.open);
  }, true);

  // copy buttons (delegated)
  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const code = btn.parentElement?.querySelector("code")?.textContent || "";
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
  });

  // ---- SSE ----
  connectSSE();

  // ---- frosted-glass rain ----
  initRain();
}

function connectSSE() {
  const es = new EventSource("/events");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
}

init();
