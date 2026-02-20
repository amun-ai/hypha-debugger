/**
 * Arbitrary JavaScript execution service.
 */

export async function executeScript(
  code: string,
  timeout_ms?: number,
): Promise<{ result: any; type: string } | { error: string }> {
  const timeoutMs = timeout_ms ?? 10000;

  try {
    const result = await Promise.race([
      // Use async Function to allow top-level await in the code
      new Function("return (async () => {" + code + "})()")(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Execution timed out")), timeoutMs)
      ),
    ]);

    // Serialize the result safely
    let serialized: any;
    let type: string = typeof result;
    try {
      if (result === undefined) {
        serialized = null;
        type = "undefined";
      } else if (result instanceof HTMLElement) {
        serialized = {
          tag: result.tagName.toLowerCase(),
          id: result.id,
          text: (result.textContent ?? "").trim().slice(0, 500),
        };
        type = "HTMLElement";
      } else if (result instanceof NodeList || result instanceof HTMLCollection) {
        serialized = Array.from(result).map((el: any) => ({
          tag: el.tagName?.toLowerCase(),
          id: el.id,
          text: (el.textContent ?? "").trim().slice(0, 200),
        }));
        type = "NodeList";
      } else {
        // Try JSON serialization, fall back to string
        serialized = JSON.parse(JSON.stringify(result));
      }
    } catch {
      serialized = String(result);
      type = "string (serialized)";
    }

    return { result: serialized, type };
  } catch (err: any) {
    return { error: `Execution error: ${err.message ?? err}` };
  }
}

executeScript.__schema__ = {
  name: "executeScript",
  description:
    "Execute arbitrary JavaScript code in the page context. Supports async/await. Returns the result of the last expression.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          'JavaScript code to execute. The result of the last expression is returned. Example: "return document.title"',
      },
      timeout_ms: {
        type: "number",
        description: "Maximum execution time in milliseconds. Default: 10000.",
      },
    },
    required: ["code"],
  },
};
