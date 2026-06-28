/**
 * Background service worker — a stateless router + lifecycle manager. It holds
 * NO connection itself (MV3 SWs are reaped ~30s idle); the Hypha connection
 * lives in the offscreen document, which persists across SW naps. The SW:
 *
 *  - routes relay envelopes content(agent) <-> offscreen(connector)
 *  - stamps + rebroadcasts UI messages (logs/status) to the side panel
 *  - manages connect/disconnect from the side panel (inject scripts, ensure
 *    offscreen, tell offscreen to create/destroy a per-tab connector)
 *  - persists active connections to chrome.storage and reconciles on wake/startup
 *    (restart tolerance)
 */
import { RELAY_ENVELOPE } from "./runtime-channel.js";

const OFFSCREEN_PATH = "offscreen.html";
const STORE_KEY = "hyphaActiveConnections"; // { [tabId]: config }

// ---- offscreen lifecycle -------------------------------------------------
let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const has = await (chrome.offscreen?.hasDocument?.() ?? hasOffscreenFallback());
  if (has) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS", "DOM_SCRAPING"],
        justification:
          "Hold the Hypha RPC WebSocket connection (needs a DOM and a stable lifetime).",
      })
      .catch((e: any) => {
        // "Only a single offscreen document may be created" — already exists.
        if (!String(e?.message || e).includes("single offscreen")) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function hasOffscreenFallback(): Promise<boolean> {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctxs.length > 0;
  } catch {
    return false;
  }
}

// ---- storage helpers -----------------------------------------------------
async function getActive(): Promise<Record<string, any>> {
  const r = await chrome.storage.local.get(STORE_KEY);
  return r[STORE_KEY] || {};
}
async function setActive(map: Record<string, any>): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: map });
}

// ---- connect / disconnect ------------------------------------------------
async function connectTab(tabId: number, config: any): Promise<void> {
  await ensureOffscreen();
  // Inject the agent (isolated) + react helper (MAIN world). Idempotent guards
  // inside each script prevent double-init.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["main-world.js"],
      world: "MAIN",
    });
  } catch (e) {
    console.warn("[hypha-bg] inject failed", e);
  }
  const active = await getActive();
  active[tabId] = config;
  await setActive(active);
  // Tell the offscreen connector to (re)create for this tab.
  chrome.runtime
    .sendMessage({ __hyphaCtl: "createConnector", tabId, config })
    .catch(() => {});
}

async function disconnectTab(tabId: number): Promise<void> {
  const active = await getActive();
  delete active[tabId];
  await setActive(active);
  chrome.runtime.sendMessage({ __hyphaCtl: "destroyConnector", tabId }).catch(() => {});
  stampUi({ type: "status", status: "disconnected" }, tabId);
}

/** Re-establish connectors after an SW wake / browser startup. */
async function reconcile(): Promise<void> {
  const active = await getActive();
  const tabIds = Object.keys(active);
  if (tabIds.length === 0) return;
  await ensureOffscreen();
  for (const idStr of tabIds) {
    const tabId = Number(idStr);
    try {
      await chrome.tabs.get(tabId); // still exists?
      await connectTab(tabId, active[idStr]);
    } catch {
      delete active[idStr]; // tab gone (e.g. after browser restart)
    }
  }
  await setActive(active);
}

// ---- UI fan-out (logs/status → side panel) -------------------------------
function stampUi(data: any, tabId: number): void {
  chrome.runtime
    .sendMessage({ __hyphaUi: true, __stamped: true, tabId, ...data })
    .catch(() => {});
}

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg: any, sender: any) => {
  if (!msg || typeof msg !== "object") return;

  // Relay envelopes
  if (msg[RELAY_ENVELOPE]) {
    if (msg.dir === "toConnector" && sender?.tab?.id != null) {
      // agent → connector: stamp tabId, hand to offscreen
      chrome.runtime
        .sendMessage({ ...msg, tabId: sender.tab.id })
        .catch(() => {});
    } else if (msg.dir === "toAgent" && msg.tabId != null && !sender?.tab) {
      // connector → agent: deliver to the tab's content script
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    }
    return;
  }

  // UI messages from content (sender.tab) or offscreen (msg.tabId), pre-stamp
  if (msg.__hyphaUi && !msg.__stamped) {
    const tabId = sender?.tab?.id ?? msg.tabId;
    if (tabId != null) {
      const { __hyphaUi, tabId: _t, ...rest } = msg;
      stampUi(rest, tabId);
    }
    return;
  }

  // Control from the side panel
  if (msg.__hyphaCtl === "connect") {
    void connectTab(msg.tabId, msg.config);
    return;
  }
  if (msg.__hyphaCtl === "disconnect") {
    void disconnectTab(msg.tabId);
    return;
  }
  if (msg.__hyphaCtl === "getActive") {
    // async response
    getActive().then((a) => chrome.runtime.sendMessage({ __hyphaUi: true, __stamped: true, type: "active", active: a }).catch(() => {}));
    return;
  }
});

// Clean up when a debugged tab closes.
chrome.tabs.onRemoved.addListener((tabId: number) => {
  void disconnectTab(tabId);
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// Restart tolerance: reconnect known tabs on wake / startup.
chrome.runtime.onStartup?.addListener(() => void reconcile());
chrome.runtime.onInstalled?.addListener(() => void reconcile());
void reconcile();
