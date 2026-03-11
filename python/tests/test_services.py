"""Basic tests for service functions (no server required)."""

import os
import sys
import tempfile

from hypha_debugger.services.info import get_process_info, get_installed_packages
from hypha_debugger.services.execute import execute_code
from hypha_debugger.services.inspect_vars import get_variable, list_variables, get_stack_trace
from hypha_debugger.services.filesystem import list_files, read_file, write_file


def test_get_process_info():
    info = get_process_info()
    assert info["pid"] == os.getpid()
    assert info["python_version"] == sys.version
    assert "cwd" in info
    assert "hostname" in info
    assert "platform" in info


def test_get_installed_packages():
    pkgs = get_installed_packages()
    assert isinstance(pkgs, list)
    assert len(pkgs) > 0
    # Should find hypha-debugger itself
    names = [p["name"].lower() for p in pkgs]
    assert "hypha-debugger" in names


def test_get_installed_packages_filter():
    pkgs = get_installed_packages("hypha")
    names = [p["name"].lower() for p in pkgs]
    assert all("hypha" in n for n in names)


# --- execute_code ---

def test_execute_code_expression():
    result = execute_code("1 + 2")
    assert result["ok"] is True
    assert result["result"] == 3
    assert result["result_type"] == "int"
    assert result.get("error") is None


def test_execute_code_statement():
    result = execute_code("x = 42\nprint(x)")
    assert result["ok"] is True
    assert "42" in result["stdout"]
    assert result.get("error") is None


def test_execute_code_error():
    result = execute_code("1 / 0")
    assert result["ok"] is False
    assert "error" in result
    assert "ZeroDivisionError" in result["error"]
    assert result["error_type"] == "ZeroDivisionError"


def test_execute_code_syntax_error():
    result = execute_code("def")
    assert result["ok"] is False
    assert result["error_type"] == "SyntaxError"


def test_execute_code_import():
    result = execute_code("import json; print(json.dumps({'a': 1}))")
    assert '{"a": 1}' in result["stdout"]
    assert result.get("error") is None


def test_execute_code_multiline():
    """AST parsing captures the last expression's value."""
    code = """
def greet(name):
    return f"Hello, {name}!"
greet("World")
"""
    result = execute_code(code)
    assert result["ok"] is True
    assert result["result"] == "Hello, World!"


def test_execute_code_multiline_no_trailing_expr():
    """Multi-statement code with no trailing expression returns None."""
    code = "a = 1\nb = 2"
    result = execute_code(code)
    assert result["ok"] is True
    assert result["result"] is None


def test_execute_code_persistent_namespace():
    """Variables persist across calls in the default REPL namespace."""
    execute_code("repl_test_var = 42")
    result = execute_code("repl_test_var + 8")
    assert result["ok"] is True
    assert result["result"] == 50


def test_execute_code_timeout():
    """Test that timeout parameter works (execution should not hang)."""
    result = execute_code("'done'", timeout=5)
    assert result["ok"] is True
    assert result["result"] == "done"
    assert result.get("error") is None


def test_execute_code_stdout_capture():
    result = execute_code("print('hello'); print('world')")
    assert result["ok"] is True
    assert "hello" in result["stdout"]
    assert "world" in result["stdout"]


def test_execute_code_stderr_capture():
    result = execute_code("import sys; print('err', file=sys.stderr)")
    assert result["ok"] is True
    assert "err" in result["stderr"]


def test_execute_code_result_repr():
    result = execute_code("[1, 2, 3]")
    assert result["ok"] is True
    assert result["result"] == [1, 2, 3]
    assert result["result_repr"] is not None


# --- inspect_vars ---

def test_get_variable():
    result = get_variable("sys", namespace="hypha_debugger.services.inspect_vars")
    assert result["name"] == "sys"
    assert result["type"] == "module"


def test_get_variable_not_found():
    result = get_variable("nonexistent_variable_xyz")
    assert "error" in result


def test_list_variables():
    result = list_variables(namespace="hypha_debugger.services.info")
    names = [v["name"] for v in result]
    assert "get_process_info" in names


def test_get_stack_trace():
    traces = get_stack_trace()
    assert isinstance(traces, list)
    assert len(traces) > 0
    assert "thread_id" in traces[0]
    assert "thread_name" in traces[0]
    assert "stack" in traces[0]


# --- filesystem ---

def test_list_files():
    result = list_files(".")
    assert "entries" in result
    assert "total" in result
    names = [e["name"] for e in result["entries"]]
    assert any("hypha_debugger" in n for n in names) or len(names) > 0


def test_list_files_pattern():
    result = list_files(".", pattern="*.toml")
    names = [e["name"] for e in result["entries"]]
    assert "pyproject.toml" in names


def test_read_file():
    result = read_file("pyproject.toml")
    if "error" not in result:
        assert "content" in result
        assert "hypha-debugger" in result["content"]


def test_read_file_with_offset():
    result = read_file("pyproject.toml", offset=1, max_lines=2)
    assert result.get("error") is None
    assert result["offset"] == 1
    assert result["lines_read"] <= 2


def test_read_file_absolute():
    """Can read files by absolute path."""
    import pathlib
    toml_path = str(pathlib.Path("pyproject.toml").resolve())
    result = read_file(toml_path)
    assert result.get("error") is None
    assert "hypha-debugger" in result["content"]


def test_write_file():
    old_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)
        try:
            result = write_file("test_output.txt", "hello world")
            assert result.get("error") is None
            assert result["bytes_written"] == 11
            assert result["mode"] == "w"

            # Verify written content
            read_result = read_file("test_output.txt")
            assert read_result["content"] == "hello world"
        finally:
            os.chdir(old_cwd)


def test_write_file_append():
    old_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)
        try:
            write_file("append_test.txt", "first\n")
            write_file("append_test.txt", "second\n", mode="a")
            read_result = read_file("append_test.txt")
            assert "first" in read_result["content"]
            assert "second" in read_result["content"]
        finally:
            os.chdir(old_cwd)


def test_write_file_create_dirs():
    old_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)
        try:
            result = write_file("sub/dir/test.txt", "nested content")
            assert result.get("error") is None
            assert os.path.isfile(os.path.join(tmpdir, "sub", "dir", "test.txt"))
        finally:
            os.chdir(old_cwd)


def test_write_file_absolute():
    """Can write files by absolute path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        abs_path = os.path.join(tmpdir, "abs_test.txt")
        result = write_file(abs_path, "absolute write")
        assert result.get("error") is None
        assert result["bytes_written"] == 14
        read_result = read_file(abs_path)
        assert read_result["content"] == "absolute write"


def test_list_files_absolute():
    """Can list files by absolute path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a test file
        with open(os.path.join(tmpdir, "hello.txt"), "w") as f:
            f.write("hi")
        result = list_files(tmpdir)
        assert result.get("error") is None
        names = [e["name"] for e in result["entries"]]
        assert "hello.txt" in names


def test_write_file_invalid_mode():
    result = write_file("test.txt", "content", mode="x")
    assert "error" in result
    assert "Invalid mode" in result["error"]


# --- instruction block ---

def test_instruction_block_no_token():
    from hypha_debugger.debugger import _build_instruction_block
    block = _build_instruction_block("https://example.com/ws/services/py-debugger-abc")
    assert "SERVICE_URL=" in block
    assert "TOKEN=" not in block
    assert "Authorization" not in block
    assert "execute_code" in block
    assert "get_skill_md" in block


def test_instruction_block_with_token():
    from hypha_debugger.debugger import _build_instruction_block
    block = _build_instruction_block("https://example.com/ws/services/py-debugger", "mytoken123")
    assert 'TOKEN="mytoken123"' in block
    assert "Authorization" in block


# --- source ---

def test_get_source_list_modules():
    from hypha_debugger.services.source import get_source
    result = get_source("")
    assert "modules" in result
    assert "services.execute" in result["modules"]
    assert "services.filesystem" in result["modules"]
    assert "debugger" in result["modules"]


def test_get_source_module():
    from hypha_debugger.services.source import get_source
    result = get_source("services.execute")
    assert "source" in result
    assert "execute_code" in result["source"]
    assert result["lines"] > 10


def test_get_source_unknown():
    from hypha_debugger.services.source import get_source
    result = get_source("nonexistent")
    assert "error" in result
    assert "available" in result


def test_get_skill_md():
    from hypha_debugger.services.source import get_skill_md
    md = get_skill_md()
    assert isinstance(md, str)
    assert "execute_code" in md
    assert "write_file" in md
    assert "get_source" in md
    assert "get_skill_md" in md
    assert "SERVICE_URL" in md


def test_instruction_block_concise():
    from hypha_debugger.debugger import _build_instruction_block
    block = _build_instruction_block("https://example.com/ws/services/py-debugger-abc")
    assert "get_skill_md" in block
    # Should NOT have the verbose function list anymore
    assert "get_variable" not in block
    assert "list_files" not in block


def test_debug_session_print_instructions(capsys):
    from hypha_debugger.debugger import DebugSession
    session = DebugSession(
        service_id="test", workspace="test", server=None,
        service_url="https://example.com/ws/services/py-debugger-abc",
    )
    result = session.print_instructions()
    captured = capsys.readouterr()
    assert "WARNING" in captured.out
    assert "trusted" in captured.out
    assert "SERVICE_URL=" in captured.out
    assert isinstance(result, str)
    assert "SERVICE_URL=" in result
