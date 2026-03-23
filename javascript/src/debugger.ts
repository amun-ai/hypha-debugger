/**
 * Core debugger class: connects to Hypha and registers the debug service.
 */
import * as hyphaRpc from "hypha-rpc";
import { DebugOverlay } from "./ui/overlay.js";
import { AICursor } from "./ui/cursor.js";
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
import { navigate, installNavigationInterceptor } from "./services/navigate.js";
import { getReactTree } from "./services/react.js";
import { generateSkillMd } from "./services/skill.js";
import { wrapFn as baseWrapFn } from "./utils/wrap-fn.js";
import {
  getBrowserState,
  clickElementByIndex,
  inputText,
  selectOption,
  scroll,
  removeHighlights,
  disposeController,
} from "./services/page-controller.js";

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

/** sessionStorage key for persisting debugger config across reloads. */
const STORAGE_KEY = "__hypha_debugger_config__";

export class HyphaDebugger {
  private config: Required<DebuggerConfig>;
  private overlay: DebugOverlay | null = null;
  private cursor: AICursor | null = null;
  private server: any = null;
  private serviceInfo: any = null;
  private boundBeforeUnload: (() => void) | null = null;
  private cleanupInterceptor: (() => void) | null = null;

  constructor(config: DebuggerConfig) {
    const requireToken = config.require_token ?? false;

    // Always append random suffix unless user provided a custom id.
    let serviceId = config.service_id ?? "web-debugger";
    if (!config.service_id) {
      serviceId = `web-debugger-${randomHex(16)}`;
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
      // Initialize animated AI cursor
      this.cursor = new AICursor();
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

      try {
        this.server = await connect(connectConfig);
      } catch (connErr: any) {
        // If connecting to a saved workspace fails (e.g. expired/garbage-collected),
        // retry without the workspace to get a fresh one.
        if (this.config.workspace) {
          console.warn(
            `[hypha-debugger] Failed to rejoin workspace "${this.config.workspace}", getting a fresh one:`,
            connErr.message ?? connErr
          );
          this.server = await connect({ server_url: this.config.server_url });
        } else {
          throw connErr;
        }
      }

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

      // Persist config to sessionStorage for auto-reconnect after reload
      this.saveConfigToStorage();
      this.boundBeforeUnload = () => this.saveConfigToStorage();
      window.addEventListener("beforeunload", this.boundBeforeUnload);

      // Intercept same-origin link clicks, form submits, and popstate
      // so the debugger survives user-initiated navigation
      this.cleanupInterceptor = installNavigationInterceptor();

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
    // Remove event listeners
    if (this.boundBeforeUnload) {
      window.removeEventListener("beforeunload", this.boundBeforeUnload);
      this.boundBeforeUnload = null;
    }
    if (this.cleanupInterceptor) {
      this.cleanupInterceptor();
      this.cleanupInterceptor = null;
    }
    try {
      if (this.serviceInfo && this.server) {
        await this.server.unregisterService(this.serviceInfo.id);
      }
    } catch {
      // Ignore unregister errors on cleanup
    }
    // Clear sessionStorage config (explicit destroy = user wants to stop)
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    disposeController();
    this.cursor?.destroy();
    this.cursor = null;
    this.overlay?.destroy();
    this.overlay = null;
    const w = window as any;
    if (w.__HYPHA_DEBUGGER__) {
      delete w.__HYPHA_DEBUGGER__.instance;
      delete w.__HYPHA_DEBUGGER__.session;
    }
  }

  /**
   * Persist debugger config to sessionStorage so the debugger can
   * auto-reconnect after a page reload (soft reload injects the script,
   * autoStart() reads this config).
   */
  private saveConfigToStorage(): void {
    try {
      // Save workspace so we can rejoin the same one (keeps URL stable),
      // but never save the token — anonymous workspace tokens expire and
      // cause "Permission denied" on reconnect. For anonymous workspaces
      // no token is needed to rejoin; for authenticated workspaces the
      // user must provide a fresh token via data attributes or config.
      const data = {
        server_url: this.config.server_url,
        workspace: this.server?.config?.workspace ?? this.config.workspace,
        service_id: this.config.service_id,
        service_name: this.config.service_name,
        show_ui: this.config.show_ui,
        visibility: this.config.visibility,
        require_token: this.config.require_token,
        script_url: this.detectScriptUrl(),
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // sessionStorage might be unavailable (private browsing, full quota)
    }
  }

  /**
   * Detect the URL of the currently loaded hypha-debugger script.
   * Used by navigate.ts to inject the correct script after soft reload.
   */
  private detectScriptUrl(): string {
    try {
      const scripts = document.querySelectorAll("script[src]");
      for (const s of Array.from(scripts) as HTMLScriptElement[]) {
        if (s.src && s.src.includes("hypha-debugger")) {
          return s.src;
        }
      }
    } catch {
      // ignore
    }
    return "https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js";
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
        `[hypha-debugger] Test:\n  curl '${serviceUrl}/get_page_info' -H 'Authorization: Bearer ${sessionToken}'`
      );
    } else {
      console.log(`[hypha-debugger] Test:\n  curl '${serviceUrl}/get_page_info'`);
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
      // Smart DOM analysis + index-based interaction (from page-controller)
      get_browser_state: this.wrapFn(getBrowserState, "get_browser_state"),
      click_element_by_index: this.wrapFn(clickElementByIndex, "click_element_by_index"),
      input_text: this.wrapFn(inputText, "input_text"),
      select_option: this.wrapFn(selectOption, "select_option"),
      scroll: this.wrapFn(scroll, "scroll"),
      remove_highlights: this.wrapFn(removeHighlights, "remove_highlights"),
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
        // Smart DOM analysis + index-based interaction
        get_browser_state: getBrowserState,
        click_element_by_index: clickElementByIndex,
        input_text: inputText, select_option: selectOption,
        scroll: scroll, remove_highlights: removeHighlights,
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
    const auth = token ? ` -H "Authorization: Bearer $TOKEN"` : "";
    const lines = [
      `# Hypha Remote Debugger — Web Page`,
      `# A debugger is attached to a live web page.`,
      `# You can remotely inspect, interact with, and control this page via the HTTP API below.`,
      `#`,
      `# RECOMMENDED WORKFLOW (index-based, most reliable):`,
      `#   1. get_browser_state → see all interactive elements as [0], [1], [2], ...`,
      `#   2. click_element_by_index / input_text / select_option / scroll → act by index`,
      `#   3. take_screenshot → verify the result visually`,
      `#`,
      `# Also available: get_page_info, get_html, query_dom, click_element, fill_input,`,
      `#   scroll_to, execute_script, navigate, get_react_tree, remove_highlights`,
      `#`,
      `# POST endpoints accept JSON body with parameter names as keys.`,
      ``,
      `SERVICE_URL="${serviceUrl}"`,
    ];
    if (token) {
      lines.push(`TOKEN="${token}"`);
    }
    lines.push(
      ``,
      `# 1. Get interactive elements (smart DOM analysis with indexed elements):`,
      `curl "$SERVICE_URL/get_browser_state"${auth}`,
      ``,
      `# 2. Click element by index (e.g. click [3]):`,
      `curl -X POST "$SERVICE_URL/click_element_by_index"${auth} -H "Content-Type: application/json" -d '{"index": 3}'`,
      ``,
      `# 3. Type into an input by index:`,
      `curl -X POST "$SERVICE_URL/input_text"${auth} -H "Content-Type: application/json" -d '{"index": 5, "text": "hello"}'`,
      ``,
      `# Take a screenshot:`,
      `curl "$SERVICE_URL/take_screenshot"${auth}`,
      ``,
      `# Execute JavaScript remotely:`,
      `curl -X POST "$SERVICE_URL/execute_script"${auth} -H "Content-Type: application/json" -d '{"code": "document.title"}'`,
      ``,
      `# Full API docs:`,
      `curl "$SERVICE_URL/get_skill_md"${auth}`,
    );
    return lines.join("\n");
  }

  /**
   * Wrap a service function with overlay logging + correct parameter names.
   *
   * Adds logging around the function, then applies baseWrapFn() which uses
   * new Function() to create a wrapper with unminified parameter names from
   * __schema__. This is critical for production builds where Babel/Terser
   * minifies parameter names — hypha-rpc's getParamNames() parses
   * Function.toString() to map kwargs to positional args.
   */
  private wrapFn(fn: any, name: string): any {
    const self = this;
    const logged = async (...args: any[]) => {
      self.overlay?.addLog(`${name}(${self.summarizeArgs(args)})`, "call");
      try {
        const result = await fn(...args);
        const hasError =
          result && typeof result === "object" && "error" in result;
        if (hasError) {
          self.overlay?.addLog(`${name}: ${result.error}`, "error");
        } else {
          self.overlay?.addLog(`${name} -> OK`, "result");
        }
        return result;
      } catch (err: any) {
        self.overlay?.addLog(`${name}: ${err.message}`, "error");
        throw err;
      }
    };
    // Preserve __schema__ so baseWrapFn can read parameter names
    if (fn.__schema__) logged.__schema__ = fn.__schema__;
    return baseWrapFn(logged);
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
