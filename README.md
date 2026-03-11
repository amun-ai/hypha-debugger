# Hypha Debugger

Remote debugger for web pages and Python processes. Inject it into any running target and control it remotely via HTTP API — designed for AI agents.

No browser extension needed. One script tag or one function call to start.

## Quick Start (JavaScript)

Add one script tag to any HTML page:

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
```

That's it. The debugger auto-connects to `https://hypha.aicell.io` and shows a floating bug icon. Click it to see the service URL, token, and instructions.

### Two modes of operation

**Manual mode** — a human opens the page, clicks the floating bug icon, and copies the service URL and token:

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
```

**Agent mode** — an AI agent embeds its token and workspace directly, so the service URL is fully predictable:

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"
  data-server-url="https://hypha.aicell.io"
  data-token="YOUR_TOKEN"
  data-workspace="YOUR_WORKSPACE"></script>
```

When the agent knows the workspace and service ID, the service URL is:
```
https://hypha.aicell.io/{workspace}/services/web-debugger/{function}?_mode=last
```

### Configure via data attributes

| Attribute | Description | Default |
|-----------|-------------|---------|
| `data-server-url` | Hypha server URL | `https://hypha.aicell.io` |
| `data-token` | Authentication token | (anonymous) |
| `data-workspace` | Workspace name | (auto-assigned) |
| `data-service-id` | Service ID | `web-debugger` |
| `data-no-ui` | Hide the floating overlay | (shown) |
| `data-manual` | Disable auto-start | (auto-starts) |

### Programmatic usage

```javascript
import { startDebugger } from 'hypha-debugger';

const session = await startDebugger({
  server_url: 'https://hypha.aicell.io',
  token: 'YOUR_TOKEN',        // optional
  workspace: 'YOUR_WORKSPACE', // optional
});
console.log(session.service_url, session.token);
```

## Quick Start (Python)

```bash
pip install hypha-debugger
```

### CLI (simplest)

```bash
# Start a debugger session and print instructions
hypha-debugger

# Or with options
hypha-debugger --server-url https://hypha.aicell.io --service-id my-debugger

# No-token mode (URL-secret, no auth needed)
hypha-debugger --no-token
```

You can also run it as a module:

```bash
python -m hypha_debugger
```

### Sync (scripts, notebooks)

```python
from hypha_debugger import start_debugger_sync

session = start_debugger_sync(server_url='https://hypha.aicell.io')
# Prints instructions automatically, or print them again:
session.print_instructions()
```

### Async

```python
import asyncio
from hypha_debugger import start_debugger

async def main():
    session = await start_debugger(server_url='https://hypha.aicell.io')
    session.print_instructions()  # print instructions anytime
    await session.serve_forever()

asyncio.run(main())
```

## Remote Control via HTTP

Once the debugger is running, call its functions via curl. Always append `?_mode=last` to ensure you hit the most recent debugger instance:

```bash
# Get page info (optionally with console logs)
curl "$SERVICE_URL/get_page_info?_mode=last" -H "Authorization: Bearer $TOKEN"

# Get page HTML
curl "$SERVICE_URL/get_html?_mode=last" -H "Authorization: Bearer $TOKEN"

# Query DOM elements (JS only)
curl -X POST "$SERVICE_URL/query_dom?_mode=last" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "button"}'

# Take a screenshot (JS only)
curl "$SERVICE_URL/take_screenshot?_mode=last" -H "Authorization: Bearer $TOKEN"

# Execute code
curl -X POST "$SERVICE_URL/execute_script?_mode=last" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code": "return document.title"}'

# Get full API docs (auto-generated from schemas)
curl "$SERVICE_URL/get_skill_md?_mode=last" -H "Authorization: Bearer $TOKEN"
```

The `_mode=last` parameter tells Hypha to always route to the most recently registered service instance, even if stale sessions exist in the workspace.

## Available Functions

### JavaScript

| Function | Description |
|----------|-------------|
| `get_page_info` | URL, title, viewport, user agent, console logs, performance timing |
| `get_html` | Get page or element HTML content |
| `query_dom` | Query elements by CSS selector |
| `click_element` | Click an element |
| `fill_input` | Set input/textarea/select value (React-compatible) |
| `scroll_to` | Scroll to element or position |
| `take_screenshot` | Capture page/element as base64 PNG/JPEG |
| `execute_script` | Run arbitrary JavaScript |
| `navigate` | Navigate to URL |
| `get_react_tree` | Inspect React component tree, props, and state |
| `get_skill_md` | Get full API documentation |

### Python

| Function | Description |
|----------|-------------|
| `get_process_info` | PID, CWD, Python version, platform, memory |
| `execute_code` | Run arbitrary Python code |
| `get_variable` | Inspect a variable |
| `list_variables` | List variables in scope |
| `get_stack_trace` | Current stack trace |
| `list_files` | List directory contents (sandboxed) |
| `read_file` | Read a file (sandboxed) |
| `get_installed_packages` | List pip packages |

## For AI Agents

Call `get_skill_md` to get a complete API reference with parameter details and curl examples. The response follows the [agentskills.io](https://agentskills.io) specification.

The floating overlay includes a copyable instruction block with the service URL, token, and a pointer to `get_skill_md` for full docs.

## License

MIT
