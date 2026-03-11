"""CLI entry point: python -m hypha_debugger

Starts a debugger session and prints instructions for remote access.
"""

import argparse
import asyncio
import signal
import sys

from hypha_debugger.debugger import start_debugger


def main():
    parser = argparse.ArgumentParser(
        prog="hypha-debugger",
        description="Start a Hypha debugger session for this Python process.",
    )
    parser.add_argument(
        "--server-url",
        default="https://hypha.aicell.io",
        help="Hypha server URL (default: https://hypha.aicell.io)",
    )
    parser.add_argument(
        "--workspace",
        default="",
        help="Workspace name (auto-assigned if omitted)",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Authentication token for connecting to Hypha",
    )
    parser.add_argument(
        "--service-id",
        default="py-debugger",
        help="Service ID to register as (default: py-debugger)",
    )
    parser.add_argument(
        "--service-name",
        default="Python Debugger",
        help="Human-readable service name (default: Python Debugger)",
    )
    parser.add_argument(
        "--require-token",
        action="store_true",
        help="Require a JWT token for remote access (default: URL-secret mode, no token needed)",
    )
    args = parser.parse_args()

    async def run():
        session = await start_debugger(
            server_url=args.server_url,
            workspace=args.workspace,
            token=args.token,
            service_id=args.service_id,
            service_name=args.service_name,
            require_token=args.require_token,
        )

        print()
        print("[hypha-debugger] Debugger is running. Press Ctrl+C to stop.")
        print()

        # Handle graceful shutdown
        stop = asyncio.Event()

        def _signal_handler():
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _signal_handler)

        await stop.wait()
        print("\n[hypha-debugger] Shutting down...")
        await session.destroy()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
