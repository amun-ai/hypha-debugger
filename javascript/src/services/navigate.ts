/**
 * Navigation service with auto-reconnect support.
 *
 * For agent-triggered reload() and same-origin navigate(), we use a "soft"
 * approach: fetch the target HTML, inject the debugger <script> tag, then
 * replace the document via document.write(). The injected script auto-starts
 * from sessionStorage config, so the debugger reconnects with the same
 * workspace and service ID. The agent's URL stays stable.
 *
 * For cross-origin navigate(), goBack(), and goForward(), we fall back to
 * normal navigation. The debugger config is saved to sessionStorage so
 * re-clicking the bookmarklet reconnects seamlessly.
 */

const STORAGE_KEY = "__hypha_debugger_config__";

/** Read the saved script URL from sessionStorage, or fall back to CDN. */
function getScriptUrl(): string {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const config = JSON.parse(raw);
      if (config.script_url) return config.script_url;
    }
  } catch {
    // ignore
  }
  return "https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js";
}

/**
 * Inject the debugger loader script into HTML before </body> (or append).
 * Also injects a tiny inline script that reads sessionStorage and passes
 * config to the debugger via a global, so autoStart() picks it up.
 */
function injectLoader(html: string, scriptUrl: string): string {
  const loader = `<script src="${scriptUrl}"><\/script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", loader + "\n</body>");
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", loader + "\n</html>");
  }
  return html + "\n" + loader;
}

/**
 * Perform a soft page replacement: fetch HTML, inject debugger script,
 * replace the document. Returns false if it can't be done (caller should
 * fall back to hard navigation).
 */
function softReplace(url: string, pushState?: string): void {
  const scriptUrl = getScriptUrl();

  fetch(url, { credentials: "same-origin", cache: "reload" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        throw new Error("Not HTML");
      }
      return response.text();
    })
    .then((html) => {
      const modified = injectLoader(html, scriptUrl);
      document.open();
      document.write(modified);
      document.close();
      if (pushState) {
        try {
          history.pushState({}, "", pushState);
        } catch {
          // ignore — URL might already match
        }
      }
    })
    .catch(() => {
      // Soft replace failed — fall back to hard navigation
      if (pushState) {
        window.location.href = pushState;
      } else {
        window.location.reload();
      }
    });
}

// ── navigate ──────────────────────────────────────────────────────────

export function navigate(
  url: string
): { success: boolean; message: string } {
  try {
    const targetUrl = new URL(url, location.href);
    const sameOrigin = targetUrl.origin === location.origin;

    if (sameOrigin) {
      // Soft navigate: fetch + inject + document.write, then pushState
      // Schedule after RPC response is sent
      setTimeout(() => softReplace(targetUrl.href, targetUrl.href), 150);
      return {
        success: true,
        message: `Navigating to ${url} (debugger will auto-reconnect)`,
      };
    } else {
      // Cross-origin: can't soft navigate, fall back to hard
      window.location.href = url;
      return {
        success: true,
        message: `Navigating to ${url} (cross-origin, debugger will disconnect)`,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Navigation failed: ${err.message ?? err}`,
    };
  }
}

navigate.__schema__ = {
  name: "navigate",
  description:
    "Navigate the browser to a new URL. For same-origin URLs, the debugger auto-reconnects. Cross-origin navigation will disconnect the debugger.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to navigate to.",
      },
    },
    required: ["url"],
  },
};

// ── goBack / goForward ───────────────────────────────────────────────

export function goBack(): { success: boolean; message: string } {
  try {
    window.history.back();
    return {
      success: true,
      message: "Navigated back (re-click bookmarklet to reconnect if needed)",
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Back navigation failed: ${err.message ?? err}`,
    };
  }
}

goBack.__schema__ = {
  name: "goBack",
  description:
    "Navigate back in browser history. The debugger may disconnect — re-click the bookmarklet to reconnect.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function goForward(): { success: boolean; message: string } {
  try {
    window.history.forward();
    return {
      success: true,
      message: "Navigated forward (re-click bookmarklet to reconnect if needed)",
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Forward navigation failed: ${err.message ?? err}`,
    };
  }
}

goForward.__schema__ = {
  name: "goForward",
  description:
    "Navigate forward in browser history. The debugger may disconnect — re-click the bookmarklet to reconnect.",
  parameters: {
    type: "object",
    properties: {},
  },
};

// ── reload ───────────────────────────────────────────────────────────

export function reload(): { success: boolean; message: string } {
  try {
    // Schedule soft reload after RPC response is sent
    setTimeout(() => softReplace(location.href), 150);
    return {
      success: true,
      message: "Reloading page (debugger will auto-reconnect)",
    };
  } catch (err: any) {
    return { success: false, message: `Reload failed: ${err.message ?? err}` };
  }
}

reload.__schema__ = {
  name: "reload",
  description:
    "Reload the current page. The debugger auto-reconnects after reload using soft page replacement.",
  parameters: {
    type: "object",
    properties: {},
  },
};
