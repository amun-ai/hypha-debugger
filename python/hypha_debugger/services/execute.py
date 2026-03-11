"""Arbitrary code execution service with timeout support."""

import sys
import io
import signal
import traceback
import threading

# Default timeout for code execution (seconds). 0 = no timeout.
DEFAULT_TIMEOUT = 30

try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def execute_code(
        code: str = Field(..., description="Python code to execute."),
        namespace: str = Field(
            default="__main__",
            description='Namespace to execute in. Default: "__main__" (the main module namespace).',
        ),
        timeout: int = Field(
            default=DEFAULT_TIMEOUT,
            description="Timeout in seconds. 0 for no timeout. Default: 30.",
        ),
    ) -> dict:
        """Execute Python code in the debugger process and return stdout, stderr, and the result.

        Supports both expressions (returns the value) and statements.
        Code runs in the target namespace so you can define functions, import modules, etc.
        A timeout (default 30s) prevents infinite loops from hanging the debugger.
        """
        return _execute_impl(code, namespace, timeout)

except ImportError:

    def execute_code(code: str, namespace: str = "__main__", timeout: int = DEFAULT_TIMEOUT) -> dict:
        """Execute Python code in the debugger process."""
        return _execute_impl(code, namespace, timeout)


def _execute_impl(code: str, namespace: str = "__main__", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Implementation of code execution with optional timeout."""
    # Get the target namespace
    if namespace == "__main__":
        ns = vars(sys.modules.get("__main__", {}))
    else:
        mod = sys.modules.get(namespace)
        ns = vars(mod) if mod else {}

    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    result = None
    error = None
    timed_out = False

    try:
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        if timeout > 0 and threading.current_thread() is threading.main_thread():
            # Use SIGALRM for timeout on the main thread (Unix only)
            def _timeout_handler(signum, frame):
                raise TimeoutError(f"Code execution timed out after {timeout}s")

            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(timeout)
            try:
                result = _run_code(code, ns)
            except TimeoutError as e:
                error = str(e)
                timed_out = True
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
        else:
            # No timeout or not on main thread — run directly
            result = _run_code(code, ns)
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_str = stdout_capture.getvalue()
    stderr_str = stderr_capture.getvalue()

    # Serialize result safely
    serialized_result = _safe_serialize(result)

    response = {
        "stdout": stdout_str,
        "stderr": stderr_str,
        "result": serialized_result,
        "result_type": type(result).__name__ if result is not None else "None",
    }
    if error:
        response["error"] = error
    if timed_out:
        response["timed_out"] = True

    return response


def _run_code(code: str, ns: dict):
    """Try as expression first (to capture return value), fall back to exec."""
    try:
        return eval(code, ns)
    except SyntaxError:
        exec(code, ns)
        return None


def _safe_serialize(obj, depth=0, max_depth=3):
    """Safely serialize an object for RPC transport."""
    if depth > max_depth:
        return repr(obj)
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, bytes):
        return f"<bytes len={len(obj)}>"
    if isinstance(obj, (list, tuple)):
        return [_safe_serialize(v, depth + 1, max_depth) for v in obj[:100]]
    if isinstance(obj, dict):
        return {
            str(k): _safe_serialize(v, depth + 1, max_depth)
            for k, v in list(obj.items())[:50]
        }
    if isinstance(obj, set):
        return [_safe_serialize(v, depth + 1, max_depth) for v in list(obj)[:100]]
    # Try repr for everything else
    try:
        r = repr(obj)
        return r if len(r) < 1000 else r[:1000] + "..."
    except Exception:
        return f"<{type(obj).__name__}>"
