/**
 * hypha-debugger - Injectable debugger for web pages, powered by Hypha RPC.
 *
 * Simplest usage (just include the script tag, auto-starts):
 *   <script src="https://cdn.jsdelivr.net/npm/hypha-rpc@0.20.97/dist/hypha-rpc-websocket.min.js"></script>
 *   <script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
 *
 * With config via data attributes:
 *   <script src="..." data-server-url="https://hypha.aicell.io" data-service-id="my-debugger"></script>
 *
 * Programmatic usage:
 *   import { startDebugger } from 'hypha-debugger';
 *   const session = await startDebugger({ server_url: 'https://hypha.aicell.io' });
 */

export { HyphaDebugger } from "./debugger.js";
export type { DebuggerConfig, DebugSession } from "./debugger.js";
export type { PageInfo } from "./utils/env.js";

import { HyphaDebugger, type DebuggerConfig, type DebugSession } from "./debugger.js";

/**
 * Start the Hypha debugger. Connects to a Hypha server and registers
 * a debug service that remote clients can use to inspect and interact
 * with this web page.
 */
export async function startDebugger(config: DebuggerConfig): Promise<DebugSession> {
  const debugger_ = new HyphaDebugger(config);
  return debugger_.start();
}

/**
 * Auto-start: when loaded via <script> tag, automatically start the debugger.
 * Configuration can be provided via data-* attributes on the script tag:
 *   data-server-url, data-workspace, data-token, data-service-id, data-no-ui
 *
 * Set data-manual to disable auto-start.
 */
function autoStart(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // Find our own script tag
  const scripts = document.querySelectorAll("script[src]");
  let scriptEl: HTMLScriptElement | null = null;
  for (const s of Array.from(scripts) as HTMLScriptElement[]) {
    if (s.src && s.src.includes("hypha-debugger")) {
      scriptEl = s;
      break;
    }
  }

  // Skip if data-manual is set
  if (scriptEl?.hasAttribute("data-manual")) return;

  // Skip if already started
  if ((window as any).__HYPHA_DEBUGGER__?.instance) return;

  const serverUrl =
    scriptEl?.getAttribute("data-server-url") ?? "https://hypha.aicell.io";

  const config: DebuggerConfig = {
    server_url: serverUrl,
  };

  if (scriptEl?.getAttribute("data-workspace")) {
    config.workspace = scriptEl.getAttribute("data-workspace")!;
  }
  if (scriptEl?.getAttribute("data-token")) {
    config.token = scriptEl.getAttribute("data-token")!;
  }
  if (scriptEl?.getAttribute("data-service-id")) {
    config.service_id = scriptEl.getAttribute("data-service-id")!;
  }
  if (scriptEl?.hasAttribute("data-no-ui")) {
    config.show_ui = false;
  }

  startDebugger(config).catch((err) => {
    console.error("[hypha-debugger] Auto-start failed:", err);
  });
}

// Run auto-start after DOM is ready
if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoStart);
  } else {
    autoStart();
  }
}
