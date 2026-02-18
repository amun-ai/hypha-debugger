/**
 * Core debugger class: connects to Hypha and registers the debug service.
 */
import * as hyphaRpc from "hypha-rpc";
import { DebugOverlay } from "./ui/overlay.js";
import { getPageInfo, getConsoleLogs, installConsoleCapture } from "./services/info.js";
import {
  queryDom,
  clickElement,
  fillInput,
  scrollTo,
  getComputedStyles,
  getElementBounds,
} from "./services/dom.js";
import { takeScreenshot } from "./services/screenshot.js";
import { executeScript } from "./services/execute.js";
import { navigate, goBack, goForward, reload } from "./services/navigate.js";
import { getReactTree } from "./services/react.js";

export interface DebuggerConfig {
  /** Hypha server URL. Required. */
  server_url: string;
  /** Workspace name. Auto-assigned if omitted. */
  workspace?: string;
  /** Authentication token. */
  token?: string;
  /** Service ID to register as. Default: "web-debugger" */
  service_id?: string;
  /** Service name. Default: "Web Debugger" */
  service_name?: string;
  /** Show floating debug UI overlay. Default: true */
  show_ui?: boolean;
  /** Service visibility. Default: "public" */
  visibility?: "public" | "protected" | "unlisted";
}

export interface DebugSession {
  /** Full service ID as registered with Hypha. */
  service_id: string;
  /** Workspace the debugger is connected to. */
  workspace: string;
  /** The Hypha server connection object. */
  server: any;
  /** Disconnect and clean up. */
  destroy: () => Promise<void>;
}

export class HyphaDebugger {
  private config: Required<DebuggerConfig>;
  private overlay: DebugOverlay | null = null;
  private server: any = null;
  private serviceInfo: any = null;

  constructor(config: DebuggerConfig) {
    this.config = {
      server_url: config.server_url,
      workspace: config.workspace ?? "",
      token: config.token ?? "",
      service_id: config.service_id ?? "web-debugger",
      service_name: config.service_name ?? "Web Debugger",
      show_ui: config.show_ui ?? true,
      visibility: config.visibility ?? "public",
    };
  }

  async start(): Promise<DebugSession> {
    // Install console capture early
    installConsoleCapture();

    // Guard against double-injection
    const w = window as any;
    if (w.__HYPHA_DEBUGGER__?.instance) {
      console.warn("[hypha-debugger] Already running, returning existing session.");
      return w.__HYPHA_DEBUGGER__.session;
    }

    // Show UI if enabled
    if (this.config.show_ui) {
      this.overlay = new DebugOverlay();
      this.overlay.setStatus("disconnected");
      this.overlay.setInfo({ Status: "Connecting..." });
    }

    try {
      // Get the connectToServer function
      const connect = this.getConnectToServer();

      // Connect to Hypha server
      const connectConfig: any = {
        server_url: this.config.server_url,
      };
      if (this.config.workspace) connectConfig.workspace = this.config.workspace;
      if (this.config.token) connectConfig.token = this.config.token;

      this.server = await connect(connectConfig);

      // Wrap service functions with logging
      const wrapFn = (fn: any, name: string) => {
        const wrapped = async (...args: any[]) => {
          this.overlay?.addLog(`${name}(${this.summarizeArgs(args)})`, "call");
          try {
            const result = await fn(...args);
            const hasError =
              result && typeof result === "object" && "error" in result;
            if (hasError) {
              this.overlay?.addLog(`${name}: ${result.error}`, "error");
            } else {
              this.overlay?.addLog(`${name} -> OK`, "result");
            }
            return result;
          } catch (err: any) {
            this.overlay?.addLog(`${name}: ${err.message}`, "error");
            throw err;
          }
        };
        // Preserve schema
        if (fn.__schema__) {
          (wrapped as any).__schema__ = fn.__schema__;
        }
        return wrapped;
      };

      // Register debug service
      const service: any = {
        id: this.config.service_id,
        name: this.config.service_name,
        type: "debugger",
        description:
          "Remote web page debugger. Allows inspecting DOM, taking screenshots, executing JavaScript, and interacting with the page.",
        config: {
          visibility: this.config.visibility,
        },
        // Service functions
        get_page_info: wrapFn(getPageInfo, "get_page_info"),
        get_console_logs: wrapFn(getConsoleLogs, "get_console_logs"),
        query_dom: wrapFn(queryDom, "query_dom"),
        click_element: wrapFn(clickElement, "click_element"),
        fill_input: wrapFn(fillInput, "fill_input"),
        scroll_to: wrapFn(scrollTo, "scroll_to"),
        get_computed_styles: wrapFn(getComputedStyles, "get_computed_styles"),
        get_element_bounds: wrapFn(getElementBounds, "get_element_bounds"),
        take_screenshot: wrapFn(takeScreenshot, "take_screenshot"),
        execute_script: wrapFn(executeScript, "execute_script"),
        navigate: wrapFn(navigate, "navigate"),
        go_back: wrapFn(goBack, "go_back"),
        go_forward: wrapFn(goForward, "go_forward"),
        reload: wrapFn(reload, "reload"),
        get_react_tree: wrapFn(getReactTree, "get_react_tree"),
      };

      this.serviceInfo = await this.server.registerService(service);

      // Update UI
      const workspace = this.server.config.workspace;
      if (this.overlay) {
        this.overlay.setStatus("connected");
        this.overlay.setInfo({
          Status: "Connected",
          Server: this.config.server_url,
          Workspace: workspace,
          "Service ID": this.serviceInfo.id ?? this.config.service_id,
        });
        this.overlay.addLog("Service registered", "result");
      }

      console.log(
        `[hypha-debugger] Connected to ${this.config.server_url}, workspace: ${workspace}, service: ${this.serviceInfo.id}`
      );

      // Build session object
      const session: DebugSession = {
        service_id: this.serviceInfo.id ?? this.config.service_id,
        workspace,
        server: this.server,
        destroy: () => this.destroy(),
      };

      // Store globally
      w.__HYPHA_DEBUGGER__ = w.__HYPHA_DEBUGGER__ ?? {};
      w.__HYPHA_DEBUGGER__.instance = this;
      w.__HYPHA_DEBUGGER__.session = session;

      return session;
    } catch (err: any) {
      console.error("[hypha-debugger] Failed to start:", err);
      if (this.overlay) {
        this.overlay.setStatus("error");
        this.overlay.setInfo({
          Status: "Error",
          Error: err.message ?? String(err),
        });
      }
      throw err;
    }
  }

  async destroy(): Promise<void> {
    try {
      if (this.serviceInfo && this.server) {
        await this.server.unregisterService(this.serviceInfo.id);
      }
    } catch {
      // Ignore unregister errors on cleanup
    }
    this.overlay?.destroy();
    this.overlay = null;
    const w = window as any;
    if (w.__HYPHA_DEBUGGER__) {
      delete w.__HYPHA_DEBUGGER__.instance;
      delete w.__HYPHA_DEBUGGER__.session;
    }
  }

  private getConnectToServer(): any {
    // Prefer the static import; fall back to global for UMD/script-tag usage
    const connect = (hyphaRpc as any).connectToServer;
    if (connect) return connect;
    const w = window as any;
    if (w.hyphaWebsocketClient?.connectToServer) {
      return w.hyphaWebsocketClient.connectToServer;
    }
    throw new Error(
      "hypha-rpc not found. Install it via npm or include the script tag: " +
        '<script src="https://cdn.jsdelivr.net/npm/hypha-rpc@0.20.97/dist/hypha-rpc-websocket.min.js"></script>'
    );
  }

  private summarizeArgs(args: any[]): string {
    if (args.length === 0) return "";
    return args
      .map((a) => {
        if (typeof a === "string") return a.length > 40 ? a.slice(0, 40) + "..." : a;
        if (typeof a === "object" && a !== null) return "{...}";
        return String(a);
      })
      .join(", ");
  }
}
