/**
 * Browser-level automation tools — schemas + implementations that run in the
 * background service worker (the only context with chrome.tabs / windows /
 * scripting). These let a remote agent drive the whole browser: list/open/close
 * tabs, switch the active/target tab, navigate, reload, history.
 *
 * Page-level tools (get_browser_state, click_element_by_index, screenshot, …)
 * operate on the current TARGET tab and are executed in that tab's content
 * script. activate_tab / open_tab set the target.
 */

import { autoReturn } from "../../javascript/src/services/execute.js";

export interface BrowserToolCtx {
  getTarget: () => number | null;
  setTarget: (tabId: number) => void;
}

// ---- CDP eval: run JS in the page bypassing its CSP (incl. no-unsafe-eval) --
// This is the only way to execute arbitrary code on a strict-CSP page; it's how
// Puppeteer/Playwright/DevTools do it. Lazily attaches the debugger to the tab
// (shows Chrome's "debugging this browser" banner) and turns on Page.setBypassCSP.
const attached = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.setBypassCSP", { enabled: true });
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
    /* best-effort */
  }
}

export async function detachAll(): Promise<void> {
  for (const id of [...attached]) {
    try {
      await chrome.debugger.detach({ tabId: id });
    } catch {
      /* ignore */
    }
  }
  attached.clear();
}

export function forgetTab(tabId: number): void {
  attached.delete(tabId);
}

async function cdpEval(tabId: number, code: string): Promise<any> {
  try {
    await ensureAttached(tabId);
  } catch (e: any) {
    return {
      error:
        "Could not attach the Chrome debugger to this tab: " +
        (e?.message ?? e) +
        " (restricted page like chrome:// or the Web Store, or another debugger is already attached).",
    };
  }
  const expression = `(async () => { ${autoReturn(code)} })()`;
  const res: any = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    replMode: true,
  });
  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    return { error: ex.exception?.description || ex.exception?.value || ex.text || "Evaluation error" };
  }
  const r = res?.result || {};
  return { result: r.value !== undefined ? r.value : r.description ?? null, type: r.type };
}

type Tool = {
  schema: any;
  run: (ctx: BrowserToolCtx, args: any[]) => Promise<any>;
};

declare const chrome: any;

function tabSummary(t: any) {
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    window_id: t.windowId,
    status: t.status,
  };
}

async function resolveTarget(ctx: BrowserToolCtx): Promise<number> {
  let id = ctx.getTarget();
  if (id != null) {
    try {
      await chrome.tabs.get(id);
      return id;
    } catch {
      /* target gone — fall through to active */
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No active tab");
  ctx.setTarget(active.id);
  return active.id;
}

export const BROWSER_TOOLS: Record<string, Tool> = {
  list_tabs: {
    schema: {
      name: "list_tabs",
      description:
        "List all open browser tabs across windows. Returns id, title, url, active, window_id, status. Use the id with activate_tab / close_tab / navigate.",
      parameters: { type: "object", properties: {} },
    },
    run: async () => (await chrome.tabs.query({})).map(tabSummary),
  },

  get_active_tab: {
    schema: {
      name: "get_active_tab",
      description:
        "Get the currently targeted tab (the tab that page-level tools act on). Defaults to the browser's active tab.",
      parameters: { type: "object", properties: {} },
    },
    run: async (ctx) => {
      const id = await resolveTarget(ctx);
      return tabSummary(await chrome.tabs.get(id));
    },
  },

  open_tab: {
    schema: {
      name: "open_tab",
      description:
        "Open a new tab at a URL and make it the target for page-level tools. Returns the new tab.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open (include https://)" },
          focus: { type: "boolean", description: "Focus the new tab (default true)" },
        },
        required: ["url"],
      },
    },
    run: async (ctx, [url, focus = true]) => {
      const t = await chrome.tabs.create({ url, active: !!focus });
      ctx.setTarget(t.id);
      return tabSummary(t);
    },
  },

  close_tab: {
    schema: {
      name: "close_tab",
      description: "Close a tab by id.",
      parameters: {
        type: "object",
        properties: { tab_id: { type: "number", description: "Tab id to close" } },
        required: ["tab_id"],
      },
    },
    run: async (_ctx, [tab_id]) => {
      await chrome.tabs.remove(tab_id);
      return { success: true };
    },
  },

  activate_tab: {
    schema: {
      name: "activate_tab",
      description:
        "Focus a tab by id and make it the target for page-level tools (get_browser_state, click_element_by_index, screenshot, …).",
      parameters: {
        type: "object",
        properties: { tab_id: { type: "number", description: "Tab id to target" } },
        required: ["tab_id"],
      },
    },
    run: async (ctx, [tab_id]) => {
      const t = await chrome.tabs.get(tab_id);
      await chrome.tabs.update(tab_id, { active: true });
      try {
        await chrome.windows.update(t.windowId, { focused: true });
      } catch {
        /* ignore */
      }
      ctx.setTarget(tab_id);
      return { success: true, tab: tabSummary(await chrome.tabs.get(tab_id)) };
    },
  },

  navigate: {
    schema: {
      name: "navigate",
      description:
        "Navigate the target tab to a URL (full page load). Use open_tab to navigate in a new tab instead.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "URL to navigate to" } },
        required: ["url"],
      },
    },
    run: async (ctx, [url]) => {
      const id = await resolveTarget(ctx);
      await chrome.tabs.update(id, { url });
      return { success: true, url };
    },
  },

  reload_tab: {
    schema: {
      name: "reload_tab",
      description: "Reload the target tab.",
      parameters: {
        type: "object",
        properties: {
          bypass_cache: { type: "boolean", description: "Hard reload (default false)" },
        },
      },
    },
    run: async (ctx, [bypass_cache = false]) => {
      const id = await resolveTarget(ctx);
      await chrome.tabs.reload(id, { bypassCache: !!bypass_cache });
      return { success: true };
    },
  },

  go_back: {
    schema: {
      name: "go_back",
      description: "Go back in the target tab's history.",
      parameters: { type: "object", properties: {} },
    },
    run: async (ctx) => {
      await chrome.tabs.goBack(await resolveTarget(ctx));
      return { success: true };
    },
  },

  go_forward: {
    schema: {
      name: "go_forward",
      description: "Go forward in the target tab's history.",
      parameters: { type: "object", properties: {} },
    },
    run: async (ctx) => {
      await chrome.tabs.goForward(await resolveTarget(ctx));
      return { success: true };
    },
  },

  execute_script: {
    schema: {
      name: "execute_script",
      description:
        "Run arbitrary JavaScript in the target tab's page context and return the result. Uses the Chrome debugger (Page.setBypassCSP), so it works even on strict-CSP pages that block 'unsafe-eval'. The last expression is auto-returned; async code is awaited. Attaching shows Chrome's 'debugging this browser' banner.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript to execute" } },
        required: ["code"],
      },
    },
    run: async (ctx, [code]) => cdpEval(await resolveTarget(ctx), String(code ?? "")),
  },
};

export const BROWSER_TOOL_NAMES = new Set(Object.keys(BROWSER_TOOLS));
