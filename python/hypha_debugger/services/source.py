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
to execute code, read/write files, inspect variables, and install packages.

**Recommended approach**: Use `execute_code` as your primary tool — it's a
persistent Python REPL where variables, imports, and functions survive across
calls. The other endpoints are convenience shortcuts.

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

### get_process_info()
PID, CWD, Python version, hostname, platform, memory usage, CPU count.
- **Example**: `curl "$SERVICE_URL/get_process_info"`

### list_files(path?, pattern?)
List directory contents (sandboxed to CWD).
- **path** (str, default `"."`), **pattern** (str): glob filter e.g. `"*.py"`.
- **Returns**: `{path, entries: [{name, type, size?}], total}`

### read_file(path, max_lines?, offset?, encoding?)
Read a file (sandboxed to CWD).
- **path** (str, required), **max_lines** (int, default `500`), **offset** (int, default `0`).
- **Returns**: `{path, content, lines_read, offset, truncated}`

### write_file(path, content, mode?, create_dirs?, encoding?)
Write/append to a file (sandboxed to CWD). Auto-creates parent dirs.
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
- All file operations (list/read/write) are sandboxed to the process CWD.
- POST endpoints accept JSON body. GET endpoints take no body.
- Code execution has a 30s default timeout to prevent hangs.
- The REPL namespace is independent from `__main__` by default.
"""
