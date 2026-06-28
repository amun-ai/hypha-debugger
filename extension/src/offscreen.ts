/**
 * Offscreen document — hosts the Hypha RPC connection(s). It has a real DOM and
 * a stable lifetime (unlike the service worker), so hypha-rpc runs here happily
 * and survives SW naps. One RelayConnector per debugged tab; each registers a
 * Hypha debug service whose calls are relayed (via the SW) to that tab's
 * content-script Agent.
 *
 * This is the realm that actually opens the WebSocket — it is the extension's
 * own context, so the debugged page's `connect-src` CSP does not apply.
 */
import * as hyphaRpc from "hypha-rpc";
import { RelayConnector } from "../../javascript/src/relay/connector.js";
import { ConnectorRuntimeChannel } from "./runtime-channel.js";

const connectors = new Map<number, RelayConnector>();

function getConnect(): (cfg: any) => Promise<any> {
  // Test/extension hook: allow overriding the transport (also useful for custom
  // Hypha clients). Undefined in normal use.
  const override = (globalThis as any).__HYPHA_CONNECT__;
  if (typeof override === "function") return override;
  const mod: any = hyphaRpc as any;
  if (mod.connectToServer) return mod.connectToServer;
  if (mod.hyphaWebsocketClient?.connectToServer)
    return mod.hyphaWebsocketClient.connectToServer;
  const w = self as any;
  if (w.hyphaWebsocketClient?.connectToServer)
    return w.hyphaWebsocketClient.connectToServer;
  throw new Error("hypha-rpc connectToServer not found");
}

function ui(tabId: number, data: any): void {
  chrome.runtime.sendMessage({ __hyphaUi: true, tabId, ...data }).catch(() => {});
}

function createConnector(tabId: number, config: any): void {
  connectors.get(tabId)?.stop();
  const channel = new ConnectorRuntimeChannel(tabId);
  const conn = new RelayConnector(
    channel,
    {
      server_url: config.server_url,
      workspace: config.workspace || undefined,
      token: config.token || undefined,
      service_id: config.service_id || undefined,
      service_name: config.service_name || undefined,
      require_token: !!config.require_token,
      connect: getConnect(),
    },
    {
      onStatus: (status, detail) => ui(tabId, { type: "status", status, detail }),
    },
  );
  connectors.set(tabId, conn);
  ui(tabId, { type: "status", status: "connecting" });
  conn.start();
}

function destroyConnector(tabId: number): void {
  connectors.get(tabId)?.stop();
  connectors.delete(tabId);
}

chrome.runtime.onMessage.addListener((msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.__hyphaCtl === "createConnector") createConnector(msg.tabId, msg.config);
  else if (msg.__hyphaCtl === "destroyConnector") destroyConnector(msg.tabId);
  // Reconnect set pushed by the SW after an offscreen (re)load.
  else if (msg.__hyphaUi && msg.__stamped && msg.type === "active" && msg.active) {
    for (const [tabId, config] of Object.entries(msg.active)) {
      if (!connectors.has(Number(tabId))) createConnector(Number(tabId), config);
    }
  }
});

// On load, ask the SW for the active connection set so we reconnect after a
// reload of this offscreen document.
chrome.runtime.sendMessage({ __hyphaCtl: "getActive" }).catch(() => {});
