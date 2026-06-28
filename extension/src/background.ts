/**
 * Background service worker — the dispatcher + lifecycle manager for the
 * browser-wide debugger. It is the only context with chrome.tabs/windows, so:
 *
 *  - browser tools (open/close/list/activate tabs, navigate, history) run here
 *  - page tools are routed to the current TARGET tab's content script (injected
 *    on demand)
 *  - the Hypha connection itself lives in the offscreen document; the SW keeps
 *    it alive (alarm + recreate) and restores it from storage (restart tolerance)
 */
import { BROWSER_TOOLS, BROWSER_TOOL_NAMES, type BrowserToolCtx } from "./browser-tools.js";

let targetTabId: number | null = null;
const ctx: BrowserToolCtx = {
  getTarget: () => targetTabId,
  setTarget: (id) => {
    targetTabId = id;
  },
};

// ---- offscreen lifecycle -------------------------------------------------
let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const has = await hasOffscreen();
  if (has) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "DOM_SCRAPING"],
        justification:
          "Hold the persistent Hypha RPC WebSocket connection (needs a DOM and a stable lifetime).",
      })
      .catch((e: any) => {
        if (!String(e?.message || e).includes("single offscreen")) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}
async function hasOffscreen(): Promise<boolean> {
  try {
    const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return c.length > 0;
  } catch {
    return false;
  }
}

// ---- inject the page executor into a tab on demand -----------------------
async function ensureContent(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["main-world.js"],
      world: "MAIN",
    });
  } catch (e: any) {
    throw new Error(
      "Cannot attach to this tab (a restricted page like chrome:// or the Web Store?): " +
        (e?.message ?? e),
    );
  }
}

// ---- dispatch a tool call ------------------------------------------------
async function handleCall(method: string, args: any[]): Promise<any> {
  ui({ type: "log", msg: `${method}(${summarize(args)})`, kind: "call" });
  try {
    let value: any;
    if (BROWSER_TOOL_NAMES.has(method)) {
      value = await BROWSER_TOOLS[method].run(ctx, args || []);
    } else {
      let tabId = targetTabId;
      if (tabId == null) {
        const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = a?.id ?? null;
        if (tabId != null) targetTabId = tabId;
      }
      if (tabId == null) throw new Error("No target tab — open or activate a tab first");
      await ensureContent(tabId);
      const res = await chrome.tabs.sendMessage(tabId, { __hyphaPage: true, method, args });
      if (res && res.__error) throw new Error(res.__error);
      value = res ? res.value : undefined;
    }
    const isErr = value && typeof value === "object" && "error" in value;
    ui({ type: "log", msg: isErr ? `${method}: ${value.error}` : `${method} -> ok`, kind: isErr ? "error" : "result" });
    return value;
  } catch (e: any) {
    ui({ type: "log", msg: `${method}: ${e?.message ?? e}`, kind: "error" });
    throw e;
  }
}

// ---- connect / disconnect (from side panel) ------------------------------
async function connectBrowser(config: any): Promise<void> {
  const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (a?.id != null) targetTabId = a.id;
  await chrome.storage.local.set({ hyphaConnected: true, hyphaConfig: config });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ __off: "connect", config }).catch(() => {});
}
async function disconnectBrowser(): Promise<void> {
  await chrome.storage.local.set({ hyphaConnected: false });
  chrome.runtime.sendMessage({ __off: "disconnect" }).catch(() => {});
}

/** Recreate the offscreen + reconnect if we should be connected (keepalive). */
async function reconcile(): Promise<void> {
  const r = await chrome.storage.local.get(["hyphaConnected", "hyphaConfig"]);
  if (r.hyphaConnected && r.hyphaConfig) {
    await ensureOffscreen(); // offscreen auto-reconnects from storage on load
  }
}

function ui(data: any): void {
  chrome.runtime.sendMessage({ __ui: true, ...data }).catch(() => {});
}
function summarize(args: any[]): string {
  if (!args || !args.length) return "";
  return args
    .map((a) =>
      typeof a === "string" ? (a.length > 40 ? a.slice(0, 40) + "…" : a) : typeof a === "object" && a ? "{…}" : String(a),
    )
    .join(", ");
}

// ---- message routing -----------------------------------------------------
chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.__hyphaCall) {
    handleCall(msg.method, msg.args)
      .then((value) => sendResponse({ value }))
      .catch((e) => sendResponse({ __error: e?.message ?? String(e) }));
    return true; // async response
  }
  if (msg.__ctl === "connect") {
    void connectBrowser(msg.config);
  } else if (msg.__ctl === "disconnect") {
    void disconnectBrowser();
  }
});

// Keep the target sensible if it closes.
chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId === targetTabId) targetTabId = null;
});

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// Keepalive + restart tolerance.
chrome.alarms?.create?.("hypha-keepalive", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm?.addListener((a: any) => {
  if (a.name === "hypha-keepalive") void reconcile();
});
chrome.runtime.onStartup?.addListener(() => void reconcile());
chrome.runtime.onInstalled?.addListener(() => void reconcile());
void reconcile();
