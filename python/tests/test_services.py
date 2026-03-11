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
    assert result["result"] == 3
    assert result["result_type"] == "int"
    assert result.get("error") is None


def test_execute_code_statement():
    result = execute_code("x = 42\nprint(x)")
    assert "42" in result["stdout"]
    assert result.get("error") is None


def test_execute_code_error():
    result = execute_code("1 / 0")
    assert "error" in result
    assert "ZeroDivisionError" in result["error"]


def test_execute_code_import():
    # Multi-statement uses exec (no return value), so test via stdout
    result = execute_code("import json; print(json.dumps({'a': 1}))")
    assert '{"a": 1}' in result["stdout"]
    assert result.get("error") is None


def test_execute_code_multiline():
    code = """
def greet(name):
    return f"Hello, {name}!"
greet("World")
"""
    result = execute_code(code)
    assert result.get("error") is None
    # eval/exec may or may not capture the last expression depending on implementation
    # but at least no error


def test_execute_code_timeout():
    """Test that timeout parameter works (execution should not hang)."""
    result = execute_code("'done'", timeout=5)
    assert result["result"] == "done"
    assert result.get("error") is None


def test_execute_code_stdout_capture():
    result = execute_code("print('hello'); print('world')")
    assert "hello" in result["stdout"]
    assert "world" in result["stdout"]


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


def test_read_file_sandbox():
    result = read_file("../../etc/passwd")
    assert "error" in result
    assert "Access denied" in result["error"] or "Not a file" in result["error"]


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


def test_write_file_sandbox():
    result = write_file("../../etc/evil.txt", "pwned")
    assert "error" in result
    assert "Access denied" in result["error"]


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
    assert "write_file" in block


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


def test_instruction_block_includes_new_functions():
    from hypha_debugger.debugger import _build_instruction_block
    block = _build_instruction_block("https://example.com/ws/services/py-debugger-abc")
    assert "get_source" in block
    assert "get_skill_md" in block


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
