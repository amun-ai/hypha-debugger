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
# Get all interactive elements with smart DOM analysis
curl "$SERVICE_URL/get_browser_state"

# Click element by index (e.g. click [3])
curl -X POST "$SERVICE_URL/click_element_by_index" -H "Content-Type: application/json" -d '{"index": 3}'

# Type into an input by index
curl -X POST "$SERVICE_URL/input_text" -H "Content-Type: application/json" -d '{"index": 5, "text": "hello"}'

# Take a screenshot
curl "$SERVICE_URL/take_screenshot"

# Execute JavaScript remotely
curl -X POST "$SERVICE_URL/execute_script" -H "Content-Type: application/json" -d '{"code": "return document.title"}'

# Python debugger
curl "$SERVICE_URL/get_process_info"
curl -X POST "$SERVICE_URL/execute_code" -H "Content-Type: application/json" -d '{"code": "import sys; sys.version"}'

# Full API docs (both JS and Python)
curl "$SERVICE_URL/get_skill_md"
```

The URL contains a unique random ID — no token needed. Keep the URL secret.

## Smart DOM Analysis + Index-Based Interaction

The JavaScript debugger includes a smart DOM analysis engine that detects interactive elements using multiple heuristics (CSS cursor, ARIA roles, event listeners, HTML tags, contenteditable, scrollable containers). Elements are indexed as `[0]`, `[1]`, `[2]`, ... for reliable AI agent interaction.

**Recommended workflow:**
1. `get_browser_state` → see all interactive elements with indices
2. `click_element_by_index` / `input_text` / `select_option` / `scroll` → act by index
3. `take_screenshot` → verify the result visually

**Visual effects** (visible to end users watching the page):
- Animated AI cursor with gradient border that moves smoothly to target elements
- Click ripple animation
- Colored highlight boxes with number labels on interactive elements
- Smooth scrolling to elements before interaction

## Library Usage

Import individual functions for use in your own projects:

```typescript
import {
  // DOM analysis + index-based interaction
  getBrowserState, clickElementByIndex, inputText, selectOption,
  scroll, removeHighlights,
  // Classic CSS selector-based functions
  getPageInfo, queryDom, clickElement, fillInput, scrollTo, getHtml,
  getComputedStyles, getElementBounds,
  // Capture + execution
  takeScreenshot, executeScript,
  // Navigation
  navigate, goBack, goForward, reload,
  // React inspection
  getReactTree,
  // Utilities
  wrapFn, generateSkillMd, installConsoleCapture,
  // Classes
  PageController, AICursor, HyphaDebugger, startDebugger,
} from 'hypha-debugger';

// wrapFn fixes minification issues — use it when registering
// functions with hypha-rpc in production builds (Babel/Terser)
const wrappedFn = wrapFn(mySchemaAnnotatedFunction);
```

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

### JavaScript — Index-Based (recommended)

| Function | Description |
|----------|-------------|
| `get_browser_state` | Smart DOM snapshot with indexed interactive elements |
| `click_element_by_index` | Click element by index with visual cursor animation |
| `input_text` | Type into input/textarea/contenteditable by index |
| `select_option` | Select dropdown option by index |
| `scroll` | Scroll page or element (vertical/horizontal) |
| `remove_highlights` | Clear visual highlight overlays |

### JavaScript — CSS Selector-Based

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
| `list_files` | List directory contents |
| `read_file` | Read a file |
| `write_file` | Write/append to a file |
| `get_variable` | Inspect a variable |
| `list_variables` | List variables in scope |
| `get_stack_trace` | Stack traces of all threads |
| `get_installed_packages` | List pip packages |
| `get_source` | Get debugger source code |
| `get_skill_md` | Full API documentation |

Call `get_skill_md` from either debugger for complete API reference with parameters and examples.

</details>

## Acknowledgments

The smart DOM analysis and interaction engine in the JavaScript package is derived from [PageAgent](https://github.com/alibaba/page-agent) (MIT License), which in turn builds upon [browser-use](https://github.com/browser-use/browser-use).

> **PageAgent** — https://github.com/alibaba/page-agent
> Copyright (c) Alibaba Group
> Licensed under the MIT License
>
> **Browser Use** — https://github.com/browser-use/browser-use
> Copyright (c) 2024 Gregor Zunic
> Licensed under the MIT License

We gratefully acknowledge both projects and their contributors for their excellent work on web automation and DOM interaction patterns that made this possible.

## License

MIT
