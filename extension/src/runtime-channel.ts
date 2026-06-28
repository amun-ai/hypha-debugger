/**
 * chrome.runtime implementations of the relay Channel. All traffic is hubbed
 * through the background service worker:
 *
 *   content(agent) --runtime.sendMessage--> SW --runtime.sendMessage--> offscreen(connector)
 *   offscreen(connector) --runtime.sendMessage--> SW --tabs.sendMessage--> content(agent)
 *
 * The SW stamps the tabId (from sender.tab.id) on agent→connector traffic and
 * uses tabs.sendMessage for connector→agent. Messages carry a `tabId` so the
 * offscreen doc can host one connector per tab.
 */
import type { Channel } from "../../javascript/src/relay/channel.js";
import type { RelayMsg } from "../../javascript/src/relay/protocol.js";

export const RELAY_ENVELOPE = "__hyphaRelayEnvelope";

interface Envelope {
  [RELAY_ENVELOPE]: true;
  dir: "toConnector" | "toAgent";
  tabId?: number;
  payload: RelayMsg;
}

/** Content-script (Agent) side. Posts toConnector; receives toAgent. */
export class AgentRuntimeChannel implements Channel {
  post(msg: RelayMsg): void {
    const env: Envelope = { [RELAY_ENVELOPE]: true, dir: "toConnector", payload: msg };
    try {
      chrome.runtime.sendMessage(env).catch(() => {});
    } catch {
      /* SW asleep / context gone */
    }
  }
  onMessage(cb: (msg: RelayMsg) => void): () => void {
    const handler = (m: any) => {
      if (m && m[RELAY_ENVELOPE] && m.dir === "toAgent") cb(m.payload);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }
}

/** Offscreen (Connector) side, bound to a single tab. Posts toAgent; receives toConnector. */
export class ConnectorRuntimeChannel implements Channel {
  constructor(private tabId: number) {}
  post(msg: RelayMsg): void {
    const env: Envelope = {
      [RELAY_ENVELOPE]: true,
      dir: "toAgent",
      tabId: this.tabId,
      payload: msg,
    };
    try {
      chrome.runtime.sendMessage(env).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  onMessage(cb: (msg: RelayMsg) => void): () => void {
    const handler = (m: any) => {
      if (m && m[RELAY_ENVELOPE] && m.dir === "toConnector" && m.tabId === this.tabId)
        cb(m.payload);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }
}
