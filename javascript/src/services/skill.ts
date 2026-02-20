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
    "This skill allows you to remotely debug and interact with a web page through a set of HTTP API endpoints.",
    "",
    "## How to call functions",
    "",
    "All functions are available as HTTP endpoints. Use the service URL provided in the instructions.",
    "",
    "**GET request** (for functions with no required parameters):",
    "```",
    `curl '{SERVICE_URL}/get_page_info?_mode=last' -H 'Authorization: Bearer {TOKEN}'`,
    "```",
    "",
    "**POST request** (for functions with parameters):",
    "```",
    `curl -X POST '{SERVICE_URL}/query_dom?_mode=last' \\`,
    `  -H 'Authorization: Bearer {TOKEN}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"selector": "button"}'`,
    "```",
    "",
    "Replace `{SERVICE_URL}` and `{TOKEN}` with the actual values from the instruction block.",
    "",
    "**Note:** The `_mode=last` query parameter ensures the latest debugger instance is used,",
    "even if multiple sessions have connected to the same workspace.",
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
          `curl -X POST '{SERVICE_URL}/${name}?_mode=last' \\`
        );
        functionDocs.push(`  -H 'Authorization: Bearer {TOKEN}' \\`);
        functionDocs.push(`  -H 'Content-Type: application/json' \\`);
        functionDocs.push(`  -d '${JSON.stringify(exampleParams)}'`);
        functionDocs.push("```");
      } else {
        functionDocs.push("**Example:**");
        functionDocs.push("```bash");
        functionDocs.push(
          `curl '{SERVICE_URL}/${name}?_mode=last' -H 'Authorization: Bearer {TOKEN}'`
        );
        functionDocs.push("```");
      }
    } else {
      functionDocs.push("**Parameters:** None");
      functionDocs.push("");
      functionDocs.push("**Example:**");
      functionDocs.push("```bash");
      functionDocs.push(
        `curl '{SERVICE_URL}/${name}?_mode=last' -H 'Authorization: Bearer {TOKEN}'`
      );
      functionDocs.push("```");
    }
    functionDocs.push("");
  }

  const tips = [
    "## Tips",
    "",
    "- **Start with `get_page_info`** to understand the page structure, URL, title, and viewport.",
    "- **Use `query_dom`** with CSS selectors to find elements before clicking or filling them.",
    "- **Use `take_screenshot`** to visually verify the page state.",
    "- **Use `execute_script`** for anything not covered by the built-in functions — it runs arbitrary JavaScript.",
    "- **Use `get_page_info` with `include_logs=true`** to check for JavaScript errors or debug output.",
    "- **Use `get_react_tree`** if the page uses React — it gives you component names, props, and state.",
    "- All POST endpoints accept JSON body with the parameter names as keys.",
    "- All endpoints require the `Authorization: Bearer {TOKEN}` header.",
    "",
  ].join("\n");

  return [frontmatter, intro, functionDocs.join("\n"), tips].join("\n");
}
