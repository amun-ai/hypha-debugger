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
A debugger is attached to a running Python process. You can remotely execute code,
read/write files, inspect variables, and query process info via the HTTP API.

## Functions

### get_process_info()
Get information about the current Python process.
- **Returns**: `{pid, cwd, python_version, hostname, platform, memory_mb, cpu_count, ...}`
- **Example**: `curl "$SERVICE_URL/get_process_info"`

### execute_code(code, namespace?, timeout?)
Execute arbitrary Python code in the process.
- **code** (string, required): Python code to execute.
- **namespace** (string, default `"__main__"`): Module namespace to execute in.
- **timeout** (int, default `30`): Timeout in seconds. 0 for no timeout.
- **Returns**: `{stdout, stderr, result, result_type, error?, timed_out?}`
- Tries `eval()` first (returns value), falls back to `exec()` (returns None).
- **Example**:
  ```bash
  curl -X POST "$SERVICE_URL/execute_code" \\
    -H "Content-Type: application/json" \\
    -d '{"code": "import sys; sys.version"}'
  ```

### get_variable(name, namespace?)
Inspect a variable by name.
- **name** (string, required): Variable name.
- **namespace** (string, default `"__main__"`): Module namespace.
- **Returns**: `{name, type, repr, length?, shape?, dtype?, keys?}`

### list_variables(namespace?, filter?, include_private?)
List variables in a namespace.
- **namespace** (string, default `"__main__"`): Module namespace.
- **filter** (string): Substring filter for names.
- **include_private** (bool, default `false`): Include `_`-prefixed names.
- **Returns**: List of `{name, type, repr}`.

### get_stack_trace()
Get stack traces of all threads.
- **Returns**: List of `{thread_id, thread_name, stack}`.
- **Example**: `curl "$SERVICE_URL/get_stack_trace"`

### list_files(path?, pattern?)
List files and directories (sandboxed to CWD).
- **path** (string, default `"."`): Directory path relative to CWD.
- **pattern** (string): Glob filter, e.g. `"*.py"`.
- **Returns**: `{path, entries: [{name, type, size?}], total}`
- **Example**: `curl "$SERVICE_URL/list_files"`

### read_file(path, max_lines?, offset?, encoding?)
Read a file (sandboxed to CWD).
- **path** (string, required): File path relative to CWD.
- **max_lines** (int, default `500`): Max lines to read.
- **offset** (int, default `0`): Lines to skip from beginning.
- **Returns**: `{path, content, lines_read, offset, truncated}`
- **Example**:
  ```bash
  curl -X POST "$SERVICE_URL/read_file" \\
    -H "Content-Type: application/json" \\
    -d '{"path": "main.py"}'
  ```

### write_file(path, content, mode?, create_dirs?, encoding?)
Write content to a file (sandboxed to CWD).
- **path** (string, required): File path relative to CWD.
- **content** (string, required): Content to write.
- **mode** (string, default `"w"`): `"w"` to overwrite, `"a"` to append.
- **create_dirs** (bool, default `true`): Create parent directories.
- **Returns**: `{path, bytes_written, mode}`
- **Example**:
  ```bash
  curl -X POST "$SERVICE_URL/write_file" \\
    -H "Content-Type: application/json" \\
    -d '{"path": "hello.txt", "content": "Hello!"}'
  ```

### get_installed_packages(filter?)
List installed pip packages.
- **filter** (string): Substring filter for package names.
- **Returns**: List of `{name, version}`.
- **Example**: `curl "$SERVICE_URL/get_installed_packages"`

### get_source(module?)
Get the source code of debugger modules.
- **module** (string): Module path, e.g. `"services.execute"`. Empty to list modules.
- **Returns**: `{module, source, lines}` or `{modules, hint}`.

### get_skill_md()
Get this API documentation as Markdown.
- **Returns**: This document as a string.
- **Example**: `curl "$SERVICE_URL/get_skill_md"`

## Notes
- All file operations are sandboxed to the process CWD.
- POST endpoints accept JSON body with parameter names as keys.
- GET endpoints take no parameters (or use query params).
- Code execution has a default 30s timeout to prevent hangs.
"""
