# Hypha Debugger

Remote debugger for web pages and Python processes — designed for AI agents. Inject it into any running target, then control it remotely via HTTP.

## JavaScript — Bookmarklet (any page, no install)

Create a bookmark with this URL to inject the debugger into **any web page**:

```
javascript:void(function(){if(window.__HYPHA_DEBUGGER__?.instance)return alert('Debugger already running');var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js';document.head.appendChild(s)})()
```

Click the bookmarklet → a floating bug icon appears → click it to copy the service URL → paste into your AI agent.

## Python — One command

```bash
pip install hypha-debugger
hypha-debugger
```

Prints a service URL and instructions. Paste them into your AI agent.

## Remote Control

Use the service URL to call functions via HTTP:

```bash
# JavaScript
curl "$SERVICE_URL/get_page_info"
curl "$SERVICE_URL/take_screenshot"
curl -X POST "$SERVICE_URL/execute_script" -H "Content-Type: application/json" -d '{"code": "return document.title"}'

# Python
curl "$SERVICE_URL/get_process_info"
curl -X POST "$SERVICE_URL/execute_code" -H "Content-Type: application/json" -d '{"code": "import sys; sys.version"}'

# Full API docs (both JS and Python)
curl "$SERVICE_URL/get_skill_md"
```

The URL contains a unique random ID — no token needed. Keep the URL secret.

---

<details>
<summary><strong>More ways to use (script tag, programmatic, config options)</strong></summary>

### Script tag

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
```

Auto-connects and shows a floating bug icon. Click it to see the service URL.

### With data attributes

```html
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"
  data-server-url="https://hypha.aicell.io"
  data-workspace="MY_WORKSPACE"
  data-token="MY_TOKEN"></script>
```

| Attribute | Description | Default |
|-----------|-------------|---------|
| `data-server-url` | Hypha server URL | `https://hypha.aicell.io` |
| `data-token` | Authentication token | (anonymous) |
| `data-workspace` | Workspace name | (auto-assigned) |
| `data-service-id` | Service ID | `web-debugger-<random>` |
| `data-no-ui` | Hide floating overlay | (shown) |
| `data-require-token` | Require token for callers | (not required) |

### Programmatic (JavaScript)

```javascript
import { startDebugger } from 'hypha-debugger';
const session = await startDebugger({ server_url: 'https://hypha.aicell.io' });
console.log(session.service_url);
```

### Programmatic (Python)

```python
# Async
from hypha_debugger import start_debugger
session = await start_debugger(server_url='https://hypha.aicell.io')
session.print_instructions()

# Sync
from hypha_debugger import start_debugger_sync
session = start_debugger_sync(server_url='https://hypha.aicell.io')
```

</details>

<details>
<summary><strong>Available functions</strong></summary>

### JavaScript

| Function | Description |
|----------|-------------|
| `get_page_info` | URL, title, viewport, user agent, console logs |
| `get_html` | Page or element HTML content |
| `query_dom` | Query elements by CSS selector |
| `click_element` | Click an element |
| `fill_input` | Set input/textarea/select value (React-compatible) |
| `scroll_to` | Scroll to element or position |
| `take_screenshot` | Capture as base64 PNG/JPEG |
| `execute_script` | Run arbitrary JavaScript |
| `navigate` | Navigate to URL |
| `get_react_tree` | Inspect React component tree |
| `get_skill_md` | Full API documentation |

### Python

| Function | Description |
|----------|-------------|
| `execute_code` | Run Python code (persistent REPL, auto-captures last expression) |
| `get_process_info` | PID, CWD, Python version, platform, memory |
| `list_files` | List directory contents (sandboxed to CWD) |
| `read_file` | Read a file (sandboxed) |
| `write_file` | Write/append to a file (sandboxed) |
| `get_variable` | Inspect a variable |
| `list_variables` | List variables in scope |
| `get_stack_trace` | Stack traces of all threads |
| `get_installed_packages` | List pip packages |
| `get_source` | Get debugger source code |
| `get_skill_md` | Full API documentation |

Call `get_skill_md` from either debugger for complete API reference with parameters and examples.

</details>

## License

MIT
