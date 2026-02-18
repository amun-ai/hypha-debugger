"""Variable inspection service."""

import sys

try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def get_variable(
        name: str = Field(..., description="Variable name to inspect."),
        namespace: str = Field(
            default="__main__",
            description='Module namespace. Default: "__main__".',
        ),
    ) -> dict:
        """Inspect a variable in the current namespace. Returns its type, value (serialized), and repr."""
        return _get_variable_impl(name, namespace)

    @schema_function
    def list_variables(
        namespace: str = Field(
            default="__main__",
            description='Module namespace. Default: "__main__".',
        ),
        filter: str = Field(
            default="",
            description="Optional substring filter for variable names.",
        ),
        include_private: bool = Field(
            default=False,
            description="Include variables starting with underscore.",
        ),
    ) -> list:
        """List variables in the given namespace."""
        return _list_variables_impl(namespace, filter, include_private)

    @schema_function
    def get_stack_trace() -> list:
        """Get the current stack trace of all threads."""
        return _get_stack_trace_impl()

except ImportError:

    def get_variable(name: str, namespace: str = "__main__") -> dict:
        """Inspect a variable in the current namespace."""
        return _get_variable_impl(name, namespace)

    def list_variables(
        namespace: str = "__main__", filter: str = "", include_private: bool = False
    ) -> list:
        """List variables in the given namespace."""
        return _list_variables_impl(namespace, filter, include_private)

    def get_stack_trace() -> list:
        """Get the current stack trace of all threads."""
        return _get_stack_trace_impl()


def _get_namespace(namespace: str) -> dict:
    if namespace == "__main__":
        mod = sys.modules.get("__main__")
        return vars(mod) if mod else {}
    mod = sys.modules.get(namespace)
    return vars(mod) if mod else {}


def _safe_repr(obj, max_len=500):
    try:
        r = repr(obj)
        return r if len(r) <= max_len else r[:max_len] + "..."
    except Exception:
        return f"<{type(obj).__name__}>"


def _get_variable_impl(name: str, namespace: str) -> dict:
    ns = _get_namespace(namespace)
    if name not in ns:
        return {"error": f"Variable '{name}' not found in namespace '{namespace}'"}
    obj = ns[name]
    result = {
        "name": name,
        "type": type(obj).__name__,
        "repr": _safe_repr(obj),
    }
    # Add extra info for common types
    if isinstance(obj, (list, tuple, set, frozenset)):
        result["length"] = len(obj)
    elif isinstance(obj, dict):
        result["length"] = len(obj)
        result["keys"] = list(obj.keys())[:20]
    elif hasattr(obj, "__len__"):
        try:
            result["length"] = len(obj)
        except Exception:
            pass
    if hasattr(obj, "shape"):
        try:
            result["shape"] = list(obj.shape)
        except Exception:
            pass
    if hasattr(obj, "dtype"):
        try:
            result["dtype"] = str(obj.dtype)
        except Exception:
            pass
    return result


def _list_variables_impl(
    namespace: str, filter: str, include_private: bool
) -> list:
    ns = _get_namespace(namespace)
    result = []
    for name, obj in sorted(ns.items()):
        if not include_private and name.startswith("_"):
            continue
        if filter and filter.lower() not in name.lower():
            continue
        # Skip modules and builtins
        if isinstance(obj, type(sys)):
            continue
        result.append(
            {
                "name": name,
                "type": type(obj).__name__,
                "repr": _safe_repr(obj, max_len=100),
            }
        )
    return result[:200]


def _get_stack_trace_impl() -> list:
    import threading
    import traceback

    traces = []
    frames = sys._current_frames()
    for thread_id, frame in frames.items():
        thread_name = None
        for t in threading.enumerate():
            if t.ident == thread_id:
                thread_name = t.name
                break
        trace_lines = traceback.format_stack(frame)
        traces.append(
            {
                "thread_id": thread_id,
                "thread_name": thread_name or f"Thread-{thread_id}",
                "stack": "".join(trace_lines),
            }
        )
    return traces
