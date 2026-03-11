# Hypha Debugger

A lightweight, injectable debugger for web pages and Python processes, powered by [Hypha](https://github.com/amun-ai/hypha) RPC. Designed for AI agent workflows — inject a debugger, get a URL, call it remotely.

**No browser extension required.** Just import and start.

```
┌─────────────────────────┐         ┌──────────────┐         ┌─────────────────────────┐
│  Target (Browser/Python) │ ──WS──▶ │ Hypha Server │ ◀──WS── │  Remote Client           │
│                          │         │              │         │  (curl / Python / Agent)  │
│  - Registers debug svc   │         │  Routes RPC  │         │  - Calls debug functions  │
│  - Executes remote code  │         │  messages    │         │  - Takes screenshots      │
│  - Returns results       │         │              │         │  - Queries DOM/state      │
└─────────────────────────┘         └──────────────┘         └─────────────────────────┘
```

## JavaScript (Browser)

[![npm](https://img.shields.io/npm/v/hypha-debugger)](https://www.npmjs.com/package/hypha-debugger)

Inject into any web page to enable remote DOM inspection, screenshots, JavaScript execution, and React component tree inspection.

### Quick Start

**Via CDN (easiest):**

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-rpc@0.20.97/dist/hypha-rpc-websocket.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
<script>
  hyphaDebugger.startDebugger({ server_url: 'https://hypha.aicell.io' });
</script>
```

**Via npm:**

```bash
npm install hypha-debugger hypha-rpc
```

```javascript
import { startDebugger } from 'hypha-debugger';

const session = await startDebugger({
  server_url: 'https://hypha.aicell.io',
});

console.log(session.service_url); // HTTP endpoint for remote calls
console.log(session.token);       // JWT token for authentication
```

### What You Get

After starting, the debugger prints:

```
[hypha-debugger] Connected to https://hypha.aicell.io
[hypha-debugger] Service URL: https://hypha.aicell.io/ws-xxx/services/clientId:web-debugger
[hypha-debugger] Token: eyJ...
[hypha-debugger] Test it:
  curl 'https://hypha.aicell.io/ws-xxx/services/clientId:web-debugger/get_page_info' -H 'Authorization: Bearer eyJ...'
```

A floating debug overlay (🐛) appears on the page with connection status, service URL (with copy button), and a live log of remote operations.

### Service Functions (JavaScript)

All functions are callable via the HTTP URL or Hypha RPC:

| Function | Description |
|----------|-------------|
| `get_page_info()` | URL, title, viewport size, detected frameworks, performance timing |
| `get_console_logs(level?, limit?)` | Captured console output (log/warn/error/info) |
| `query_dom(selector, limit?)` | Query elements by CSS selector — returns tag, text, attributes, bounds |
| `click_element(selector)` | Click an element |
| `fill_input(selector, value)` | Set value of input/textarea/select (works with React) |
| `scroll_to(target)` | Scroll to element (CSS selector) or position ({x, y}) |
| `get_computed_styles(selector, properties?)` | Get computed CSS styles |
| `get_element_bounds(selector)` | Get bounding rectangle and visibility |
| `take_screenshot(selector?, format?, scale?)` | Capture page/element as base64 PNG/JPEG |
| `execute_script(code, timeout_ms?)` | Execute arbitrary JavaScript, return result |
| `navigate(url)` | Navigate to URL |
| `go_back()` / `go_forward()` / `reload()` | Browser history navigation |
| `get_react_tree(selector?, max_depth?)` | Inspect React component tree (fiber-based) — names, props, state |

### Calling via curl

```bash
# Get page info
curl 'SERVICE_URL/get_page_info' -H 'Authorization: Bearer TOKEN'

# Take a screenshot
curl 'SERVICE_URL/take_screenshot' -H 'Authorization: Bearer TOKEN'

# Execute JavaScript
curl -X POST 'SERVICE_URL/execute_script' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"code": "document.title"}'

# Query DOM
curl -X POST 'SERVICE_URL/query_dom' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"selector": "button"}'

# Click a button
curl -X POST 'SERVICE_URL/click_element' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"selector": "#submit-btn"}'
```

### Calling via Python

```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    "server_url": "https://hypha.aicell.io",
    "workspace": "WORKSPACE",
    "token": "TOKEN",
})
debugger = await server.get_service("web-debugger")

info = await debugger.get_page_info()
screenshot = await debugger.take_screenshot()
result = await debugger.execute_script(code="document.title")
tree = await debugger.get_react_tree()
```

### Configuration

```javascript
await startDebugger({
  server_url: 'https://hypha.aicell.io', // Required
  workspace: 'my-workspace',              // Optional, auto-assigned
  token: 'jwt-token',                     // Optional
  service_id: 'web-debugger',             // Default: 'web-debugger'
  service_name: 'Web Debugger',           // Default: 'Web Debugger'
  show_ui: true,                          // Default: true (floating overlay)
  visibility: 'public',                   // 'public' | 'protected' | 'unlisted'
});
```

---

## Python

[![PyPI](https://img.shields.io/pypi/v/hypha-debugger)](https://pypi.org/project/hypha-debugger/)

Inject into any Python process to enable remote code execution, variable inspection, file browsing, and process monitoring.

### Quick Start

```bash
pip install hypha-debugger
```

**CLI (simplest — just run and get instructions):**

```bash
hypha-debugger
```

Or with options:

```bash
hypha-debugger --server-url https://hypha.aicell.io --service-id my-debugger
hypha-debugger --no-token  # URL-secret mode, no auth needed
python -m hypha_debugger   # alternative
```

**Async:**

```python
import asyncio
from hypha_debugger import start_debugger

async def main():
    session = await start_debugger(server_url="https://hypha.aicell.io")
    session.print_instructions()  # print instructions anytime
    await session.serve_forever()

asyncio.run(main())
```

**Sync (scripts, notebooks):**

```python
from hypha_debugger import start_debugger_sync

session = start_debugger_sync(server_url="https://hypha.aicell.io")
session.print_instructions()  # print instructions anytime
```

### What You Get

The debugger prints copy-paste instructions on startup:

```
[hypha-debugger] Connected to https://hypha.aicell.io
[hypha-debugger] Service ID: ws-xxx/clientId:py-debugger
[hypha-debugger] Service URL: https://hypha.aicell.io/ws-xxx/services/py-debugger

SERVICE_URL="https://hypha.aicell.io/ws-xxx/services/py-debugger"
TOKEN="eyJ..."

# Quick test:
curl "$SERVICE_URL/get_process_info?_mode=last" -H "Authorization: Bearer $TOKEN"

# Execute code:
curl -X POST "$SERVICE_URL/execute_code?_mode=last" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"code": "import sys; sys.version"}'
```

Call `session.print_instructions()` anytime to reprint them.

### Service Functions (Python)

| Function | Description |
|----------|-------------|
| `get_process_info()` | PID, CWD, Python version, hostname, platform, memory usage |
| `execute_code(code, namespace?)` | Execute arbitrary Python code, return stdout/stderr/result |
| `get_variable(name, namespace?)` | Inspect a variable — type, value, shape (for numpy), keys (for dicts) |
| `list_variables(namespace?, filter?)` | List variables in scope |
| `get_stack_trace()` | Stack trace of all threads |
| `list_files(path?, pattern?)` | List files in directory (sandboxed to CWD) |
| `read_file(path, max_lines?, encoding?)` | Read a file (sandboxed to CWD) |
| `get_installed_packages(filter?)` | List installed pip packages |

### Calling via curl

```bash
# Get process info
curl 'SERVICE_URL/get_process_info' -H 'Authorization: Bearer TOKEN'

# Execute Python code
curl -X POST 'SERVICE_URL/execute_code' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"code": "2 + 2"}'

# List files
curl 'SERVICE_URL/list_files' -H 'Authorization: Bearer TOKEN'

# Read a file
curl -X POST 'SERVICE_URL/read_file' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"path": "main.py"}'
```

### Calling via Python (remote client)

```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    "server_url": "https://hypha.aicell.io",
    "workspace": "WORKSPACE",
    "token": "TOKEN",
})
debugger = await server.get_service("py-debugger")

info = await debugger.get_process_info()
result = await debugger.execute_code(code="import sys; sys.version")
files = await debugger.list_files()
```

---

## How It Works

1. Your target (browser page or Python process) connects to a [Hypha server](https://github.com/amun-ai/hypha) via WebSocket
2. It registers an RPC service with schema-annotated functions
3. The debugger prints a **Service URL** and **Token**
4. Remote clients call service functions via HTTP REST or Hypha RPC WebSocket
5. All functions have JSON Schema annotations, making them compatible with LLM/AI agent tool calling

## License

MIT
