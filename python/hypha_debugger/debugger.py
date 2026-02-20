"""Core debugger: connects to Hypha and registers the debug service."""

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

from hypha_debugger.services.info import get_process_info, get_installed_packages
from hypha_debugger.services.execute import execute_code
from hypha_debugger.services.inspect_vars import (
    get_variable,
    list_variables,
    get_stack_trace,
)
from hypha_debugger.services.filesystem import list_files, read_file

logger = logging.getLogger("hypha_debugger")


def _build_service_url(server_url: str, service_id: str) -> str:
    """Build a stable, predictable HTTP service URL.

    Strips the clientId prefix so the URL uses only the bare service name.
    Callers append ?_mode=last to resolve the most recent instance.

    Args:
        server_url: e.g. "https://hypha.aicell.io"
        service_id: e.g. "ws-xxx/clientId:py-debugger"

    Returns:
        e.g. "https://hypha.aicell.io/ws-xxx/services/py-debugger"
    """
    base = server_url.rstrip("/")
    # service_id format: "workspace/clientId:svcName"
    parts = service_id.split("/", 1)
    if len(parts) == 2:
        workspace, svc_part = parts
        # Strip clientId: "abc123:py-debugger" → "py-debugger"
        if ":" in svc_part:
            svc_name = svc_part.split(":", 1)[1]
        else:
            svc_name = svc_part
        return f"{base}/{workspace}/services/{svc_name}"
    return f"{base}/services/{service_id}"


def _print_session_info(server_url: str, service_id: str, service_url: str, token: str) -> None:
    """Print session information with remote access URLs."""
    print(f"[hypha-debugger] Connected to {server_url}")
    print(f"[hypha-debugger] Service ID: {service_id}")
    print(f"[hypha-debugger] Service URL: {service_url}")
    print(f"[hypha-debugger] Token: {token}")
    print()
    print(f"[hypha-debugger] Test it:")
    print(f"  curl '{service_url}/get_process_info?_mode=last' -H 'Authorization: Bearer {token}'")


@dataclass
class DebugSession:
    """Represents an active debug session connected to Hypha."""

    service_id: str
    workspace: str
    server: object
    server_url: str = ""
    service_url: str = ""
    token: str = ""
    _loop: Optional[asyncio.AbstractEventLoop] = field(
        default=None, repr=False
    )
    _thread: Optional[threading.Thread] = field(default=None, repr=False)

    async def serve_forever(self):
        """Block until disconnected (async)."""
        try:
            await self.server.serve()
        except asyncio.CancelledError:
            pass

    async def destroy(self):
        """Disconnect and clean up (async)."""
        try:
            await self.server.unregister_service(self.service_id)
        except Exception:
            pass
        try:
            await self.server.disconnect()
        except Exception:
            pass

    def destroy_sync(self):
        """Disconnect and clean up (sync)."""
        if self._loop and self._loop.is_running():
            future = asyncio.run_coroutine_threadsafe(
                self.destroy(), self._loop
            )
            try:
                future.result(timeout=10)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)


async def start_debugger(
    server_url: str,
    workspace: str = "",
    token: str = "",
    service_id: str = "py-debugger",
    service_name: str = "Python Debugger",
    visibility: str = "public",
) -> DebugSession:
    """Start the Hypha debugger (async).

    Connects to a Hypha server and registers a debug service that remote
    clients can use to inspect and interact with this Python process.

    Args:
        server_url: Hypha server URL (required).
        workspace: Workspace name (auto-assigned if empty).
        token: Authentication token.
        service_id: Service ID to register as.
        service_name: Human-readable service name.
        visibility: Service visibility ("public", "protected", "unlisted").

    Returns:
        A DebugSession with service_id, workspace, server, service_url, and token.
    """
    from hypha_rpc import connect_to_server

    connect_config = {"server_url": server_url}
    if workspace:
        connect_config["workspace"] = workspace
    if token:
        connect_config["token"] = token

    server = await connect_to_server(connect_config)

    service = {
        "name": service_name,
        "id": service_id,
        "type": "debugger",
        "description": (
            "Remote Python process debugger. Allows inspecting variables, "
            "executing code, browsing files, and getting process information."
        ),
        "config": {
            "visibility": visibility,
            "run_in_executor": True,
        },
        "get_process_info": get_process_info,
        "get_installed_packages": get_installed_packages,
        "execute_code": execute_code,
        "get_variable": get_variable,
        "list_variables": list_variables,
        "get_stack_trace": get_stack_trace,
        "list_files": list_files,
        "read_file": read_file,
    }

    svc_info = await server.register_service(service)
    actual_id = svc_info.get("id", service_id) if isinstance(svc_info, dict) else service_id
    ws = server.config.get("workspace", workspace) if hasattr(server.config, "get") else getattr(server.config, "workspace", workspace)

    # Generate a token for remote access
    session_token = await server.generate_token()

    # Build the HTTP service URL
    service_url = _build_service_url(server_url, actual_id)

    logger.info(
        "Debugger connected: server=%s workspace=%s service=%s",
        server_url,
        ws,
        actual_id,
    )
    _print_session_info(server_url, actual_id, service_url, session_token)

    return DebugSession(
        service_id=actual_id,
        workspace=ws,
        server=server,
        server_url=server_url,
        service_url=service_url,
        token=session_token,
    )


def start_debugger_sync(
    server_url: str,
    workspace: str = "",
    token: str = "",
    service_id: str = "py-debugger",
    service_name: str = "Python Debugger",
    visibility: str = "public",
) -> DebugSession:
    """Start the Hypha debugger (sync).

    Runs the event loop in a background thread so the main thread stays free.
    The debug service accepts remote calls in the background.

    Args:
        Same as start_debugger().

    Returns:
        A DebugSession with service_id, workspace, server, service_url, and token.
    """
    from hypha_rpc.sync import connect_to_server

    server = connect_to_server({"server_url": server_url, **({"workspace": workspace} if workspace else {}), **({"token": token} if token else {})})

    service = {
        "name": service_name,
        "id": service_id,
        "type": "debugger",
        "description": (
            "Remote Python process debugger. Allows inspecting variables, "
            "executing code, browsing files, and getting process information."
        ),
        "config": {
            "visibility": visibility,
            "run_in_executor": True,
        },
        "get_process_info": get_process_info,
        "get_installed_packages": get_installed_packages,
        "execute_code": execute_code,
        "get_variable": get_variable,
        "list_variables": list_variables,
        "get_stack_trace": get_stack_trace,
        "list_files": list_files,
        "read_file": read_file,
    }

    svc_info = server.register_service(service)
    actual_id = svc_info.get("id", service_id) if isinstance(svc_info, dict) else service_id
    ws = server.config.get("workspace", workspace) if hasattr(server.config, "get") else getattr(server.config, "workspace", workspace)

    # Generate a token for remote access
    session_token = server.generate_token()

    # Build the HTTP service URL
    service_url = _build_service_url(server_url, actual_id)

    logger.info(
        "Debugger connected (sync): server=%s workspace=%s service=%s",
        server_url,
        ws,
        actual_id,
    )
    _print_session_info(server_url, actual_id, service_url, session_token)

    return DebugSession(
        service_id=actual_id,
        workspace=ws,
        server=server,
        server_url=server_url,
        service_url=service_url,
        token=session_token,
    )
