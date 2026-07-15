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


def test_type_inference_browser_and_terminal(cfg):
    cli.main(["profile", "add", "web", "https://h.io/services/web-navigator-abc"])
    cli.main(["profile", "add", "box", "https://h.io/services/py-debugger-xyz"])
    profs = cli._load_profiles()
    assert profs["web"]["type"] == "browser"
    assert profs["box"]["type"] == "terminal"


def test_type_explicit_override(cfg):
    cli.main(["profile", "add", "x", "https://h.io/services/anything", "--type", "browser"])
    assert cli._load_profiles()["x"]["type"] == "browser"


def test_bare_dispatches_by_type(cfg, monkeypatch):
    cli.main(["profile", "add", "web", "https://h.io/services/web-navigator-abc"])
    monkeypatch.setenv("HYD_PROFILE", "web")
    seen = {}
    monkeypatch.setattr(cli, "_call_remote", lambda profile, fn, params, http_timeout=75: seen.update(fn=fn, params=params) or {"result": "My Page", "type": "string"})
    rc = cli.main(["document.title"])  # bare, browser profile -> execute_script
    assert rc == 0 and seen["fn"] == "execute_script" and seen["params"]["code"] == "document.title"


def test_js_result_printed(cfg, monkeypatch, capsys):
    cli.main(["profile", "add", "web", "https://h.io/services/web-navigator-abc"])
    monkeypatch.setenv("HYD_PROFILE", "web")
    monkeypatch.setattr(cli, "_call_remote", lambda *a, **k: {"result": {"a": 1}, "type": "object"})
    cli.main(["js", "({a:1})"])
    assert '"a": 1' in capsys.readouterr().out


def test_sh_rejects_browser_profile(cfg, monkeypatch, capsys):
    cli.main(["profile", "add", "web", "https://h.io/services/web-navigator-abc"])
    monkeypatch.setenv("HYD_PROFILE", "web")
    rc = cli.main(["sh", "ls"])
    assert rc == 2 and "browser profile" in capsys.readouterr().err


def test_js_rejects_terminal_profile(cfg, monkeypatch, capsys):
    cli.main(["profile", "add", "box", "https://h.io/services/py-debugger-xyz"])
    monkeypatch.setenv("HYD_PROFILE", "box")
    rc = cli.main(["js", "1+1"])
    assert rc == 2 and "terminal profile" in capsys.readouterr().err


def test_call_generic_passthrough(cfg, monkeypatch):
    cli.main(["profile", "add", "web", "https://h.io/services/web-navigator-abc"])
    monkeypatch.setenv("HYD_PROFILE", "web")
    seen = {}
    monkeypatch.setattr(cli, "_call_remote", lambda profile, fn, params, http_timeout=75: seen.update(fn=fn, params=params) or {"ok": True})
    cli.main(["call", "navigate", "--json", '{"url":"https://x.com"}'])
    assert seen["fn"] == "navigate" and seen["params"]["url"] == "https://x.com"


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
