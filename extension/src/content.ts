/**
 * Content script (isolated world) — the in-page Agent. Runs our full service
 * map against the real DOM and answers relay `call`s from the offscreen
 * Connector via the SW. Immune to the page's `script-src` (extension-injected)
 * and never touches the network (so the page's `connect-src` is irrelevant).
 *
 * get_react_tree needs page-world fiber expandos, so it is delegated to the
 * MAIN-world helper (main-world.js) over CustomEvents.
 */
import { RelayAgent } from "../../javascript/src/relay/agent.js";
import { AgentRuntimeChannel } from "./runtime-channel.js";

const FLAG = "__HYPHA_DEBUGGER_AGENT__";

function callMainWorldReact(selector?: string, depth?: number): Promise<any> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onResp = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.id !== id) return;
      window.removeEventListener("hypha-debugger:react-response", onResp);
      resolve(detail.result);
    };
    window.addEventListener("hypha-debugger:react-response", onResp);
    window.dispatchEvent(
      new CustomEvent("hypha-debugger:react-request", {
        detail: { id, selector, depth },
      }),
    );
    setTimeout(() => {
      window.removeEventListener("hypha-debugger:react-response", onResp);
      resolve({ error: "React bridge timed out (main-world helper not present?)" });
    }, 8000);
  });
}

function forward(type: string, data: any): void {
  try {
    chrome.runtime.sendMessage({ __hyphaUi: true, type, ...data }).catch(() => {});
  } catch {
    /* ignore */
  }
}

(function main() {
  const w = window as any;
  if (w[FLAG]) return; // guard against double injection
  w[FLAG] = true;

  const channel = new AgentRuntimeChannel();
  const agent = new RelayAgent(channel, {
    reactBridge: callMainWorldReact,
    onLog: (msg, kind) => forward("log", { msg, kind, ts: Date.now() }),
    onStatus: (status, detail) => forward("status", { status, detail }),
    onReady: (info) => forward("ready", info),
  });
  agent.start();
  forward("status", { status: "agent-ready" });
})();
