/**
 * Navigation service.
 */

export function navigate(
  url: string
): { success: boolean; message: string } {
  try {
    window.location.href = url;
    return { success: true, message: `Navigating to ${url}` };
  } catch (err: any) {
    return { success: false, message: `Navigation failed: ${err.message ?? err}` };
  }
}

navigate.__schema__ = {
  name: "navigate",
  description: "Navigate the browser to a new URL.",
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

export function goBack(): { success: boolean; message: string } {
  try {
    window.history.back();
    return { success: true, message: "Navigated back" };
  } catch (err: any) {
    return { success: false, message: `Back navigation failed: ${err.message ?? err}` };
  }
}

goBack.__schema__ = {
  name: "goBack",
  description: "Navigate back in browser history.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function goForward(): { success: boolean; message: string } {
  try {
    window.history.forward();
    return { success: true, message: "Navigated forward" };
  } catch (err: any) {
    return {
      success: false,
      message: `Forward navigation failed: ${err.message ?? err}`,
    };
  }
}

goForward.__schema__ = {
  name: "goForward",
  description: "Navigate forward in browser history.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function reload(): { success: boolean; message: string } {
  try {
    window.location.reload();
    return { success: true, message: "Reloading page" };
  } catch (err: any) {
    return { success: false, message: `Reload failed: ${err.message ?? err}` };
  }
}

reload.__schema__ = {
  name: "reload",
  description: "Reload the current page.",
  parameters: {
    type: "object",
    properties: {},
  },
};
