/**
 * Core debugger class: connects to Hypha and registers the debug service.
 */
import * as hyphaRpc from "hypha-rpc";
import { DebugOverlay } from "./ui/overlay.js";
import { getPageInfo, installConsoleCapture } from "./services/info.js";
import {
  queryDom,
  clickElement,
  fillInput,
  scrollTo,
  getHtml,
} from "./services/dom.js";
import { takeScreenshot } from "./services/screenshot.js";
import { executeScript } from "./services/execute.js";
import { navigate } from "./services/navigate.js";
import { getReactTree } from "./services/react.js";
import { generateSkillMd } from "./services/skill.js";

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
  /** Service visibility. Overridden by require_token when not set explicitly. */
  visibility?: "public" | "protected" | "unlisted";
  /**
   * Whether remote callers must supply a JWT token. Default: true.
   *
   * true  → visibility "protected", a 24-hour token is generated and shown
   *         in the instruction block. The URL alone is not enough.
   *
   * false → visibility "unlisted", a random 16-char hex suffix is appended
   *         to the service ID so the URL itself is unguessable. No token is
   *         needed — just keep the URL secret.
   */
  require_token?: boolean;
}

export interface DebugSession {
  /** Full service ID as registered with Hypha. */
  service_id: string;
  /** Workspace the debugger is connected to. */
  workspace: string;
  /** The Hypha server connection object. */
  server: any;
  /** HTTP base URL for calling service functions remotely. */
  service_url: string;
  /** JWT token for authenticating remote HTTP calls. */
  token: string;
  /** Disconnect and clean up. */
  destroy: () => Promise<void>;
}

/** Generate a cryptographically random hex string of `bytes` bytes. */
function randomHex(bytes = 8): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class HyphaDebugger {
  private config: Required<DebuggerConfig>;
  private overlay: DebugOverlay | null = null;
  private server: any = null;
  private serviceInfo: any = null;

  constructor(config: DebuggerConfig) {
    const requireToken = config.require_token ?? true;

    // Derive service_id: append random suffix in no-token mode unless user
    // provided an explicit custom id.
    let serviceId = config.service_id ?? "web-debugger";
    if (!requireToken && !config.service_id) {
      serviceId = `web-debugger-${randomHex(8)}`;
    }

    // Derive visibility: require_token mode → protected, no-token → unlisted.
    // An explicit config.visibility always takes precedence.
    const visibility =
      config.visibility ?? (requireToken ? "protected" : "unlisted");

    this.config = {
      server_url: config.server_url,
      workspace: config.workspace ?? "",
      token: config.token ?? "",
      service_id: serviceId,
      service_name: config.service_name ?? "Web Debugger",
      show_ui: config.show_ui ?? true,
      visibility,
      require_token: requireToken,
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

      // Register debug service
      this.serviceInfo = await this.server.registerService(
        this.buildServiceDefinition()
      );

      // Update overlay and build session
      const session = await this.updateSession();

      if (this.overlay) {
        this.overlay.addLog("Service registered", "result");
      }

      // Store globally
      w.__HYPHA_DEBUGGER__ = w.__HYPHA_DEBUGGER__ ?? {};
      w.__HYPHA_DEBUGGER__.instance = this;

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

  /**
   * Generate token, build service URL, update overlay instructions, and
   * return a DebugSession.
   */
  private async updateSession(extra?: Record<string, string>): Promise<DebugSession> {
    const fullServiceId = this.serviceInfo?.id ?? this.config.service_id;
    const serviceUrl = this.buildServiceUrl(fullServiceId);
    const workspace = this.server.config?.workspace ?? "";

    // In no-token mode the URL itself is the secret — skip token generation.
    const sessionToken = this.config.require_token
      ? await this.server.generateToken({ expires_in: 86400 })
      : "";

    if (this.overlay) {
      this.overlay.setStatus("connected");
      this.overlay.setInfo({
        Status: "Connected",
        Server: this.config.server_url,
        ...extra,
      });
      this.overlay.setInstructions(
        this.buildInstructionBlock(serviceUrl, sessionToken)
      );
    }

    console.log(`[hypha-debugger] Service URL: ${serviceUrl}`);
    if (sessionToken) {
      console.log(`[hypha-debugger] Token: ${sessionToken}`);
      console.log(
        `[hypha-debugger] Test:\n  curl '${serviceUrl}/get_page_info?_mode=last' -H 'Authorization: Bearer ${sessionToken}'`
      );
    } else {
      console.log(`[hypha-debugger] Test:\n  curl '${serviceUrl}/get_page_info?_mode=last'`);
    }

    const session: DebugSession = {
      service_id: fullServiceId,
      workspace,
      server: this.server,
      service_url: serviceUrl,
      token: sessionToken,
      destroy: () => this.destroy(),
    };

    // Always update global session
    const w = window as any;
    w.__HYPHA_DEBUGGER__ = w.__HYPHA_DEBUGGER__ ?? {};
    w.__HYPHA_DEBUGGER__.session = session;

    return session;
  }

  /**
   * Build a stable, predictable service URL.
   * Strips the clientId prefix so the URL uses only the bare service name.
   * Callers append ?_mode=last to resolve the most recent instance.
   */
  private buildServiceUrl(serviceId: string): string {
    const base = this.config.server_url.replace(/\/+$/, "");
    const slashIdx = serviceId.indexOf("/");
    if (slashIdx !== -1) {
      const workspace = serviceId.substring(0, slashIdx);
      const svcPart = serviceId.substring(slashIdx + 1);
      // Strip clientId: "abc123:web-debugger" → "web-debugger"
      const colonIdx = svcPart.indexOf(":");
      const svcName = colonIdx !== -1 ? svcPart.substring(colonIdx + 1) : svcPart;
      return `${base}/${workspace}/services/${svcName}`;
    }
    return `${base}/services/${serviceId}`;
  }

  private getHyphaModule(): any {
    // Check the static import (works when hypha-rpc is bundled or npm-installed)
    if ((hyphaRpc as any).connectToServer) return hyphaRpc;
    // hypha-rpc re-exports under a namespace
    if ((hyphaRpc as any).hyphaWebsocketClient?.connectToServer)
      return (hyphaRpc as any).hyphaWebsocketClient;
    // Fall back to global (when hypha-rpc loaded via separate script tag)
    const w = window as any;
    if (w.hyphaWebsocketClient?.connectToServer) return w.hyphaWebsocketClient;
    throw new Error(
      "hypha-rpc not found. Install it via npm or load it via: " +
        '<script src="https://cdn.jsdelivr.net/npm/hypha-rpc@0.20.97/dist/hypha-rpc-websocket.min.js"></script>'
    );
  }

  private getConnectToServer(): any {
    return this.getHyphaModule().connectToServer;
  }

  private buildServiceDefinition(): any {
    return {
      id: this.config.service_id,
      name: this.config.service_name,
      type: "debugger",
      description:
        "Remote web page debugger. Allows inspecting DOM, taking screenshots, executing JavaScript, and interacting with the page.",
      config: {
        visibility: this.config.visibility,
      },
      get_page_info: this.wrapFn(getPageInfo, "get_page_info"),
      get_html: this.wrapFn(getHtml, "get_html"),
      query_dom: this.wrapFn(queryDom, "query_dom"),
      click_element: this.wrapFn(clickElement, "click_element"),
      fill_input: this.wrapFn(fillInput, "fill_input"),
      scroll_to: this.wrapFn(scrollTo, "scroll_to"),
      take_screenshot: this.wrapFn(takeScreenshot, "take_screenshot"),
      execute_script: this.wrapFn(executeScript, "execute_script"),
      navigate: this.wrapFn(navigate, "navigate"),
      get_react_tree: this.wrapFn(getReactTree, "get_react_tree"),
      get_skill_md: this.wrapFn(this.createGetSkillMd(), "get_skill_md"),
    };
  }

  private createGetSkillMd(): any {
    const fn = () => {
      // Build a schema-only map (avoid calling buildServiceDefinition which would recurse)
      const schemaFns: Record<string, any> = {};
      const fns: Record<string, any> = {
        get_page_info: getPageInfo, get_html: getHtml,
        query_dom: queryDom, click_element: clickElement, fill_input: fillInput,
        scroll_to: scrollTo, take_screenshot: takeScreenshot,
        execute_script: executeScript, navigate: navigate,
        get_react_tree: getReactTree,
      };
      for (const [name, f] of Object.entries(fns)) {
        if ((f as any).__schema__) schemaFns[name] = f;
      }
      const serviceUrl = this.serviceInfo
        ? this.buildServiceUrl(this.serviceInfo.id ?? this.config.service_id)
        : "{SERVICE_URL}";
      return generateSkillMd(schemaFns, serviceUrl);
    };
    fn.__schema__ = {
      name: "getSkillMd",
      description:
        "Get the SKILL.md document describing all available debugger functions, their parameters, and usage examples. Follows the agentskills.io specification.",
      parameters: {
        type: "object",
        properties: {},
      },
    };
    return fn;
  }

  /** Build the instruction block for the overlay panel. */
  private buildInstructionBlock(serviceUrl: string, token: string): string {
    if (token) {
      // Token-protected mode: callers must supply the Authorization header.
      return [
        `SERVICE_URL="${serviceUrl}"`,
        `TOKEN="${token}"`,
        ``,
        `# Quick test:`,
        `curl "$SERVICE_URL/get_page_info?_mode=last" -H "Authorization: Bearer $TOKEN"`,
        ``,
        `# Full API docs:`,
        `curl "$SERVICE_URL/get_skill_md?_mode=last" -H "Authorization: Bearer $TOKEN"`,
      ].join("\n");
    } else {
      // No-token mode: the URL itself is the secret (unlisted + unguessable id).
      return [
        `SERVICE_URL="${serviceUrl}"`,
        ``,
        `# Quick test (no auth required — keep URL secret):`,
        `curl "$SERVICE_URL/get_page_info?_mode=last"`,
        ``,
        `# Full API docs:`,
        `curl "$SERVICE_URL/get_skill_md?_mode=last"`,
      ].join("\n");
    }
  }

  /** Wrap a service function with logging and kwargs-to-positional-args support. */
  private wrapFn(fn: any, name: string): any {
    const wrapped = async (...args: any[]) => {
      // Hypha's HTTP API calls with keyword arguments (**kwargs),
      // which arrive on the JS side as a single object argument.
      // Destructure into positional args based on schema properties.
      if (
        args.length === 1 &&
        args[0] &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0]) &&
        fn.__schema__?.parameters?.properties
      ) {
        const kwargs = args[0];
        const props = fn.__schema__.parameters.properties;
        const paramNames = Object.keys(props);
        // Check if any kwargs key matches a schema property name
        const hasMatchingKey = paramNames.some((p) => p in kwargs);
        if (hasMatchingKey) {
          args = paramNames.map((p) => kwargs[p]);
          while (args.length > 0 && args[args.length - 1] === undefined) {
            args.pop();
          }
        }
      }

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
    if (fn.__schema__) {
      (wrapped as any).__schema__ = fn.__schema__;
    }
    return wrapped;
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
