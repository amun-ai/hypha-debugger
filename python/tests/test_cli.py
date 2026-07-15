"""Tests for the `hyd` client CLI (profiles on disk, current state in env vars)."""

import pytest

from hypha_debugger import cli


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    for var in ("HYD_PROFILE", "HYD_CWD", "HYD_STATE_FILE"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


def test_profile_add_normalizes_url(cfg):
    assert cli.main(["profile", "add", "main", "https://h.io/services/x/get_skill_md"]) == 0
    profs = cli._load_profiles()
    assert profs["main"]["service_url"] == "https://h.io/services/x"


def test_profile_add_with_token_and_list(cfg, capsys):
    cli.main(["profile", "add", "main", "https://h.io/s/x", "--token", "secret"])
    assert cli._load_profiles()["main"]["token"] == "secret"
    cli.main(["profile", "list"])
    out = capsys.readouterr().out
    assert "main" in out and "(token)" in out


def test_profile_rm(cfg):
    cli.main(["profile", "add", "p", "https://h.io/s/x"])
    cli.main(["profile", "rm", "p"])
    assert "p" not in cli._load_profiles()


def test_use_emits_export_no_disk_state(cfg, capsys):
    cli.main(["profile", "add", "main", "https://h.io/s/x"])
    cli.main(["use", "main"])
    out = capsys.readouterr().out
    assert "export HYD_PROFILE=main" in out
    # No session/current-state file should exist on disk.
    assert not (cfg / "hypha-debugger" / "sessions").exists()


def test_cd_emits_export(cfg, capsys):
    cli.main(["cd", "/var/log"])
    assert "export HYD_CWD=/var/log" in capsys.readouterr().out


def test_resolve_profile_from_env(cfg, monkeypatch):
    cli.main(["profile", "add", "a", "https://a.io/s/1"])
    cli.main(["profile", "add", "b", "https://b.io/s/2"])
    monkeypatch.setenv("HYD_PROFILE", "b")
    name, prof = cli._resolve_profile()
    assert name == "b" and prof["service_url"].endswith("/s/2")


def test_resolve_profile_flag_overrides_env(cfg, monkeypatch):
    cli.main(["profile", "add", "a", "https://a.io/s/1"])
    cli.main(["profile", "add", "b", "https://b.io/s/2"])
    monkeypatch.setenv("HYD_PROFILE", "a")
    name, _ = cli._resolve_profile("b")
    assert name == "b"


def test_resolve_sole_profile_when_unset(cfg):
    cli.main(["profile", "add", "only", "https://o.io/s/1"])
    name, _ = cli._resolve_profile()
    assert name == "only"


def test_sh_calls_execute_bash_and_returns_exit_code(cfg, monkeypatch):
    cli.main(["profile", "add", "main", "https://h.io/s/x"])
    monkeypatch.setenv("HYD_PROFILE", "main")
    seen = {}

    def fake(profile, fn, params, http_timeout=75):
        seen["fn"] = fn
        seen["params"] = params
        return {"stdout": "hi\n", "exit_code": 7, "cwd": "/tmp"}

    monkeypatch.setattr(cli, "_call_remote", fake)
    rc = cli.main(["sh", "echo hi"])
    assert rc == 7
    assert seen["fn"] == "execute_bash"
    assert seen["params"]["command"] == "echo hi"


def test_sh_persists_cwd_via_state_file(cfg, monkeypatch, tmp_path):
    cli.main(["profile", "add", "main", "https://h.io/s/x"])
    monkeypatch.setenv("HYD_PROFILE", "main")
    sf = tmp_path / "state.sh"
    sf.write_text("")
    monkeypatch.setenv("HYD_STATE_FILE", str(sf))
    monkeypatch.setattr(cli, "_call_remote", lambda *a, **k: {"stdout": "", "exit_code": 0, "cwd": "/var"})
    cli.main(["sh", "pwd"])
    assert "export HYD_CWD=/var" in sf.read_text()


def test_sh_uses_env_cwd(cfg, monkeypatch):
    cli.main(["profile", "add", "main", "https://h.io/s/x"])
    monkeypatch.setenv("HYD_PROFILE", "main")
    monkeypatch.setenv("HYD_CWD", "/opt")
    seen = {}
    monkeypatch.setattr(cli, "_call_remote", lambda profile, fn, params, http_timeout=75: seen.update(params) or {"stdout": "", "exit_code": 0, "cwd": "/opt"})
    cli.main(["sh", "pwd"])
    assert seen["cwd"] == "/opt"


def test_bare_fallback_runs_as_command(cfg, monkeypatch):
    cli.main(["profile", "add", "main", "https://h.io/s/x"])
    monkeypatch.setenv("HYD_PROFILE", "main")
    seen = {}
    monkeypatch.setattr(cli, "_call_remote", lambda profile, fn, params, http_timeout=75: seen.update(params) or {"stdout": "", "exit_code": 0, "cwd": ""})
    cli.main(["ls", "-la"])
    assert seen["command"] == "ls -la"


def test_p_flag_selects_profile(cfg, monkeypatch):
    cli.main(["profile", "add", "a", "https://a.io/s/1"])
    cli.main(["profile", "add", "b", "https://b.io/s/2"])
    monkeypatch.setenv("HYD_PROFILE", "a")
    seen = {}

    def fake(profile, fn, params, http_timeout=75):
        seen["url"] = profile["service_url"]
        return {"stdout": "", "exit_code": 0, "cwd": ""}

    monkeypatch.setattr(cli, "_call_remote", fake)
    cli.main(["sh", "-p", "b", "hostname"])
    assert seen["url"].endswith("/s/2")
