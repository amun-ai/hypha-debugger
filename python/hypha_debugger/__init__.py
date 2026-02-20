"""
hypha-debugger: Injectable debugger for Python processes, powered by Hypha RPC.

Usage (async):
    from hypha_debugger import start_debugger
    session = await start_debugger(server_url="https://hypha.aicell.io")

Usage (sync):
    from hypha_debugger import start_debugger_sync
    session = start_debugger_sync(server_url="https://hypha.aicell.io")
"""

from hypha_debugger.debugger import start_debugger, start_debugger_sync, DebugSession

__version__ = "0.1.1"
__all__ = ["start_debugger", "start_debugger_sync", "DebugSession", "__version__"]
