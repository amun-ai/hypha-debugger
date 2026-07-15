"""Stateless remote shell execution service.

Unlike ``execute_code`` (a persistent Python REPL), ``execute_bash`` runs each
command in a **fresh** ``bash -c`` — the remote holds NO per-connection state.
The *client* (e.g. the ``hyd`` CLI) tracks the "current directory" and passes it
in as ``cwd``; the call returns the directory AFTER the command (so a ``cd`` in
the command is reflected back), letting the client emulate a persistent terminal
while keeping the server stateless (scales, survives reconnects).
"""

import os
import shlex
import subprocess
from typing import Any, Dict, Optional

# Default timeout for a shell command (seconds).
DEFAULT_TIMEOUT = 30
# Cap the returned output so a runaway command can't return megabytes.
MAX_OUTPUT_CHARS = 200_000

# Unique markers we append to the command to read back the final cwd + exit code
# without them colliding with normal output.
_MARK_CWD = "__HYD_CWD_9f3a2b__:"
_MARK_EC = "__HYD_EC_9f3a2b__:"


def _run_bash(command: str, cwd: str, env: Optional[Dict[str, str]], timeout: int) -> Dict[str, Any]:
    start_dir = cwd or os.getcwd()
    exports = ""
    if env:
        exports = "".join(
            f"export {k}={shlex.quote(str(v))}\n" for k, v in env.items()
        )
    # Wrapper: cd into the requested dir, run the command, then emit the final
    # pwd + exit code on marker lines we strip out of the returned output.
    wrapper = (
        f"cd {shlex.quote(start_dir)} 2>/dev/null || cd \"$HOME\" 2>/dev/null || true\n"
        f"{exports}"
        f"{command}\n"
        f"__hyd_ec=$?\n"
        f'printf "\\n{_MARK_CWD}%s\\n{_MARK_EC}%s\\n" "$(pwd)" "$__hyd_ec"\n'
    )

    try:
        proc = subprocess.run(
            ["bash", "-c", wrapper],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # merge stderr for a terminal-like feel
            timeout=timeout if timeout and timeout > 0 else None,
            text=True,
        )
        raw = proc.stdout or ""
    except subprocess.TimeoutExpired as e:
        partial = e.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", "replace")
        return {
            "stdout": _truncate(_strip_markers(partial)[0]),
            "exit_code": 124,
            "cwd": start_dir,
            "error": f"Command timed out after {timeout}s",
        }
    except FileNotFoundError:
        return {
            "stdout": "",
            "exit_code": 127,
            "cwd": start_dir,
            "error": "bash not found on the remote host",
        }

    output, final_cwd, exit_code = _parse(raw, start_dir)
    # If the command called `exit`/`kill` etc., our epilogue never ran and the
    # markers are absent — fall back to bash's real return code.
    if _MARK_EC not in raw:
        exit_code = proc.returncode
    return {"stdout": _truncate(output), "exit_code": exit_code, "cwd": final_cwd}


def _parse(raw: str, fallback_cwd: str):
    """Split the trailing cwd/exit-code markers off the real output."""
    cwd = fallback_cwd
    ec = 0
    idx = raw.rfind("\n" + _MARK_CWD)
    if idx == -1:
        idx = raw.rfind(_MARK_CWD)
    if idx != -1:
        tail = raw[idx:]
        output = raw[:idx]
        for line in tail.splitlines():
            if _MARK_CWD in line:
                cwd = line.split(_MARK_CWD, 1)[1].strip() or fallback_cwd
            elif _MARK_EC in line:
                try:
                    ec = int(line.split(_MARK_EC, 1)[1].strip())
                except ValueError:
                    ec = 0
    else:
        output = raw
    return output, cwd, ec


def _strip_markers(raw: str):
    output, cwd, ec = _parse(raw, "")
    return output, cwd, ec


def _truncate(text: str) -> str:
    if len(text) > MAX_OUTPUT_CHARS:
        return text[:MAX_OUTPUT_CHARS] + f"\n... [truncated at {MAX_OUTPUT_CHARS} chars]"
    return text


try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def execute_bash(
        command: str = Field(..., description="Shell command to run (bash)."),
        cwd: str = Field(
            default="",
            description=(
                "Working directory to run in. The remote is STATELESS: pass the "
                "current directory here and use the returned `cwd` for the next "
                "call to emulate a persistent shell. Empty = the process cwd."
            ),
        ),
        env: Optional[Dict[str, str]] = Field(
            default=None,
            description="Optional environment variables to export before the command.",
        ),
        timeout: int = Field(
            default=DEFAULT_TIMEOUT,
            description=f"Max seconds before the command is killed (default {DEFAULT_TIMEOUT}, 0 = no limit).",
        ),
    ) -> Dict[str, Any]:
        """Run a shell command on the remote host and return its output.

        Stateless: each call is a fresh shell. Returns {stdout (stderr merged in),
        exit_code, cwd} where `cwd` is the directory AFTER the command — pass it
        back as `cwd` next time so `cd` persists (this is what the `hyd` CLI does).
        """
        return _run_bash(command, cwd, env, timeout)

except ImportError:

    def execute_bash(
        command: str,
        cwd: str = "",
        env: Optional[Dict[str, str]] = None,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> Dict[str, Any]:
        """Run a shell command on the remote host and return its output."""
        return _run_bash(command, cwd, env, timeout)
