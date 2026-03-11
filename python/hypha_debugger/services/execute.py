"""Arbitrary code execution service with persistent REPL and timeout support."""

import ast
import io
import json
import reprlib
import signal
import sys
import threading
import traceback
from contextlib import redirect_stdout, redirect_stderr
from typing import Any, Dict, Optional

# Default timeout for code execution (seconds). 0 = no timeout.
DEFAULT_TIMEOUT = 30

# Persistent REPL namespace — survives across calls.
_repl_globals: Dict[str, Any] = {
    "__name__": "__repl__",
    "__builtins__": __builtins__,
}


def _safe_jsonable(obj: Any) -> Any:
    """Return obj if it's JSON-serializable, else its repr."""
    try:
        json.dumps(obj)
        return obj
    except Exception:
        return reprlib.repr(obj)


def _summarize_namespace(ns: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Summarize namespace variables (skip dunders)."""
    summary = {}
    for k, v in ns.items():
        if k.startswith("__") and k.endswith("__"):
            continue
        summary[k] = {
            "type": type(v).__name__,
            "repr": reprlib.repr(v),
            "jsonable": _safe_jsonable(v),
        }
    return summary


try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def execute_code(
        code: str = Field(..., description="Python code to execute."),
        namespace: str = Field(
            default="",
            description=(
                'Namespace to execute in. Default: "" uses the persistent REPL namespace '
                '(variables survive across calls). Use "__main__" for the main module namespace.'
            ),
        ),
        timeout: int = Field(
            default=DEFAULT_TIMEOUT,
            description="Timeout in seconds. 0 for no timeout. Default: 30.",
        ),
    ) -> dict:
        """Execute Python code in the debugger process and return stdout, stderr, and the result.

        Uses AST parsing to capture the last expression's value automatically.
        For example, `x = 1\\nx + 1` will return result=2.
        Code runs in a persistent REPL namespace so variables, functions, and imports
        survive across calls. A timeout (default 30s) prevents infinite loops.
        """
        return _execute_impl(code, namespace, timeout)

except ImportError:

    def execute_code(code: str, namespace: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
        """Execute Python code in the debugger process."""
        return _execute_impl(code, namespace, timeout)


def _get_namespace(namespace: str) -> Dict[str, Any]:
    """Get the target namespace dict."""
    if not namespace:
        return _repl_globals
    if namespace == "__main__":
        mod = sys.modules.get("__main__")
        return vars(mod) if mod else _repl_globals
    mod = sys.modules.get(namespace)
    return vars(mod) if mod else _repl_globals


def _execute_impl(code: str, namespace: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Implementation of code execution with AST-based last-expression capture."""
    ns = _get_namespace(namespace)

    # Parse the code into an AST
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as e:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "",
            "result": None,
            "result_repr": None,
            "error_type": type(e).__name__,
            "error_message": str(e),
            "traceback": traceback.format_exc(),
        }

    # Separate the last expression (if any) so we can eval it for its value
    body = tree.body
    last_expr_node = None
    if body and isinstance(body[-1], ast.Expr):
        last_expr_node = body[-1].value
        body = body[:-1]

    exec_code = compile(
        ast.Module(body=body, type_ignores=[]),
        filename="<debugger-repl>",
        mode="exec",
    )

    eval_code = None
    if last_expr_node is not None:
        eval_code = compile(
            ast.Expression(last_expr_node),
            filename="<debugger-repl>",
            mode="eval",
        )

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    result = None
    error_type = None
    error_message = None
    error_tb = None
    timed_out = False

    def _run():
        nonlocal result
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(exec_code, ns, ns)
            if eval_code is not None:
                result = eval(eval_code, ns, ns)

    try:
        if timeout > 0 and threading.current_thread() is threading.main_thread():
            def _timeout_handler(signum, frame):
                raise TimeoutError(f"Code execution timed out after {timeout}s")

            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(timeout)
            try:
                _run()
            except TimeoutError as e:
                error_type = "TimeoutError"
                error_message = str(e)
                error_tb = traceback.format_exc()
                timed_out = True
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
        else:
            _run()
    except Exception as e:
        error_type = type(e).__name__
        error_message = str(e)
        error_tb = traceback.format_exc()

    response = {
        "ok": error_type is None,
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "result": _safe_jsonable(result),
        "result_repr": reprlib.repr(result) if result is not None else None,
        "result_type": type(result).__name__ if result is not None else "None",
    }

    if error_type:
        response["error_type"] = error_type
        response["error_message"] = error_message
        response["traceback"] = error_tb
        # Keep backward-compat "error" key
        response["error"] = error_tb or error_message

    if timed_out:
        response["timed_out"] = True

    return response
