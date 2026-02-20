"""
E2E Test: Serve a static web app via Hypha ASGI proxy with the JS debugger injected.

Usage:
    pip install hypha-rpc fastapi
    python examples/e2e-test.py --token YOUR_TOKEN --workspace YOUR_WORKSPACE

This will:
1. Connect to hypha.aicell.io with the provided token/workspace
2. Register a FastAPI app as an ASGI service
3. The page auto-starts the hypha-debugger with the same token/workspace
4. Since the workspace and service_id are known, the service URL is predictable
"""

import argparse
import asyncio
from hypha_rpc import connect_to_server
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, Response

from pathlib import Path

app = FastAPI()

# Read the local built JS file for testing
JS_DIR = Path(__file__).parent.parent / "javascript" / "dist"

# Will be filled in by main()
PAGE_CONFIG = {
    "server_url": "https://hypha.aicell.io",
    "token": "",
    "workspace": "",
}

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hypha Debugger - E2E Test</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 700px; margin: 40px auto; padding: 0 20px; color: #333;
      line-height: 1.6;
    }}
    h1 {{ color: #2c3e50; margin-bottom: 8px; }}
    h2 {{ color: #34495e; margin: 20px 0 10px; font-size: 18px; }}
    p.subtitle {{ color: #7f8c8d; margin-bottom: 24px; }}
    .card {{
      background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;
      padding: 20px; margin: 16px 0;
    }}
    button {{
      background: #4a90d9; color: white; border: none; padding: 8px 16px;
      border-radius: 4px; cursor: pointer; margin: 4px; font-size: 14px;
    }}
    button:hover {{ background: #357abd; }}
    button.danger {{ background: #e74c3c; }}
    button.danger:hover {{ background: #c0392b; }}
    button.success {{ background: #27ae60; }}
    button.success:hover {{ background: #219a52; }}
    input, textarea, select {{
      padding: 8px; border: 1px solid #ccc; border-radius: 4px;
      margin: 4px; font-size: 14px;
    }}
    input {{ width: 200px; }}
    textarea {{ width: 100%; height: 60px; resize: vertical; }}
    select {{ width: 120px; }}
    #output {{
      background: #1e1e2e; color: #a6e3a1; padding: 12px; border-radius: 4px;
      font-family: monospace; font-size: 13px; white-space: pre-wrap;
      min-height: 40px; margin-top: 8px;
    }}
    .todo-item {{
      display: flex; align-items: center; gap: 8px; padding: 6px 0;
      border-bottom: 1px solid #eee;
    }}
    .todo-item input[type="checkbox"] {{ width: auto; }}
    .todo-item.done span {{ text-decoration: line-through; color: #999; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 8px; }}
    th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 13px; }}
    th {{ color: #666; font-weight: 600; }}
  </style>
</head>
<body>
  <h1>Hypha Debugger E2E Test</h1>
  <p class="subtitle">This page is served via Hypha ASGI proxy. The debugger auto-connects on load.</p>

  <div class="card">
    <h2>Form Elements</h2>
    <div>
      <input type="text" id="name-input" placeholder="Your name" data-testid="name">
      <input type="email" id="email-input" placeholder="Email" data-testid="email">
      <select id="role-select" data-testid="role">
        <option value="dev">Developer</option>
        <option value="designer">Designer</option>
        <option value="pm">PM</option>
      </select>
      <button id="greet-btn" onclick="greet()">Greet</button>
    </div>
    <textarea id="notes" placeholder="Notes..." data-testid="notes"></textarea>
  </div>

  <div class="card">
    <h2>Counter</h2>
    <button class="danger" onclick="changeCount(-1)">-</button>
    <span id="count" style="font-size:24px; font-weight:bold; margin:0 16px;">0</span>
    <button class="success" onclick="changeCount(1)">+</button>
  </div>

  <div class="card">
    <h2>Todo List</h2>
    <div style="display:flex; gap:4px;">
      <input type="text" id="todo-input" placeholder="Add a task..." style="flex:1">
      <button onclick="addTodo()">Add</button>
    </div>
    <div id="todo-list" style="margin-top:8px;"></div>
  </div>

  <div class="card">
    <h2>Data Table</h2>
    <table id="data-table">
      <thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td>Engineer</td><td>Active</td></tr>
        <tr><td>Bob</td><td>Designer</td><td>Away</td></tr>
        <tr><td>Carol</td><td>PM</td><td>Active</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Output</h2>
    <div id="output">Waiting for interaction...</div>
  </div>

  <script src="./hypha-debugger.min.js"
    data-server-url="{server_url}"
    {token_attr}
    {workspace_attr}></script>
  <script>
    let count = 0;
    let todos = [];

    function log(msg) {{
      document.getElementById('output').textContent = msg;
    }}

    function greet() {{
      const name = document.getElementById('name-input').value || 'World';
      const email = document.getElementById('email-input').value;
      const role = document.getElementById('role-select').value;
      log(`Hello, ${{name}}! (${{role}})${{email ? ' - ' + email : ''}}`);
    }}

    function changeCount(delta) {{
      count += delta;
      document.getElementById('count').textContent = count;
      log(`Counter: ${{count}}`);
    }}

    function addTodo() {{
      const input = document.getElementById('todo-input');
      const text = input.value.trim();
      if (!text) return;
      todos.push({{ text, done: false }});
      input.value = '';
      renderTodos();
      log(`Added todo: ${{text}}`);
    }}

    function toggleTodo(i) {{
      todos[i].done = !todos[i].done;
      renderTodos();
    }}

    function renderTodos() {{
      const list = document.getElementById('todo-list');
      list.innerHTML = '';
      todos.forEach((t, i) => {{
        const div = document.createElement('div');
        div.className = 'todo-item' + (t.done ? ' done' : '');
        div.innerHTML = `<input type="checkbox" ${{t.done ? 'checked' : ''}} onchange="toggleTodo(${{i}})"><span>${{t.text}}</span>`;
        list.appendChild(div);
      }});
    }}
  </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    token_attr = f'data-token="{PAGE_CONFIG["token"]}"' if PAGE_CONFIG["token"] else ""
    workspace_attr = f'data-workspace="{PAGE_CONFIG["workspace"]}"' if PAGE_CONFIG["workspace"] else ""
    return HTML_TEMPLATE.format(
        server_url=PAGE_CONFIG["server_url"],
        token_attr=token_attr,
        workspace_attr=workspace_attr,
    )


@app.get("/hypha-debugger.min.js")
async def serve_debugger_js():
    js_file = JS_DIR / "hypha-debugger.min.js"
    return Response(content=js_file.read_text(), media_type="application/javascript")


async def serve_fastapi(args, context=None):
    await app(args["scope"], args["receive"], args["send"])


async def main():
    parser = argparse.ArgumentParser(description="Hypha Debugger E2E Test")
    parser.add_argument("--server-url", default="https://hypha.aicell.io")
    parser.add_argument("--token", default="", help="Auth token (passed to both ASGI app and debugger)")
    parser.add_argument("--workspace", default="", help="Workspace (passed to both ASGI app and debugger)")
    args = parser.parse_args()

    PAGE_CONFIG["server_url"] = args.server_url
    PAGE_CONFIG["token"] = args.token
    PAGE_CONFIG["workspace"] = args.workspace

    connect_config = {"server_url": args.server_url}
    if args.token:
        connect_config["token"] = args.token
    if args.workspace:
        connect_config["workspace"] = args.workspace

    server = await connect_to_server(connect_config)

    svc = await server.register_service(
        {
            "id": "e2e-test-app",
            "name": "E2E Test App",
            "type": "asgi",
            "serve": serve_fastapi,
            "config": {"visibility": "public"},
        }
    )

    workspace = server.config["workspace"]
    service_id = svc["id"].split(":")[1] if ":" in svc["id"] else svc["id"]
    public_url = f"https://hypha.aicell.io/{workspace}/apps/{service_id}/"

    import sys
    print(flush=True)
    print("=" * 60, flush=True)
    print("  E2E Test App is running!", flush=True)
    print(f"  Open in browser: {public_url}", flush=True)
    print(flush=True)
    print(f"  Workspace: {workspace}", flush=True)
    if args.token:
        print(f"  Token: {args.token[:20]}...", flush=True)
        print(flush=True)
        print("  The debugger will connect to the SAME workspace with", flush=True)
        print("  the SAME token. Service URL is predictable:", flush=True)
        print(f"  https://hypha.aicell.io/{workspace}/services/{{clientId}}:web-debugger", flush=True)
    print("=" * 60, flush=True)
    print(flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    sys.stdout.flush()

    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
