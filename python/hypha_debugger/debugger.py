"""Core debugger: connects to Hypha and registers the debug service."""

import asyncio
import logging
import secrets
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
from hypha_debugger.services.filesystem import list_files, read_file, write_file
from hypha_debugger.services.source import get_source, get_skill_md

logger = logging.getLogger("hypha_debugger")


def _build_service_url(server_url: str, service_id: str) -> str:
    """Build the HTTP service URL from server URL and full service ID.

    Strips the clientId prefix so the URL uses only the bare service name.

    Args:
        server_url: e.g. "https://hypha.aicell.io"
        service_id: e.g. "ws-xxx/clientId:py-debugger-abc123"

    Returns:
        e.g. "https://hypha.aicell.io/ws-xxx/services/py-debugger-abc123"
    """
    base = server_url.rstrip("/")
    # service_id format: "workspace/clientId:svcName"
    parts = service_id.split("/", 1)
    if len(parts) == 2:
        workspace, svc_part = parts
        # Strip clientId: "abc123:py-debugger-xyz" → "py-debugger-xyz"
        if ":" in svc_part:
            svc_name = svc_part.split(":", 1)[1]
        else:
            svc_name = svc_part
        return f"{base}/{workspace}/services/{svc_name}"
    return f"{base}/services/{service_id}"


def _build_instruction_block(service_url: str, token: str = "") -> str:
    """Build the instruction block with copy-paste commands for remote access.

    Returns a formatted string that can be pasted directly into an AI agent chat.
    """
    auth = f' -H "Authorization: Bearer $TOKEN"' if token else ""
    lines = [
        "# Hypha Remote Debugger — Python Process",
        "# A debugger is attached to a running Python process.",
        "# You can remotely execute code, read/write files, inspect variables,",
        "# and query process info via the HTTP API below.",
        "#",
        "# Available functions:",
        "#   get_process_info    - PID, Python version, CWD, platform, memory",
        "#   execute_code        - Run Python code (persistent REPL, auto-captures last expr)",
        "#   get_variable        - Inspect a variable by name",
        "#   list_variables      - List variables in a namespace",
        "#   get_stack_trace     - Stack traces of all threads",
        "#   list_files          - List directory contents",
        "#   read_file           - Read file content (with offset/limit)",
        "#   write_file          - Write/append to a file",
        "#   get_installed_packages - List pip packages",
        "#   get_source           - Get debugger source code (for self-inspection)",
        "#   get_skill_md         - Get full API docs as Markdown",
        "#",
        "# POST endpoints accept JSON body with parameter names as keys.",
        "",
        f'SERVICE_URL="{service_url}"',
    ]
    if token:
        lines.append(f'TOKEN="{token}"')
    lines += [
        "",
        "# Get process info (PID, Python version, CWD, memory):",
        f'curl "$SERVICE_URL/get_process_info"{auth}',
        "",
        "# Execute Python code (timeout default 30s):",
        f'curl -X POST "$SERVICE_URL/execute_code"{auth}'
        ' -H "Content-Type: application/json"'
        " -d '{\"code\": \"import sys; sys.version\"}'",
        "",
        "# Write a file:",
        f'curl -X POST "$SERVICE_URL/write_file"{auth}'
        ' -H "Content-Type: application/json"'
        " -d '{\"path\": \"hello.txt\", \"content\": \"Hello, world!\"}'",
        "",
        "# List files in working directory:",
        f'curl "$SERVICE_URL/list_files"{auth}',
        "",
        "# Read a file:",
        f'curl -X POST "$SERVICE_URL/read_file"{auth}'
        ' -H "Content-Type: application/json"'
        " -d '{\"path\": \"hello.txt\"}'",
        "",
        "# Get full API documentation:",
        f'curl "$SERVICE_URL/get_skill_md"{auth}',
    ]
    return "\n".join(lines)


def _print_session_info(
    server_url: str,
    service_url: str,
    token: str = "",
) -> None:
    """Print session information with remote access URLs."""
    print(f"[hypha-debugger] Connected to {server_url}")
    print(f"[hypha-debugger] Service URL: {service_url}")
    if token:
        print(f"[hypha-debugger] Token: {token}")
    print()
    sep = "=" * 60
    print(sep)
    print("  WARNING: The URL below grants full access to this Python")
    print("  process (execute code, read/write files). Only share it")
    print("  with trusted agents or people.")
    print(sep)
    print()
    print(_build_instruction_block(service_url, token))
    print()
    print(sep)


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

    def print_instructions(self) -> str:
        """Print copy-paste instructions for remote access and return them."""
        instructions = _build_instruction_block(self.service_url, self.token)
        sep = "=" * 60
        print(sep)
        print("  WARNING: The URL below grants full access to this Python")
        print("  process (execute code, read/write files). Only share it")
        print("  with trusted agents or people.")
        print(sep)
        print()
        print(instructions)
        print()
        print(sep)
        return instructions

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


def _resolve_id_and_visibility(
    service_id: str,
    visibility: str,
    require_token: bool,
) -> tuple:
    """Resolve effective service ID and visibility.

    By default (require_token=False), generates a unique random service ID
    and registers as unlisted. The URL itself acts as the secret.

    Returns:
        (effective_id, effective_visibility)
    """
    effective_id = service_id
    # Always add a random suffix unless user provided a custom ID
    if service_id == "py-debugger":
        effective_id = f"py-debugger-{secrets.token_hex(16)}"
    effective_visibility = visibility or ("protected" if require_token else "unlisted")
    return effective_id, effective_visibility


async def start_debugger(
    server_url: str,
    workspace: str = "",
    token: str = "",
    service_id: str = "py-debugger",
    service_name: str = "Python Debugger",
    visibility: str = "",
    require_token: bool = False,
) -> DebugSession:
    """Start the Hypha debugger (async).

    Connects to a Hypha server and registers a debug service that remote
    clients can use to inspect and interact with this Python process.

    By default, the service is registered as "unlisted" with a unique random
    service ID. The URL itself is unguessable — no token needed. Just keep
    the URL secret.

    Args:
        server_url: Hypha server URL (required).
        workspace: Workspace name (auto-assigned if empty).
        token: Authentication token for connecting to Hypha.
        service_id: Service ID to register as. A random suffix is added by default.
        service_name: Human-readable service name.
        visibility: Service visibility override ("public", "protected", "unlisted").
        require_token: Whether to generate a JWT token for remote callers (default False).

    Returns:
        A DebugSession with service_id, workspace, server, service_url, and token.
    """
    from hypha_rpc import connect_to_server

    effective_id, effective_visibility = _resolve_id_and_visibility(
        service_id, visibility, require_token
    )

    connect_config = {"server_url": server_url}
    if workspace:
        connect_config["workspace"] = workspace
    if token:
        connect_config["token"] = token

    server = await connect_to_server(connect_config)

    service = {
        "name": service_name,
        "id": effective_id,
        "type": "debugger",
        "description": (
            "Remote Python process debugger. Allows inspecting variables, "
            "executing code, browsing files, and getting process information."
        ),
        "config": {
            "visibility": effective_visibility,
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
        "write_file": write_file,
        "get_source": get_source,
        "get_skill_md": get_skill_md,
    }

    svc_info = await server.register_service(service)
    actual_id = svc_info.get("id", effective_id) if isinstance(svc_info, dict) else effective_id
    ws = server.config.get("workspace", workspace) if hasattr(server.config, "get") else getattr(server.config, "workspace", workspace)

    # Generate a token for remote access (24h expiry) only if requested.
    session_token = ""
    if require_token:
        session_token = await server.generate_token({"expires_in": 86400})

    # Build the HTTP service URL
    service_url = _build_service_url(server_url, actual_id)

    logger.info(
        "Debugger connected: server=%s workspace=%s service=%s",
        server_url,
        ws,
        actual_id,
    )
    _print_session_info(server_url, service_url, session_token)

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
    visibility: str = "",
    require_token: bool = False,
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

    effective_id, effective_visibility = _resolve_id_and_visibility(
        service_id, visibility, require_token
    )

    server = connect_to_server({"server_url": server_url, **({"workspace": workspace} if workspace else {}), **({"token": token} if token else {})})

    service = {
        "name": service_name,
        "id": effective_id,
        "type": "debugger",
        "description": (
            "Remote Python process debugger. Allows inspecting variables, "
            "executing code, browsing files, and getting process information."
        ),
        "config": {
            "visibility": effective_visibility,
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
        "write_file": write_file,
        "get_source": get_source,
        "get_skill_md": get_skill_md,
    }

    svc_info = server.register_service(service)
    actual_id = svc_info.get("id", effective_id) if isinstance(svc_info, dict) else effective_id
    ws = server.config.get("workspace", workspace) if hasattr(server.config, "get") else getattr(server.config, "workspace", workspace)

    # Generate a token for remote access (24h expiry) only if requested.
    session_token = ""
    if require_token:
        session_token = server.generate_token({"expires_in": 86400})

    # Build the HTTP service URL
    service_url = _build_service_url(server_url, actual_id)

    logger.info(
        "Debugger connected (sync): server=%s workspace=%s service=%s",
        server_url,
        ws,
        actual_id,
    )
    _print_session_info(server_url, service_url, session_token)

    return DebugSession(
        service_id=actual_id,
        workspace=ws,
        server=server,
        server_url=server_url,
        service_url=service_url,
        token=session_token,
    )
