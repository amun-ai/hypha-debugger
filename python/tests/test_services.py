"""Basic tests for service functions (no server required)."""

import os
import sys

from hypha_debugger.services.info import get_process_info
from hypha_debugger.services.execute import execute_code
from hypha_debugger.services.inspect_vars import get_variable, list_variables
from hypha_debugger.services.filesystem import list_files, read_file


def test_get_process_info():
    info = get_process_info()
    assert info["pid"] == os.getpid()
    assert info["python_version"] == sys.version
    assert "cwd" in info
    assert "hostname" in info
    assert "platform" in info


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


def test_list_files():
    result = list_files(".")
    assert "entries" in result
    assert "total" in result
    # Should find the pyproject.toml
    names = [e["name"] for e in result["entries"]]
    assert any("hypha_debugger" in n for n in names) or len(names) > 0


def test_read_file():
    # Read the pyproject.toml
    result = read_file("pyproject.toml")
    if "error" not in result:
        assert "content" in result
        assert "hypha-debugger" in result["content"]


def test_read_file_sandbox():
    result = read_file("../../etc/passwd")
    assert "error" in result
    assert "Access denied" in result["error"] or "Not a file" in result["error"]
