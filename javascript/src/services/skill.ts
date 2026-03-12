/**
 * Dynamic SKILL.md generation following the agentskills.io specification.
 * Generates documentation from registered service function schemas.
 */

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

interface FunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, SchemaProperty>;
    required?: string[];
  };
}

/**
 * Generate a SKILL.md document from a service definition.
 * Excludes credentials (service URL, token) — those are provided separately.
 */
export function generateSkillMd(
  serviceFunctions: Record<string, { __schema__?: FunctionSchema }>,
  serviceUrl: string
): string {
  const frontmatter = [
    "---",
    "name: web-debugger",
    "description: Remote web page debugger. Inspect DOM, take screenshots, execute JavaScript, fill forms, click elements, and navigate pages — all via HTTP API calls.",
    "compatibility: Requires network access to the Hypha server. Works with any HTTP client (curl, fetch, Python requests).",
    "metadata:",
    '  version: "0.1"',
    '  author: "hypha-debugger"',
    "---",
  ].join("\n");

  const intro = [
    "",
    "# Web Debugger Skill",
    "",
    "This skill allows you to remotely debug and interact with a web page through HTTP API endpoints.",
    "",
    "## Recommended Workflow (Index-Based Interaction)",
    "",
    "The most reliable way to interact with a page is using the smart DOM analysis:",
    "",
    "### Step 1: Observe the page",
    "```bash",
    `curl '{SERVICE_URL}/get_browser_state'`,
    "```",
    "This returns all interactive elements indexed as `[0]`, `[1]`, `[2]`, etc.",
    "Elements are detected via smart heuristics: CSS cursor, ARIA roles, event listeners, tag names.",
    "Visual highlight labels are overlaid on the page for each detected element.",
    "",
    "Example output:",
    "```",
    "[0]<a aria-label=Home>Home />",
    "[1]<input placeholder=Search... />",
    "[2]<button>Sign In />",
    "[3]<select name=language>English />",
    "[4]<div data-scrollable=\"top=200, bottom=1500\">Content area />",
    "```",
    "",
    "### Step 2: Act on elements by index",
    "```bash",
    "# Click a button (e.g. [2] Sign In):",
    `curl -X POST '{SERVICE_URL}/click_element_by_index' \\`,
    `  -H 'Content-Type: application/json' -d '{"index": 2}'`,
    "",
    "# Type into an input (e.g. [1] Search):",
    `curl -X POST '{SERVICE_URL}/input_text' \\`,
    `  -H 'Content-Type: application/json' -d '{"index": 1, "text": "hello world"}'`,
    "",
    "# Select a dropdown option (e.g. [3] Language):",
    `curl -X POST '{SERVICE_URL}/select_option' \\`,
    `  -H 'Content-Type: application/json' -d '{"index": 3, "option_text": "French"}'`,
    "",
    "# Scroll down:",
    `curl -X POST '{SERVICE_URL}/scroll' \\`,
    `  -H 'Content-Type: application/json' -d '{"direction": "down"}'`,
    "",
    "# Scroll a specific container (e.g. [4]):",
    `curl -X POST '{SERVICE_URL}/scroll' \\`,
    `  -H 'Content-Type: application/json' -d '{"direction": "down", "index": 4}'`,
    "```",
    "",
    "### Step 3: Verify",
    "```bash",
    `curl '{SERVICE_URL}/take_screenshot'`,
    "```",
    "",
    "### Remove visual highlights (optional, for clean screenshots)",
    "```bash",
    `curl '{SERVICE_URL}/remove_highlights'`,
    "```",
    "",
    "## CSS Selector-Based Functions (Alternative)",
    "",
    "You can also use CSS selectors directly for precise targeting:",
    "```bash",
    `curl -X POST '{SERVICE_URL}/click_element' \\`,
    `  -H 'Content-Type: application/json' -d '{"selector": "button.submit"}'`,
    "",
    `curl -X POST '{SERVICE_URL}/fill_input' \\`,
    `  -H 'Content-Type: application/json' -d '{"selector": "#email", "value": "user@example.com"}'`,
    "```",
    "",
    "## How to call functions",
    "",
    "All functions are available as HTTP endpoints. Replace `{SERVICE_URL}` with the actual service URL.",
    "",
    "- **GET** for functions with no required parameters",
    "- **POST** with JSON body for functions with parameters",
    "",
  ].join("\n");

  // Build the function reference
  const functionDocs: string[] = ["## Available Functions", ""];

  const entries = Object.entries(serviceFunctions).filter(
    ([name, fn]) => fn?.__schema__ && name !== "get_skill_md"
  );

  for (const [name, fn] of entries) {
    const schema = fn.__schema__!;
    functionDocs.push(`### \`${name}\``);
    functionDocs.push("");
    functionDocs.push(schema.description);
    functionDocs.push("");

    const props = schema.parameters?.properties;
    const required = schema.parameters?.required ?? [];

    if (props && Object.keys(props).length > 0) {
      functionDocs.push("**Parameters:**");
      functionDocs.push("");
      functionDocs.push("| Parameter | Type | Required | Description |");
      functionDocs.push("|-----------|------|----------|-------------|");
      for (const [param, info] of Object.entries(props)) {
        const isRequired = required.includes(param);
        let typeStr = info.type ?? "any";
        if (info.enum) typeStr = info.enum.map((e) => `"${e}"`).join(" | ");
        if (info.items) typeStr = `${info.items.type}[]`;
        functionDocs.push(
          `| \`${param}\` | ${typeStr} | ${isRequired ? "Yes" : "No"} | ${info.description ?? ""} |`
        );
      }
      functionDocs.push("");

      // Example curl
      if (required.length > 0) {
        const exampleParams: Record<string, string> = {};
        for (const p of required) {
          const info = props[p];
          if (info?.type === "string") exampleParams[p] = `<${p}>`;
          else if (info?.type === "number") exampleParams[p] = "0" as any;
          else exampleParams[p] = `<${p}>` as any;
        }
        functionDocs.push("**Example:**");
        functionDocs.push("```bash");
        functionDocs.push(
          `curl -X POST '{SERVICE_URL}/${name}' \\`
        );
        functionDocs.push(`  -H 'Content-Type: application/json' \\`);
        functionDocs.push(`  -d '${JSON.stringify(exampleParams)}'`);
        functionDocs.push("```");
      } else {
        functionDocs.push("**Example:**");
        functionDocs.push("```bash");
        functionDocs.push(
          `curl '{SERVICE_URL}/${name}'`
        );
        functionDocs.push("```");
      }
    } else {
      functionDocs.push("**Parameters:** None");
      functionDocs.push("");
      functionDocs.push("**Example:**");
      functionDocs.push("```bash");
      functionDocs.push(
        `curl '{SERVICE_URL}/${name}'`
      );
      functionDocs.push("```");
    }
    functionDocs.push("");
  }

  const tips = [
    "## Tips",
    "",
    "- **Start with `get_browser_state`** — it's the best way to understand what's on the page and what you can interact with.",
    "- **Prefer index-based interaction** (`click_element_by_index`, `input_text`, `select_option`) over CSS selectors — indices are more reliable across dynamic pages.",
    "- **After each action, call `get_browser_state` again** — element indices change when the DOM updates.",
    "- **Use `take_screenshot`** to visually verify the page state. Call `remove_highlights` first for a clean view.",
    "- **Use `execute_script`** for anything not covered by the built-in functions — it runs arbitrary JavaScript.",
    "- **Use `scroll`** with an element index to scroll inside a specific container (e.g. a chat window, sidebar).",
    "- **Use `get_page_info` with `include_logs=true`** to check for JavaScript errors or debug output.",
    "- **Use `get_react_tree`** if the page uses React — it gives you component names, props, and state.",
    "- All POST endpoints accept JSON body with the parameter names as keys.",
    "",
  ].join("\n");

  return [frontmatter, intro, functionDocs.join("\n"), tips].join("\n");
}
