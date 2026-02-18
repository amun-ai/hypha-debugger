"""Sync Python debugger example - debugger runs in background."""

from hypha_debugger import start_debugger_sync
import time

# Start the debugger in sync mode (runs in background)
session = start_debugger_sync(
    server_url="https://hypha.aicell.io",
    service_id="py-debugger",
)

print(f"\nDebugger is running in background!")
print(f"Service ID: {session.service_id}")
print(f"Workspace: {session.workspace}")
print(f"\nMain thread continues normally...")

# Your normal code continues here
my_data = {"items": [1, 2, 3], "status": "running"}
counter = 0

try:
    while True:
        counter += 1
        print(f"Main loop iteration {counter}...")
        time.sleep(5)
except KeyboardInterrupt:
    print("\nStopping...")
    session.destroy_sync()
