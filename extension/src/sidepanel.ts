/**
 * Side panel UI — one browser-wide connection: connect/disconnect, the service
 * URL to hand an agent, and a live activity log. State is driven by __ui
 * messages from the offscreen connection + the SW dispatcher.
 */
import { buildAgentInstruction } from "../../javascript/src/relay/instruction.js";

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

let status = "disconnected";
let serviceUrl = "";

function render(): void {
  dot.className = "dot " + status;
  const connected = status === "connected";
  connectBtn.disabled = connected || status === "connecting";
  disconnectBtn.disabled = !connected && status !== "connecting";
  connectBtn.textContent = connected ? "Connected" : "Connect browser";
  urlBox.className = "url" + (serviceUrl ? " show" : "");
  urlCode.textContent = serviceUrl;
}

function appendLog(msg: string, kind: string): void {
  const div = document.createElement("div");
  div.className = "log " + kind;
  div.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span> <span class="k">${escapeHtml(msg)}</span>`;
  logsEl.appendChild(div);
  while (logsEl.childElementCount > 400) logsEl.removeChild(logsEl.firstChild!);
  logsEl.scrollTop = logsEl.scrollHeight;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function setTarget(tab: { id: number; title?: string; url?: string }): void {
  const el = $("targetTab");
  const label = tab.title || tab.url || `tab ${tab.id}`;
  el.textContent = label;
  el.setAttribute("title", `${tab.title || ""}\n${tab.url || ""}`);
}

chrome.runtime.onMessage.addListener((m: any) => {
  if (!m || !m.__ui) return;
  if (m.type === "log") {
    appendLog(m.msg, m.kind || "");
  } else if (m.type === "status") {
    status = m.status;
    if (m.status === "disconnected" || m.status === "error") serviceUrl = "";
    appendLog(`· ${m.status}${m.detail ? ": " + m.detail : ""}`, m.status === "error" ? "error" : "status");
    render();
  } else if (m.type === "ready") {
    status = "connected";
    serviceUrl = m.service_url;
    appendLog(`connected → ${m.service_url}`, "result");
    render();
  } else if (m.type === "target" && m.tab) {
    setTarget(m.tab);
  }
});

connectBtn.addEventListener("click", async () => {
  const config = {
    server_url: serverInput.value.trim() || "https://hypha.aicell.io",
    workspace: wsInput.value.trim(),
    token: tokenInput.value.trim(),
    require_token: requireToken.checked,
  };
  await chrome.storage.local.set({ hyphaServerUrl: config.server_url });
  status = "connecting";
  serviceUrl = "";
  render();
  chrome.runtime.sendMessage({ __ctl: "connect", config });
});
disconnectBtn.addEventListener("click", () => {
  status = "disconnected";
  serviceUrl = "";
  render();
  chrome.runtime.sendMessage({ __ctl: "disconnect" });
});
$("copyUrl").addEventListener("click", () => {
  if (serviceUrl) navigator.clipboard.writeText(serviceUrl);
});
$("copySkill").addEventListener("click", () => {
  if (serviceUrl)
    navigator.clipboard.writeText(
      buildAgentInstruction(serviceUrl, { target: "this browser" }).replace(
        "this live web page",
        "this browser (open/close/navigate tabs + inspect & control pages)",
      ),
    );
});
$("clear").addEventListener("click", () => {
  logsEl.innerHTML = "";
});
$("pinTab").addEventListener("click", () => {
  chrome.runtime.sendMessage({ __ctl: "pinActiveTab" });
});
// Save the server URL as the user edits it (persists across sessions, even
// without connecting).
let saveTimer: any;
serverInput.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ hyphaServerUrl: serverInput.value.trim() });
  }, 300);
});

(async () => {
  // Restore the live connection state from storage so re-opening the panel
  // shows the URL/status without a disconnect/reconnect.
  const r = await chrome.storage.local.get([
    "hyphaServerUrl",
    "hyphaStatus",
    "hyphaServiceUrl",
  ]);
  if (r.hyphaServerUrl) serverInput.value = r.hyphaServerUrl;
  if (r.hyphaStatus) status = r.hyphaStatus;
  if (r.hyphaServiceUrl) serviceUrl = r.hyphaServiceUrl;
  tabLabel.textContent = "browser-wide";
  render();
  // Ask the SW to replay the current target tab.
  chrome.runtime.sendMessage({ __ctl: "getStatus" }).catch(() => {});
})();
