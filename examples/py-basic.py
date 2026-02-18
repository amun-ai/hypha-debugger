"""Basic Python debugger example (async)."""

import asyncio
from hypha_debugger import start_debugger


async def main():
    # Start the debugger - it connects to Hypha and registers the service
    session = await start_debugger(
        server_url="https://hypha.aicell.io",
        service_id="py-debugger",
    )

    print(f"\nDebugger is running!")
    print(f"Service ID: {session.service_id}")
    print(f"Workspace: {session.workspace}")
    print(f"\nRemote clients can now connect and debug this process.")
    print(f"Press Ctrl+C to stop.\n")

    # Example: define some variables for remote inspection
    my_data = {"name": "Alice", "scores": [95, 87, 91]}
    counter = 0

    # Keep running
    await session.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
