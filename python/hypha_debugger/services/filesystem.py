"""File system browsing and writing service."""

import os

try:
    from pydantic import Field
    from hypha_rpc.utils.schema import schema_function

    @schema_function
    def list_files(
        path: str = Field(
            default=".",
            description='Directory path (absolute or relative to CWD). Default: ".".',
        ),
        pattern: str = Field(
            default="",
            description='Glob pattern to filter files, e.g. "*.py".',
        ),
    ) -> dict:
        """List files and directories at the given path."""
        return _list_files_impl(path, pattern)

    @schema_function
    def read_file(
        path: str = Field(..., description="File path (absolute or relative to CWD)."),
        max_lines: int = Field(
            default=500,
            description="Maximum number of lines to read. Default: 500.",
        ),
        offset: int = Field(
            default=0,
            description="Number of lines to skip from the beginning. Default: 0.",
        ),
        encoding: str = Field(
            default="utf-8",
            description="File encoding. Default: utf-8.",
        ),
    ) -> dict:
        """Read a file. Returns the content as a string.

        Use offset and max_lines to paginate through large files.
        """
        return _read_file_impl(path, max_lines, offset, encoding)

    @schema_function
    def write_file(
        path: str = Field(..., description="File path (absolute or relative to CWD)."),
        content: str = Field(..., description="Content to write to the file."),
        mode: str = Field(
            default="w",
            description='Write mode: "w" to overwrite, "a" to append. Default: "w".',
        ),
        create_dirs: bool = Field(
            default=True,
            description="Create parent directories if they don't exist. Default: true.",
        ),
        encoding: str = Field(
            default="utf-8",
            description="File encoding. Default: utf-8.",
        ),
    ) -> dict:
        """Write content to a file.

        Creates parent directories automatically. Use mode="a" to append.
        """
        return _write_file_impl(path, content, mode, create_dirs, encoding)

except ImportError:

    def list_files(path: str = ".", pattern: str = "") -> dict:
        """List files and directories at the given path."""
        return _list_files_impl(path, pattern)

    def read_file(
        path: str = "", max_lines: int = 500, offset: int = 0, encoding: str = "utf-8"
    ) -> dict:
        """Read a file."""
        return _read_file_impl(path, max_lines, offset, encoding)

    def write_file(
        path: str = "", content: str = "", mode: str = "w",
        create_dirs: bool = True, encoding: str = "utf-8"
    ) -> dict:
        """Write content to a file."""
        return _write_file_impl(path, content, mode, create_dirs, encoding)


def _resolve(path: str) -> str:
    """Resolve path to absolute."""
    return os.path.realpath(os.path.expanduser(path))


def _list_files_impl(path: str, pattern: str) -> dict:
    resolved = _resolve(path)

    if not os.path.isdir(resolved):
        return {"error": f"Not a directory: {path}"}

    entries = []
    try:
        if pattern:
            import fnmatch

            for name in sorted(os.listdir(resolved)):
                if fnmatch.fnmatch(name, pattern) or os.path.isdir(
                    os.path.join(resolved, name)
                ):
                    full = os.path.join(resolved, name)
                    entries.append(_entry_info(name, full))
        else:
            for name in sorted(os.listdir(resolved)):
                full = os.path.join(resolved, name)
                entries.append(_entry_info(name, full))
    except PermissionError:
        return {"error": f"Permission denied: {path}"}

    return {
        "path": resolved,
        "entries": entries[:500],
        "total": len(entries),
    }


def _entry_info(name: str, full_path: str) -> dict:
    is_dir = os.path.isdir(full_path)
    info = {
        "name": name,
        "type": "directory" if is_dir else "file",
    }
    if not is_dir:
        try:
            info["size"] = os.path.getsize(full_path)
        except OSError:
            info["size"] = -1
    return info


def _read_file_impl(path: str, max_lines: int, offset: int, encoding: str) -> dict:
    resolved = _resolve(path)

    if not os.path.isfile(resolved):
        return {"error": f"Not a file: {path}"}

    try:
        with open(resolved, "r", encoding=encoding, errors="replace") as f:
            lines = []
            for i, line in enumerate(f):
                if i < offset:
                    continue
                if len(lines) >= max_lines:
                    break
                lines.append(line)
        content = "".join(lines)
        return {
            "path": resolved,
            "content": content,
            "lines_read": len(lines),
            "offset": offset,
            "truncated": len(lines) >= max_lines,
        }
    except Exception as e:
        return {"error": f"Failed to read file: {e}"}


def _write_file_impl(
    path: str, content: str, mode: str, create_dirs: bool, encoding: str
) -> dict:
    if mode not in ("w", "a"):
        return {"error": f'Invalid mode: {mode}. Use "w" or "a".'}

    resolved = _resolve(path)

    try:
        if create_dirs:
            parent = os.path.dirname(resolved)
            if parent:
                os.makedirs(parent, exist_ok=True)

        with open(resolved, mode, encoding=encoding) as f:
            f.write(content)

        return {
            "path": resolved,
            "bytes_written": len(content.encode(encoding)),
            "mode": mode,
        }
    except Exception as e:
        return {"error": f"Failed to write file: {e}"}
