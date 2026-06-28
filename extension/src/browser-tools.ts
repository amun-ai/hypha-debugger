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

export interface BrowserToolCtx {
  getTarget: () => number | null;
  setTarget: (tabId: number) => void;
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
};

export const BROWSER_TOOL_NAMES = new Set(Object.keys(BROWSER_TOOLS));
