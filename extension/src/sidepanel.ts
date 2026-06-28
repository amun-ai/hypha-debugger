/**
 * Side panel UI — connection controls + live activity log for the active tab.
 * Replaces the floating overlay. Talks to the SW via runtime messaging.
 */
import { buildAgentInstruction } from "../../javascript/src/relay/instruction.js";

interface TabState {
  status: string;
  serviceUrl: string;
  logs: Array<{ msg: string; kind: string; ts: number }>;
}

const $ = (id: string) => document.getElementById(id)!;
const dot = $("dot");
const tabLabel = $("tab");
const serverInput = $("server") as HTMLInputElement;
const wsInput = $("workspace") as HTMLInputElement;
const tokenInput = $("token") as HTMLInputElement;
const requireToken = $("requireToken") as HTMLInputElement;
const connectBtn = $("connect") as HTMLButtonElement;
const disconnectBtn = $("disconnect") as HTMLButtonElement;
const urlBox = $("urlBox");
const urlCode = $("url");
const logsEl = $("logs");

const tabStates = new Map<number, TabState>();
let currentTabId: number | null = null;
let currentUrl = "";

function state(tabId: number): TabState {
  let s = tabStates.get(tabId);
  if (!s) {
    s = { status: "disconnected", serviceUrl: "", logs: [] };
    tabStates.set(tabId, s);
  }
  return s;
}

function render(): void {
  if (currentTabId == null) return;
  const s = state(currentTabId);
  dot.className = "dot " + s.status;
  const connected = s.status === "connected";
  connectBtn.disabled = connected || s.status === "connecting";
  disconnectBtn.disabled = !connected && s.status !== "connecting";
  urlBox.className = "url" + (s.serviceUrl ? " show" : "");
  urlCode.textContent = s.serviceUrl;
  logsEl.innerHTML = "";
  for (const l of s.logs.slice(-300)) appendLogEl(l);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function appendLogEl(l: { msg: string; kind: string; ts: number }): void {
  const div = document.createElement("div");
  div.className = "log " + l.kind;
  const t = new Date(l.ts).toLocaleTimeString();
  div.innerHTML = `<span class="t">${t}</span> <span class="k">${escapeHtml(l.msg)}</span>`;
  logsEl.appendChild(div);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function log(tabId: number, msg: string, kind: string): void {
  const s = state(tabId);
  s.logs.push({ msg, kind, ts: Date.now() });
  if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
  if (tabId === currentTabId) {
    appendLogEl(s.logs[s.logs.length - 1]);
    logsEl.scrollTop = logsEl.scrollHeight;
  }
}

// ---- incoming UI messages from SW ----------------------------------------
chrome.runtime.onMessage.addListener((m: any) => {
  if (!m || !m.__hyphaUi || !m.__stamped) return;
  if (m.type === "active") return; // handled elsewhere
  const tabId = m.tabId;
  if (tabId == null) return;
  const s = state(tabId);
  if (m.type === "log") {
    log(tabId, m.msg, m.kind);
  } else if (m.type === "status") {
    s.status = m.status === "agent-ready" ? s.status : m.status;
    log(tabId, `· ${m.status}${m.detail ? ": " + m.detail : ""}`, "status");
    if (m.status === "disconnected") s.serviceUrl = "";
    if (tabId === currentTabId) render();
  } else if (m.type === "ready") {
    s.status = "connected";
    s.serviceUrl = m.service_url;
    log(tabId, `connected → ${m.service_url}`, "result");
    if (tabId === currentTabId) render();
  }
});

// ---- active tab tracking -------------------------------------------------
async function refreshActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;
  currentUrl = tab.url || "";
  tabLabel.textContent = hostOf(currentUrl);
  // reflect known connected state from storage
  const active = (await chrome.storage.local.get("hyphaActiveConnections")).hyphaActiveConnections || {};
  if (active[String(currentTabId)] && state(currentTabId!).status === "disconnected") {
    state(currentTabId!).status = "connected";
  }
  render();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "—";
  }
}

chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId: number, info: any) => {
  if (tabId === currentTabId && info.url) void refreshActiveTab();
});
chrome.windows?.onFocusChanged?.addListener(() => void refreshActiveTab());

// ---- controls ------------------------------------------------------------
connectBtn.addEventListener("click", async () => {
  if (currentTabId == null) return;
  const config = {
    server_url: serverInput.value.trim() || "https://hypha.aicell.io",
    workspace: wsInput.value.trim(),
    token: tokenInput.value.trim(),
    require_token: requireToken.checked,
  };
  await chrome.storage.local.set({ hyphaServerUrl: config.server_url });
  state(currentTabId).status = "connecting";
  state(currentTabId).serviceUrl = "";
  render();
  chrome.runtime.sendMessage({ __hyphaCtl: "connect", tabId: currentTabId, config });
});

disconnectBtn.addEventListener("click", () => {
  if (currentTabId == null) return;
  state(currentTabId).status = "disconnected";
  state(currentTabId).serviceUrl = "";
  chrome.runtime.sendMessage({ __hyphaCtl: "disconnect", tabId: currentTabId });
  render();
});

$("copyUrl").addEventListener("click", () => {
  if (currentTabId != null) navigator.clipboard.writeText(state(currentTabId).serviceUrl);
});
$("copySkill").addEventListener("click", () => {
  if (currentTabId == null) return;
  const url = state(currentTabId).serviceUrl;
  if (!url) return;
  navigator.clipboard.writeText(
    buildAgentInstruction(url, { target: hostOf(currentUrl) }),
  );
});
$("clear").addEventListener("click", () => {
  if (currentTabId != null) state(currentTabId).logs = [];
  render();
});

// ---- init ----------------------------------------------------------------
(async () => {
  const stored = (await chrome.storage.local.get("hyphaServerUrl")).hyphaServerUrl;
  if (stored) serverInput.value = stored;
  await refreshActiveTab();
})();
