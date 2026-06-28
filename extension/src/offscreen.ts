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
  if (connecting) return; // a connect is already in flight
  connecting = true;
  // Tear down any stale/dead connection first so we never wedge on it.
  if (server) {
    try {
      server.disconnect?.();
    } catch {
      /* ignore */
    }
    server = null;
  }
  try {
    await chrome.storage.local.set({ hyphaStatus: "connecting" });
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
      return generateSkillMd(fns, serviceUrl);
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
    // Persist so the side panel can show the URL even if it (re)opens after the
    // live "ready" message, or the SW cycled.
    await chrome.storage.local.set({
      hyphaStatus: "connected",
      hyphaServiceUrl: serviceUrl,
      hyphaToken: token,
      hyphaWorkspace: workspace,
    });
    ui({ type: "ready", service_url: serviceUrl, token, workspace });
    ui({ type: "status", status: "connected", detail: serviceUrl });
  } catch (e: any) {
    server = null;
    // Also log to the offscreen's own console so it can be inspected via
    // chrome://extensions → "Inspect views: offscreen.html".
    console.error("[hypha-offscreen] connect failed:", e);
    await chrome.storage.local.set({ hyphaStatus: "error", hyphaServiceUrl: "" });
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
  await chrome.storage.local.set({ hyphaStatus: "disconnected", hyphaServiceUrl: "" });
  ui({ type: "status", status: "disconnected" });
}

chrome.runtime.onMessage.addListener((msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.__off === "connect") void connect(msg.config);
  else if (msg.__off === "disconnect") void disconnect();
  // keepalive ping from SW — receiving it is enough to keep us warm.
});

// Reconnect from storage on (re)load.
chrome.storage.local.get(["hyphaConnected", "hyphaConfig"]).then((r: any) => {
  if (r.hyphaConnected && r.hyphaConfig) void connect(r.hyphaConfig);
});

// Keepalive: periodic message keeps the SW warm and signals we're alive.
setInterval(() => {
  chrome.runtime.sendMessage({ __off: "keepalive", connected: !!server }).catch(() => {});
}, 20000);
