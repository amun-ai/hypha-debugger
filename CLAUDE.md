# Hypha Debugger

A lightweight, injectable debugger for web pages and Python processes, powered by [Hypha](https://github.com/amun-ai/hypha) RPC infrastructure. Designed for AI agent-based web development workflows.

## Project Overview

Hypha Debugger lets you inject a debug agent into a running web page or Python process. Once injected, it connects to a Hypha server and registers an RPC service that remote clients (CLI, Python scripts, AI agents) can call to inspect, interact with, and control the target.

**No browser extension required.** Just import the module and start debugging.

### Architecture

```
┌─────────────────────────┐         ┌──────────────┐         ┌─────────────────────────┐
│  Target (Browser/Python) │ ──WS──▶ │ Hypha Server │ ◀──WS── │  Remote Client           │
│                          │         │              │         │  (CLI / Python / Agent)   │
│  - Collects env info     │         │  Routes RPC  │         │  - Calls debug functions  │
│  - Registers debug svc   │         │  messages    │         │  - Takes screenshots      │
│  - Executes remote code  │         │              │         │  - Runs arbitrary code    │
│  - Returns results       │         │              │         │  - Queries DOM/state      │
└─────────────────────────┘         └──────────────┘         └─────────────────────────┘
```

### Key Principles

- **Super easy to use**: One import + one function call to start
- **Zero dependencies on target**: No browser extensions, no special builds
- **Framework-aware**: Smart React component detection (via fiber tree), with extensibility for Vue, Svelte, etc.
- **Agent-first**: All service functions are annotated with JSON Schema for LLM/MCP tool calling
- **Bidirectional**: Remote clients can call into the target; target can push events back

## Repository Structure

```
hypha-debugger/
├── CLAUDE.md                    # This file - project context for AI assistants
├── javascript/                  # JavaScript/TypeScript package (npm)
│   ├── package.json
│   ├── tsconfig.json
│   ├── rollup.config.js         # Build: ESM + UMD + minified bundles
│   ├── src/
│   │   ├── index.ts             # Main entry: startDebugger(config)
│   │   ├── debugger.ts          # Core debugger class
│   │   ├── services/            # Service functions registered with Hypha
│   │   │   ├── dom.ts           # DOM query, manipulation, click, fill
│   │   │   ├── screenshot.ts    # Page capture via html-to-image
│   │   │   ├── execute.ts       # Arbitrary JS execution
│   │   │   ├── navigate.ts      # URL navigation, history
│   │   │   ├── react.ts         # React fiber tree inspection
│   │   │   └── info.ts          # Page metadata, env info
│   │   ├── ui/                  # Floating debug overlay (Shadow DOM)
│   │   │   ├── overlay.ts       # Draggable floating icon + panel
│   │   │   └── styles.ts        # Scoped CSS
│   │   └── utils/
│   │       ├── env.ts           # Environment detection
│   │       └── schema.ts        # Schema annotation helpers
│   ├── test/
│   └── dist/                    # Built output (ESM, UMD, minified)
├── python/                      # Python package (pip)
│   ├── pyproject.toml
│   ├── hypha_debugger/
│   │   ├── __init__.py          # Main entry: start_debugger(config)
│   │   ├── debugger.py          # Core debugger (async + sync)
│   │   ├── services/
│   │   │   ├── execute.py       # Arbitrary code execution
│   │   │   ├── inspect.py       # Object/variable inspection
│   │   │   ├── info.py          # Process metadata, env info
│   │   │   └── filesystem.py    # File system browsing (sandboxed)
│   │   └── utils/
│   │       └── env.py           # Environment detection
│   └── tests/
└── examples/
    ├── js-basic.html            # Minimal browser example
    ├── js-react-app/            # React app debugging example
    ├── py-basic.py              # Minimal Python example
    └── py-async.py              # Async Python example
```

## Part 1: JavaScript Package (`hypha-debugger`)

### Usage

```html
<!-- Via CDN (ES Module) -->
<script type="module">
  import { startDebugger } from 'https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.mjs';
  startDebugger({ server_url: 'https://hypha.aicell.io' });
</script>

<!-- Via CDN (UMD) -->
<script src="https://cdn.jsdelivr.net/npm/hypha-debugger/dist/hypha-debugger.min.js"></script>
<script>
  hyphaDebugger.startDebugger({ server_url: 'https://hypha.aicell.io' });
</script>
```

```javascript
// Via npm
import { startDebugger } from 'hypha-debugger';

const debugSession = await startDebugger({
  server_url: 'https://hypha.aicell.io',
  // workspace: 'my-workspace',  // optional, auto-assigned
  // token: 'jwt-token',         // optional
  // service_id: 'web-debugger', // default: 'web-debugger'
  // show_ui: true,              // default: true, show floating overlay
});

console.log(`Debug service registered: ${debugSession.service_id}`);
console.log(`Workspace: ${debugSession.workspace}`);
// Remote clients can now call this service
```

### Registered Service Functions

All functions are annotated with JSON Schema for LLM tool calling.

| Function | Description |
|----------|-------------|
| `get_page_info(options?)` | Returns URL, title, viewport size, user agent, performance timing, optionally console logs |
| `get_html(selector?, options?)` | Get page or element HTML content |
| `query_dom(selector, options?)` | Query elements by CSS selector. Returns tag, text, attributes, bounding rect |
| `click_element(selector)` | Click an element matching the selector |
| `fill_input(selector, value)` | Set value of an input/textarea element |
| `scroll_to(selector_or_position)` | Scroll to element or {x, y} position |
| `take_screenshot(options?)` | Capture page/element screenshot as base64 PNG (via html-to-image) |
| `execute_script(code)` | Execute arbitrary JavaScript, return result |
| `navigate(url)` | Navigate to a URL |
| `get_react_tree(selector?)` | Inspect React component tree (fiber-based) |
| `get_skill_md()` | Get full API documentation (agentskills.io spec) |

### React Integration

Access React component state without React DevTools:

```javascript
// Remote client (Python/CLI) calls:
const tree = await debugSvc.get_react_tree('#root');
// Returns: { component: 'App', props: {...}, state: {...}, children: [...] }
```

**How it works internally:**
- DOM nodes in React apps have `__reactFiber$<hash>` keys
- Find the key: `Object.keys(element).find(k => k.startsWith('__reactFiber'))`
- Traverse the fiber tree: `fiber.child`, `fiber.sibling`, `fiber.return`
- Access state: `fiber.memoizedState`, props: `fiber.memoizedProps`
- Component name: `fiber.type?.displayName || fiber.type?.name`

### Floating Debug UI

When `show_ui: true` (default), a small floating icon appears on the page:
- Built inside Shadow DOM to avoid style conflicts with the host page
- Draggable to any position
- Click to expand a panel showing:
  - Connection status (connected to Hypha / workspace ID)
  - Service ID for remote access
  - Recent remote operations log
  - Quick actions (take screenshot, dump DOM)

### Build Configuration

- **Bundler**: Rollup
- **Language**: TypeScript
- **Output formats**: ESM (`.mjs`), UMD (`.js`), Minified UMD (`.min.js`)
- **External dependency**: `hypha-rpc` (peer dependency, also bundled in UMD)
- **Screenshot library**: `html-to-image` (bundled)

### npm Package Name: `hypha-debugger`

## Part 2: Python Package (`hypha-debugger`)

### Usage

```python
# Async (recommended)
import asyncio
from hypha_debugger import start_debugger

async def main():
    session = await start_debugger(
        server_url='https://hypha.aicell.io',
        # workspace='my-workspace',  # optional
        # token='jwt-token',         # optional
        # service_id='py-debugger',  # default: 'py-debugger'
    )
    print(f"Debug service: {session.service_id}")
    print(f"Workspace: {session.workspace}")
    # Keep running to accept remote calls
    await session.serve_forever()

asyncio.run(main())
```

```python
# Sync (for scripts, notebooks, non-async code)
from hypha_debugger import start_debugger_sync

session = start_debugger_sync(server_url='https://hypha.aicell.io')
print(f"Debug service: {session.service_id}")
# Runs in background thread, main thread continues
```

### Registered Service Functions

| Function | Description |
|----------|-------------|
| `get_process_info()` | Returns PID, CWD, Python version, hostname, platform, memory usage |
| `execute_code(code, namespace?)` | Execute arbitrary Python code in the process, return result |
| `get_variable(name)` | Inspect a variable in the current namespace |
| `list_variables(filter?)` | List variables in scope |
| `get_stack_trace()` | Get current stack trace |
| `list_files(path?, pattern?)` | List files in directory (sandboxed to CWD) |
| `read_file(path, encoding?)` | Read a file (sandboxed to CWD) |
| `get_installed_packages()` | List installed pip packages |

### Async vs Sync Implementation

- **Async**: Runs in the current event loop. Service functions are `async def`.
- **Sync**: Starts a background thread with its own event loop. Service functions are regular `def`, executed in the main thread via `loop.call_soon_threadsafe` for thread safety.

### pip Package Name: `hypha-debugger`

## Hypha Integration Details

### Connecting to Hypha (reference)

**JavaScript:**
```javascript
import { connectToServer } from 'hypha-rpc';
const server = await connectToServer({ server_url: 'https://hypha.aicell.io' });
```

**Python:**
```python
from hypha_rpc import connect_to_server
server = await connect_to_server({'server_url': 'https://hypha.aicell.io'})
```

### Registering a Service with Annotations

Services must have schema-annotated functions for AI agent consumption:

**Python example:**
```python
from pydantic import Field
from hypha_rpc.utils.schema import schema_function

@schema_function
def execute_code(
    code: str = Field(..., description="Python code to execute"),
    namespace: str = Field(default="__main__", description="Namespace to execute in")
) -> str:
    """Execute Python code in the debugger process and return the result."""
    ...

await server.register_service({
    'name': 'Python Debugger',
    'id': 'py-debugger',
    'type': 'debugger',
    'description': 'Remote Python process debugger',
    'config': {'visibility': 'public'},
    'execute_code': execute_code,
})
```

**JavaScript example:**
```javascript
import { schemaFunction } from 'hypha-rpc';

const executeScript = schemaFunction(
  async (code) => { return eval(code); },
  {
    name: 'executeScript',
    description: 'Execute JavaScript code in the page context and return the result.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' }
      },
      required: ['code']
    }
  }
);

await server.registerService({
  name: 'Web Debugger',
  id: 'web-debugger',
  type: 'debugger',
  description: 'Remote web page debugger',
  config: { visibility: 'public' },
  execute_script: executeScript,
});
```

### Calling Debug Services from Remote Client

**Python client:**
```python
from hypha_rpc import connect_to_server

server = await connect_to_server({
    'server_url': 'https://hypha.aicell.io',
    'workspace': '<target-workspace>',
    'token': '<token>',
})
debugger = await server.get_service('web-debugger')
info = await debugger.get_page_info()
screenshot = await debugger.take_screenshot()
result = await debugger.execute_script('document.title')
```

**HTTP/curl (use `_mode=last` to avoid needing a clientId):**
```bash
# Get page info
curl 'https://hypha.aicell.io/<workspace>/services/web-debugger/get_page_info?_mode=last' \
  -H 'Authorization: Bearer <token>'

# Execute code
curl -X POST 'https://hypha.aicell.io/<workspace>/services/web-debugger/execute_script?_mode=last' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"code": "return document.title"}'

# Take screenshot
curl 'https://hypha.aicell.io/<workspace>/services/web-debugger/take_screenshot?_mode=last' \
  -H 'Authorization: Bearer <token>'
```

## Development

### Prerequisites

- Node.js >= 18
- Python >= 3.9
- A running Hypha server (or use `https://hypha.aicell.io`)

### JavaScript Development

```bash
cd javascript
npm install
npm run dev    # Watch mode with rollup
npm run build  # Production build
npm test       # Run tests
```

### Python Development

```bash
cd python
pip install -e ".[dev]"
pytest         # Run tests
```

### Testing with a Local Hypha Server

```bash
pip install hypha
python -m hypha.server --host=0.0.0.0 --port=9527
```

## Dependencies

### JavaScript
- `hypha-rpc` - Hypha RPC client (peer dep + bundled in UMD)
- `html-to-image` - DOM screenshot capture (bundled)

### Python
- `hypha-rpc` - Hypha RPC client
- `psutil` - Process information (optional, for enhanced process info)

## Related Projects

- **Hypha Server**: `../hypha` - The RPC server infrastructure
- **Hypha RPC**: `../hypha-rpc` - The RPC client library (Python + JS)
- Hypha docs: https://ha.amun.ai/
- hypha-rpc npm: https://www.npmjs.com/package/hypha-rpc
- hypha-rpc PyPI: https://pypi.org/project/hypha-rpc/
