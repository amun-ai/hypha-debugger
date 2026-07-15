"""Tests for the stateless remote shell service (no server required)."""

import os

from hypha_debugger.services.shell import execute_bash


def test_basic_stdout():
    r = execute_bash(command="echo hello")
    assert r["exit_code"] == 0
    assert "hello" in r["stdout"]


def test_exit_code_propagates():
    r = execute_bash(command="exit 3")
    assert r["exit_code"] == 3


def test_stderr_merged_into_stdout():
    r = execute_bash(command="echo oops >&2")
    assert "oops" in r["stdout"]


def test_cwd_reflected_after_cd():
    r = execute_bash(command="cd /tmp && pwd", cwd="")
    assert r["exit_code"] == 0
    assert os.path.realpath(r["cwd"]) == os.path.realpath("/tmp")


def test_cwd_argument_used():
    r = execute_bash(command="pwd", cwd="/tmp")
    assert os.path.realpath(r["stdout"].strip()) == os.path.realpath("/tmp")


def test_stateless_no_shared_process():
    # First call cd's within its own shell; the second (no cwd) must NOT inherit it.
    execute_bash(command="cd /tmp", cwd="")
    r = execute_bash(command="pwd", cwd="")
    assert os.path.realpath(r["stdout"].strip()) == os.path.realpath(os.getcwd())


def test_timeout_kills():
    r = execute_bash(command="sleep 5", timeout=1)
    assert r["exit_code"] == 124
    assert "timed out" in (r.get("error") or "").lower()


def test_env_exported():
    r = execute_bash(command="echo $FOO", env={"FOO": "bar"})
    assert "bar" in r["stdout"]
