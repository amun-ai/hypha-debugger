"""Arbitrary code execution service."""

import sys
import io
import traceback

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
    ) -> dict:
        """Execute Python code in the debugger process and return stdout, stderr, and the result of the last expression."""
        return _execute_impl(code, namespace)

except ImportError:

    def execute_code(code: str, namespace: str = "__main__") -> dict:
        """Execute Python code in the debugger process."""
        return _execute_impl(code, namespace)


def _execute_impl(code: str, namespace: str = "__main__") -> dict:
    """Implementation of code execution."""
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

    try:
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        # Try as expression first (to capture return value)
        try:
            result = eval(code, ns)
        except SyntaxError:
            # Not an expression, execute as statements
            exec(code, ns)
            result = None
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

    return response


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
