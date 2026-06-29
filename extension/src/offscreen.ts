/**
 * Offscreen document — hosts the single, browser-wide Hypha connection (needs a
 * DOM + a stable lifetime, which the service worker lacks). It registers ONE
 * service whose tools are proxied to the background SW, which dispatches them to
 * browser APIs (tabs/windows) or to the target tab's content script.
 *
 * Reconnects itself from chrome.storage on load, so if Chrome reaps the
 * offscreen doc and the SW recreates it, the connection comes back automatically.
 */
import * as hyphaRpc from "hypha-rpc";
import { buildCatalog } from "./service-catalog.js";
import { generateSkillMd } from "../../javascript/src/services/skill.js";
import { buildServiceUrl, randomHex } from "../../javascript/src/relay/service-url.js";
import { wrapFn as baseWrapFn } from "../../javascript/src/utils/wrap-fn.js";

let server: any = null;
let connecting = false;

// Guidance injected into get_skill_md — teaches the efficient explore→script→
// accumulate-skills loop so the agent gets smarter and cheaper on each site.
const SKILL_GUIDANCE = [
  "## How to work efficiently (read this first)",
  "",
  "You are driving a whole browser. Optimize for FEW steps and FEW tokens:",
  "",
  "1. **Check what you already know.** At the start of a task on a site, call",
  "   `list_skills()` — it returns reusable recipes saved for this site from past",
  "   sessions. Reuse them instead of re-exploring.",
  "2. **Explore only when needed.** If there's no skill yet, use the exploration",
  "   tools (`get_browser_state`, `query_dom`, `get_html`, `take_screenshot`,",
  "   `get_react_tree`) to learn the page's structure and interactive elements.",
  "3. **Then script, don't click.** Prefer `execute_script` for real work: read/",
  "   modify state, and call the site's OWN APIs with `fetch`. Discover API",
  "   endpoints (watch network calls, inspect `window`/global state, try `fetch`)",
  "   and script against them — far cheaper than UI click/type round-trips.",
  "4. **Batch over loop.** Do many items in ONE `execute_script` call (map over a",
  "   list, one `fetch` that returns everything) instead of many small calls.",
  "5. **Accumulate skills as markdown experience.** A skill is a MARKDOWN note",
  "   about ONE type of operation on the site (searching, exporting, creating, …).",
  "   When you work out how to do an operation, save it with `set_skill(key, value)`:",
  "   - `key`: the operation type — short and stable, e.g. `search`, `export-report`,",
  "     `create-ticket`, `login`.",
  "   - `value`: a concise markdown note — what works, the execute_script JS snippet",
  "     or discovered API endpoint+params, key selectors/indices, the steps, and",
  "     gotchas. Write it so a future session can follow it without re-exploring.",
  "   Use `get_skill(key)` to recall one (read before editing, then set_skill again to",
  "   update), and `remove_skill(key)` to prune stale ones. Skills persist per site.",
  "",
  "**Loop:** list_skills → (explore once if new) → script & batch via execute_script",
  "→ set_skill the markdown note for what you learned. Each site gets faster over time.",
  "",
  "Tabs: use `list_tabs`/`open_tab`/`activate_tab`/`navigate` to control which page",
  "you're working on. Page tools act on the current target tab.",
].join("\n");

function getConnect(): (cfg: any) => Promise<any> {
  const override = (globalThis as any).__HYPHA_CONNECT__;
  if (typeof override === "function") return override;
  const mod: any = hyphaRpc as any;
  if (mod.connectToServer) return mod.connectToServer;
  if (mod.hyphaWebsocketClient?.connectToServer)
    return mod.hyphaWebsocketClient.connectToServer;
  throw new Error("hypha-rpc connectToServer not found");
}

function ui(data: any): void {
  chrome.runtime.sendMessage({ __ui: true, ...data }).catch(() => {});
}

/** Proxy a tool call through the SW (which runs it / routes it to a tab). */
function makeProxy(name: string, schema: any): any {
  const inner = async (...args: any[]) => {
    const r = await chrome.runtime.sendMessage({ __hyphaCall: true, method: name, args });
    if (r && r.__error) throw new Error(r.__error);
    return r ? r.value : undefined;
  };
  (inner as any).__schema__ = schema;
  return baseWrapFn(inner);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

async function connect(config: any): Promise<void> {
  if (connecting || server) return; // already connecting or connected
  connecting = true;
  try {
    // NOTE: do NOT use chrome.storage here — it is restricted in offscreen
    // documents and throwing/hanging would abort the connect. The service
    // worker owns persistence (it watches our __ui messages).
    ui({ type: "status", status: "connecting" });
    ui({ type: "log", msg: `connecting to ${config.server_url} …`, kind: "status" });
    console.log("[hypha-offscreen] connecting to", config.server_url);
    const connectToServer = getConnect();
    const baseCfg: any = { server_url: config.server_url };
    if (config.token) baseCfg.token = config.token;
    const cfg: any = { ...baseCfg };
    if (config.workspace) cfg.workspace = config.workspace;

    try {
      server = await withTimeout(connectToServer(cfg), 25000, "connect");
    } catch (e: any) {
      // A saved workspace may be stale/expired — retry with a fresh one.
      if (config.workspace) {
        ui({ type: "log", msg: "retrying without the saved workspace …", kind: "status" });
        server = await withTimeout(connectToServer({ ...baseCfg }), 25000, "connect");
      } else {
        throw e;
      }
    }
    ui({
      type: "log",
      msg: `connected (workspace ${server.config?.workspace ?? "?"}), registering tools …`,
      kind: "status",
    });

    const catalog = buildCatalog();
    const serviceId = config.service_id || `web-debugger-${randomHex(16)}`;
    const def: any = {
      id: serviceId,
      name: config.service_name || "Browser Debugger",
      type: "debugger",
      description:
        "Remote browser automation: drive tabs (open/close/navigate/switch) and inspect & control the target page (DOM, screenshots, click/type by index, React).",
      config: { visibility: config.require_token ? "protected" : "unlisted" },
    };
    for (const { name, schema } of catalog) def[name] = makeProxy(name, schema);

    // get_skill_md is generated here from the FULL catalog (incl. browser tools).
    let serviceUrl = "{SERVICE_URL}";
    const skillFn: any = () => {
      const fns: Record<string, any> = {};
      for (const { name, schema } of catalog) fns[name] = { __schema__: schema };
      return generateSkillMd(fns, serviceUrl, undefined, SKILL_GUIDANCE);
    };
    skillFn.__schema__ = {
      name: "get_skill_md",
      description:
        "Full API documentation for all browser + page tools, with usage examples.",
      parameters: { type: "object", properties: {} },
    };
    def.get_skill_md = baseWrapFn(skillFn);

    const info: any = await withTimeout<any>(
      server.registerService(def),
      25000,
      "register service",
    );
    serviceUrl = buildServiceUrl(config.server_url, info.id ?? serviceId);
    const workspace = server.config?.workspace ?? "";
    const token = config.require_token
      ? await server.generateToken({ expires_in: 86400 })
      : "";
    // The SW persists status/service_url from these __ui messages.
    ui({ type: "ready", service_url: serviceUrl, token, workspace });
    ui({ type: "status", status: "connected", detail: serviceUrl });
  } catch (e: any) {
    server = null;
    console.error("[hypha-offscreen] connect failed:", e);
    ui({ type: "status", status: "error", detail: e?.message ?? String(e) });
  } finally {
    connecting = false;
  }
}

async function disconnect(): Promise<void> {
  // Clear the reference first so a hung server.disconnect() can never block a
  // subsequent connect; do the actual teardown best-effort in the background.
  const s = server;
  server = null;
  try {
    s?.disconnect?.();
  } catch {
    /* ignore */
  }
  ui({ type: "status", status: "disconnected" });
}

chrome.runtime.onMessage.addListener((msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.__off === "connect") void connect(msg.config);
  else if (msg.__off === "disconnect") void disconnect();
  // keepalive ping from SW — receiving it is enough to keep us warm.
});

// The service worker drives connection: it sends {__off:"connect"} after
// creating us (and on reconcile). We tell it we're ready in case it created us
// and the message raced ahead of this listener.
chrome.runtime.sendMessage({ __off: "offscreenReady" }).catch(() => {});

// Keepalive: periodic message keeps the SW warm and signals we're alive.
setInterval(() => {
  chrome.runtime.sendMessage({ __off: "keepalive", connected: !!server }).catch(() => {});
}, 20000);
