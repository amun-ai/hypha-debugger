"""Source code and skill documentation service."""

import inspect
import os

try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def get_source(
        module: str = Field(
            default="",
            description=(
                'Module path relative to hypha_debugger, e.g. "services.execute". '
                'Empty string returns a list of available modules.'
            ),
        ),
    ) -> dict:
        """Get the source code of hypha-debugger modules.

        Use this to understand exactly what functions are available, their
        parameters, and how they work. Pass an empty string to list modules.
        """
        return _get_source_impl(module)

    @schema_function
    def get_skill_md() -> str:
        """Get full API documentation for all debugger service functions.

        Returns a Markdown document describing every available function,
        its parameters, return values, and curl usage examples. Suitable
        for pasting into an AI agent context.
        """
        return _get_skill_md_impl()

except ImportError:

    def get_source(module: str = "") -> dict:
        """Get the source code of hypha-debugger modules."""
        return _get_source_impl(module)

    def get_skill_md() -> str:
        """Get full API documentation for all debugger service functions."""
        return _get_skill_md_impl()


_MODULES = {
    "debugger": "hypha_debugger.debugger",
    "services.execute": "hypha_debugger.services.execute",
    "services.shell": "hypha_debugger.services.shell",
    "cli": "hypha_debugger.cli",
    "services.filesystem": "hypha_debugger.services.filesystem",
    "services.info": "hypha_debugger.services.info",
    "services.inspect_vars": "hypha_debugger.services.inspect_vars",
    "services.source": "hypha_debugger.services.source",
    "utils.env": "hypha_debugger.utils.env",
}


def _get_source_impl(module: str) -> dict:
    if not module:
        return {
            "modules": list(_MODULES.keys()),
            "hint": 'Pass a module name, e.g. get_source(module="services.execute")',
        }

    full_name = _MODULES.get(module)
    if not full_name:
        return {
            "error": f"Unknown module: {module}",
            "available": list(_MODULES.keys()),
        }

    try:
        mod = __import__(full_name, fromlist=["_"])
        source = inspect.getsource(mod)
        return {
            "module": module,
            "full_name": full_name,
            "source": source,
            "lines": source.count("\n") + 1,
        }
    except Exception as e:
        return {"error": f"Failed to get source: {e}"}


def _get_skill_md_impl() -> str:
    return """# Hypha Remote Debugger — Python Process API

## Overview
A remote debugger is attached to a running Python process. You have full access
to run shell + Python, read/write files, inspect variables, and install packages.

**START HERE → install the `hyd` CLI (next section).** Decision rule: if you'll run
more than ~2 commands here (i.e. almost any real task), `hyd` is the intended
interface — one `pip install`, then every command is a short `hyd sh '…'` /
`hyd py '…'` with the connection + working directory remembered for you, far fewer
tokens than re-sending an authenticated curl each time, and it behaves like a local
shell. Only for a single throwaway call is raw curl (further down) simpler. The raw
HTTP API is the low-level fallback and powers the CLI.

## Fast path — the `hyd` CLI (do this first)

Bootstrap yourself in three lines (THIS_SERVICE_URL = the URL you fetched this doc
from, without the trailing `/get_skill_md`):

```bash
pip install hypha-debugger            # ships the `hyd` command
hyd profile add main "<THIS_SERVICE_URL>"   # add --token <t> if the URL is token-protected
export HYD_PROFILE=main               # select it (env var — per-terminal, not on disk)

hyd sh 'uname -a && pwd'              # run a remote shell command
hyd 'ls -la'                         # bare form: anything not a subcommand runs as a command
hyd py 'import sys; sys.version'      # run Python via execute_code
hyd status                           # confirm it's connected
```

If the `hyd` command isn't on your PATH after install (e.g. a `--user` install),
either add the install bin dir to PATH or just use `python -m hypha_debugger.cli`
in place of `hyd` — identical arguments (`python -m hypha_debugger.cli sh 'pwd'`).

Key ideas:
- **The remote is stateless.** The "current directory" and "current profile" live
  in the environment variables `HYD_CWD` and `HYD_PROFILE` (per shell), so different
  terminals are isolated and nothing session-specific is written to disk. Set
  `export HYD_CWD=/some/dir` to fix a working directory, or run
  `eval "$(hyd shell-init)"` once so `cd`/`cwd` stay in sync automatically after each
  `hyd sh`.
- **Multiple machines**: add more profiles (`hyd profile add other "<url>" --token …`)
  and switch with `export HYD_PROFILE=other` or a one-off `hyd -p other sh '…'`.
- **Terminal *or* browser**: each profile has a `type` (inferred from the URL). A
  terminal profile (this Python debugger) runs shell/Python; a `browser` profile (a
  Hypha Navigator web service) runs JavaScript. The SAME bare `hyd '<x>'` adapts —
  shell on a terminal profile, JS on a browser one — or force it with `hyd sh` /
  `hyd js`. `hyd call <fn> [--json '{…}']` calls any function; `hyd nav <url>` /
  `hyd shot [file]` are browser shortcuts. Example:
  `hyd profile add web "<navigator-url>" --type browser --use && hyd 'document.title'`.
- `hyd sh` streams stdout/stderr and exits with the remote command's exit code, so
  it behaves like a local shell. Run `hyd` (no args) for full help.

The raw HTTP API below still works (and powers the CLI) — use it directly if you
can't install the CLI.

## Quick Start

```bash
# Set the service URL (provided when debugger starts)
SERVICE_URL="<your-service-url>"

# Run Python code (persistent REPL — variables survive across calls):
curl -X POST "$SERVICE_URL/execute_code" \\
  -H "Content-Type: application/json" \\
  -d '{"code": "import os; os.listdir(\\".\\")"}'

# Install a package:
curl -X POST "$SERVICE_URL/execute_code" \\
  -H "Content-Type: application/json" \\
  -d '{"code": "import subprocess; subprocess.check_output([\\\"pip\\\", \\\"install\\\", \\\"requests\\\"])"}'

# Write a file via execute_code (avoids JSON escaping issues):
curl -X POST "$SERVICE_URL/execute_code" \\
  -H "Content-Type: application/json" \\
  -d '{"code": "with open(\\\"hello.py\\\", \\\"w\\\") as f: f.write(\\\"print(42)\\\\n\\\")"}'
```

## Functions

### execute_code(code, namespace?, timeout?) — PRIMARY
Execute Python code in a persistent REPL. The last expression is automatically
captured as the return value via AST parsing.
- **code** (str, required): Python code to execute.
- **namespace** (str, default `""`): Empty = persistent REPL, `"__main__"` = main module.
- **timeout** (int, default `30`): Seconds. 0 = no timeout.
- **Returns**: `{ok, stdout, stderr, result, result_repr, result_type, error?, error_type?, error_message?, traceback?, timed_out?}`
- Variables, functions, and imports persist across calls.
- Example: `"x = 1\\nx + 1"` returns `{ok: true, result: 2}`.

### execute_bash(command, cwd?, env?, timeout?) — remote shell (STATELESS)
Run a shell command on the remote host. Each call is a fresh shell (no server
state). To emulate a persistent terminal, pass the current directory as `cwd` and
reuse the returned `cwd` on the next call — this is exactly what the `hyd` CLI
above does for you.
- **command** (str, required): bash command line.
- **cwd** (str, default `""`): directory to run in (`""` = the process cwd).
- **env** (object, optional): env vars to export before the command.
- **timeout** (int, default `30`): seconds; 0 = no limit.
- **Returns**: `{stdout, exit_code, cwd}` — `stdout` has stderr merged in; `cwd` is
  the directory AFTER the command (so `cd` is reflected).
- Example: `curl -X POST "$SERVICE_URL/execute_bash" -d '{"command":"ls -la","cwd":"/tmp"}'`

### get_process_info()
PID, CWD, Python version, hostname, platform, memory usage, CPU count.
- **Example**: `curl "$SERVICE_URL/get_process_info"`

### list_files(path?, pattern?)
List directory contents. Accepts absolute or relative paths.
- **path** (str, default `"."`), **pattern** (str): glob filter e.g. `"*.py"`.
- **Returns**: `{path, entries: [{name, type, size?}], total}`

### read_file(path, max_lines?, offset?, encoding?)
Read a file. Accepts absolute or relative paths.
- **path** (str, required), **max_lines** (int, default `500`), **offset** (int, default `0`).
- **Returns**: `{path, content, lines_read, offset, truncated}`

### write_file(path, content, mode?, create_dirs?, encoding?)
Write/append to a file. Auto-creates parent dirs. Accepts absolute or relative paths.
- **path** (str), **content** (str), **mode** (`"w"` or `"a"`).
- **Returns**: `{path, bytes_written, mode}`

### get_variable(name, namespace?)
Inspect a variable by name in a module namespace.
- **Returns**: `{name, type, repr, length?, shape?, dtype?, keys?}`

### list_variables(namespace?, filter?, include_private?)
List variables in a namespace. Filters by substring.

### get_stack_trace()
Stack traces of all threads. Useful for debugging hangs.

### get_installed_packages(filter?)
List pip packages. Optional name substring filter.

### get_source(module?)
Get debugger source code. Empty = list modules, e.g. `"services.execute"`.

### get_skill_md()
Returns this document.

## Tips
- **Use `execute_code` for file writes** when content has special characters —
  it avoids JSON/curl escaping issues that affect `write_file` via HTTP.
- File operations accept absolute paths or paths relative to the process CWD.
- POST endpoints accept JSON body. GET endpoints take no body.
- Code execution has a 30s default timeout to prevent hangs.
- The REPL namespace is independent from `__main__` by default.
"""
