"""Environment detection and process metadata collection."""

import os
import sys
import platform
import socket
from datetime import datetime, timezone


def collect_process_info() -> dict:
    """Collect information about the current Python process and environment."""
    info = {
        "pid": os.getpid(),
        "cwd": os.getcwd(),
        "python_version": sys.version,
        "python_executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "hostname": socket.gethostname(),
        "user": _get_user(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "argv": sys.argv,
        "path": sys.path[:10],
        "environment": _safe_env_subset(),
    }

    # Optional psutil info
    try:
        import psutil

        proc = psutil.Process(os.getpid())
        mem = proc.memory_info()
        info["memory"] = {
            "rss_mb": round(mem.rss / 1024 / 1024, 1),
            "vms_mb": round(mem.vms / 1024 / 1024, 1),
        }
        info["cpu_percent"] = proc.cpu_percent(interval=0.1)
        info["num_threads"] = proc.num_threads()
        info["create_time"] = datetime.fromtimestamp(
            proc.create_time(), tz=timezone.utc
        ).isoformat()
    except ImportError:
        info["memory"] = None
        info["cpu_percent"] = None

    return info


def _get_user() -> str:
    try:
        return os.getlogin()
    except OSError:
        import getpass

        return getpass.getuser()


def _safe_env_subset() -> dict:
    """Return a safe subset of environment variables (no secrets)."""
    safe_keys = [
        "HOME",
        "USER",
        "SHELL",
        "LANG",
        "TERM",
        "PATH",
        "VIRTUAL_ENV",
        "CONDA_DEFAULT_ENV",
        "PYTHONPATH",
    ]
    return {k: os.environ.get(k, "") for k in safe_keys if k in os.environ}
