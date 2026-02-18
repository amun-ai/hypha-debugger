"""Process information service."""

from hypha_debugger.utils.env import collect_process_info

try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def get_process_info() -> dict:
        """Get information about the current Python process including PID, CWD, Python version, hostname, platform, and memory usage."""
        return collect_process_info()

    @schema_function
    def get_installed_packages(
        filter: str = Field(
            default="",
            description='Optional substring filter for package names, e.g. "numpy".',
        ),
    ) -> list:
        """List installed Python packages (pip). Optionally filter by name substring."""
        import importlib.metadata

        packages = []
        for dist in importlib.metadata.distributions():
            name = dist.metadata["Name"]
            version = dist.metadata["Version"]
            if filter and filter.lower() not in name.lower():
                continue
            packages.append({"name": name, "version": version})
        packages.sort(key=lambda p: p["name"].lower())
        return packages

except ImportError:
    # Fallback without schema annotations
    def get_process_info() -> dict:
        """Get information about the current Python process."""
        return collect_process_info()

    def get_installed_packages(filter: str = "") -> list:
        """List installed Python packages."""
        import importlib.metadata

        packages = []
        for dist in importlib.metadata.distributions():
            name = dist.metadata["Name"]
            version = dist.metadata["Version"]
            if filter and filter.lower() not in name.lower():
                continue
            packages.append({"name": name, "version": version})
        packages.sort(key=lambda p: p["name"].lower())
        return packages
