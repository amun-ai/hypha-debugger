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
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  detachAll,
  forgetTab,
  type BrowserToolCtx,
} from "./browser-tools.js";

// The pinned target tab. storage.local is the single source of truth (survives
// the SW being reaped); targetTabId is just a hot cache hydrated on each call.
let targetTabId: number | null = null;
const ctx: BrowserToolCtx = {
  getTarget: () => targetTabId,
  setTarget: (id) => {
    targetTabId = id;
    try {
      chrome.storage.local.set({ hyphaTarget: id });
    } catch {
      /* ignore */
    }
    void emitTarget(id);
  },
};

/**
 * Authoritative read of the pinned target from storage on every call, so a
 * reaped SW (which loses targetTabId) never silently falls back to the active
 * tab. Verifies the tab still exists; clears it if it was closed.
 */
async function hydrateTarget(): Promise<void> {
  try {
    const r = await chrome.storage.local.get("hyphaTarget");
    const id = r.hyphaTarget;
    if (id != null) {
      try {
        await chrome.tabs.get(id);
        targetTabId = id;
        return;
      } catch {
        await chrome.storage.local.remove("hyphaTarget");
      }
    }
    targetTabId = null;
  } catch {
    /* keep whatever we had */
  }
}

async function emitTarget(id: number): Promise<void> {
  try {
    const t = await chrome.tabs.get(id);
    ui({ type: "target", tab: { id: t.id, title: t.title, url: t.url } });
  } catch {
    /* ignore */
  }
}

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
  await hydrateTarget(); // restore the pinned tab if the SW was reaped
  try {
    let value: any;
    if (BROWSER_TOOL_NAMES.has(method)) {
      value = await BROWSER_TOOLS[method].run(ctx, args || []);
    } else {
      let tabId = targetTabId;
      if (tabId == null) {
        const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (a?.id != null) {
          ctx.setTarget(a.id); // pin it so we stick to it from now on
          tabId = a.id;
        }
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
  try {
    // Pin the tab that's active at connect time as the stable target.
    const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (a?.id != null) ctx.setTarget(a.id);
    await chrome.storage.local.set({ hyphaConnected: true, hyphaConfig: config });
    await ensureOffscreen();
    // The freshly-loaded offscreen auto-connects from storage; also nudge an
    // already-open one. Either path connects (offscreen guards against double).
    chrome.runtime.sendMessage({ __off: "connect", config }).catch(() => {});
  } catch (e: any) {
    ui({ type: "status", status: "error", detail: "setup failed: " + (e?.message ?? e) });
  }
}

/** Pin the currently active tab as the target (from the side panel). */
async function pinActiveTab(): Promise<void> {
  const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (a?.id != null) ctx.setTarget(a.id);
}
async function disconnectBrowser(): Promise<void> {
  await chrome.storage.local.set({ hyphaConnected: false });
  chrome.runtime.sendMessage({ __off: "disconnect" }).catch(() => {});
  await detachAll(); // release any chrome.debugger attachments (clears the banner)
}

/** Recreate the offscreen + (re)connect if we should be connected (keepalive). */
async function reconcile(): Promise<void> {
  const r = await chrome.storage.local.get(["hyphaConnected", "hyphaConfig"]);
  if (r.hyphaConnected && r.hyphaConfig) {
    await ensureOffscreen();
    // The offscreen no longer reads storage itself — drive it from here.
    // No-op if it's already connected (offscreen guards on connecting||server).
    chrome.runtime.sendMessage({ __off: "connect", config: r.hyphaConfig }).catch(() => {});
  }
}

/** Persist the live connection state from the offscreen's __ui messages, since
 *  the offscreen can't use chrome.storage itself. */
async function persistUi(msg: any): Promise<void> {
  if (msg.type === "ready") {
    await chrome.storage.local.set({
      hyphaStatus: "connected",
      hyphaServiceUrl: msg.service_url || "",
      hyphaToken: msg.token || "",
      hyphaWorkspace: msg.workspace || "",
    });
  } else if (msg.type === "status") {
    if (msg.status === "disconnected" || msg.status === "error") {
      await chrome.storage.local.set({ hyphaStatus: msg.status, hyphaServiceUrl: "" });
    } else if (msg.status === "connecting" || msg.status === "connected") {
      await chrome.storage.local.set({ hyphaStatus: msg.status });
    }
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
  // Persist connection state from the offscreen (it can't use chrome.storage).
  if (msg.__ui) {
    void persistUi(msg);
    return;
  }
  // Offscreen (re)loaded — tell it to connect with the stored config.
  if (msg.__off === "offscreenReady") {
    void (async () => {
      const r = await chrome.storage.local.get(["hyphaConnected", "hyphaConfig"]);
      if (r.hyphaConnected && r.hyphaConfig)
        chrome.runtime.sendMessage({ __off: "connect", config: r.hyphaConfig }).catch(() => {});
    })();
    return;
  }
  if (msg.__ctl === "connect") {
    void connectBrowser(msg.config);
  } else if (msg.__ctl === "disconnect") {
    void disconnectBrowser();
  } else if (msg.__ctl === "pinActiveTab") {
    void pinActiveTab();
  } else if (msg.__ctl === "getStatus") {
    // Side panel just opened — replay the live connection state + target so it
    // never shows "connected" with a blank URL.
    void (async () => {
      const s = await chrome.storage.local.get([
        "hyphaStatus",
        "hyphaServiceUrl",
        "hyphaToken",
        "hyphaWorkspace",
      ]);
      if (s.hyphaServiceUrl) {
        ui({
          type: "ready",
          service_url: s.hyphaServiceUrl,
          token: s.hyphaToken || "",
          workspace: s.hyphaWorkspace || "",
        });
      } else if (s.hyphaStatus) {
        ui({ type: "status", status: s.hyphaStatus });
      }
      await hydrateTarget();
      if (targetTabId != null) await emitTarget(targetTabId);
    })();
  }
});

// Keep the target sensible if it closes; drop any debugger attachment for it.
chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId === targetTabId) targetTabId = null;
  forgetTab(tabId);
});
// If the user dismisses the debugger banner ("Cancel"), forget the attachment.
chrome.debugger?.onDetach?.addListener((source: any) => {
  if (source?.tabId != null) forgetTab(source.tabId);
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
