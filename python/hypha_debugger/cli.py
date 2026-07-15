"""``hyd`` — client CLI for the Hypha remote debugger.

Lets an agent (or a human) run remote shell commands with almost no per-call
overhead: connection profiles (URL + token) are stored once on disk, and each
call is just ``hyd sh 'cmd'`` (or the bare ``hyd 'cmd'``).

The remote is STATELESS. The "current session" — which profile is active and the
current directory — is held in **environment variables** (``HYD_PROFILE`` and
``HYD_CWD``), NOT on disk. Because env vars are per-shell, every terminal is
naturally isolated: switching terminals does not carry the active profile/cwd.

  - ``profiles.json`` (disk, mode 0600) — the machines only: {profiles: {name: {service_url, token?, workspace?}}}
  - ``HYD_PROFILE`` (env) — the active profile for this shell
  - ``HYD_CWD``     (env) — the current remote directory for this shell

Commands that change the current state (``use``, ``cd``, ``profile add --use``)
print shell ``export`` lines (safe to ``eval``); ``eval "$(hyd shell-init)"``
installs a wrapper that applies them automatically and keeps ``HYD_CWD`` in sync
after every ``hyd sh``. See any debugger's ``GET <url>/get_skill_md``.
"""

import json
import os
import shlex
import ssl
import sys
import urllib.error
import urllib.request

__all__ = ["main"]


def _ssl_context() -> ssl.SSLContext:
    """A TLS context that verifies certs using certifi's CA bundle when available.

    Python's default context uses the system/OpenSSL trust store, which is often
    missing or unconfigured (macOS framework Python, minimal containers, fresh
    venvs) — causing CERTIFICATE_VERIFY_FAILED on HTTPS service URLs even though
    `curl` works. certifi (a transitive dep of hypha-rpc) fixes that portably.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_SSL_CTX = _ssl_context()


class CliError(Exception):
    pass


# ---- config (profile DEFINITIONS only — never current-state) -------------
def _config_dir() -> str:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        d = os.path.join(xdg, "hypha-debugger")
    else:
        legacy = os.path.expanduser("~/.hypha-debugger")
        d = legacy if os.path.isdir(legacy) else os.path.expanduser("~/.config/hypha-debugger")
    os.makedirs(d, exist_ok=True)
    return d


def _profiles_path() -> str:
    return os.path.join(_config_dir(), "profiles.json")


def _load_profiles() -> dict:
    try:
        with open(_profiles_path()) as f:
            return json.load(f).get("profiles", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_profiles(profiles: dict) -> None:
    path = _profiles_path()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"profiles": profiles}, f, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# ---- current state = environment variables -------------------------------
def _env_profile() -> str:
    return os.environ.get("HYD_PROFILE", "")


def _env_cwd() -> str:
    return os.environ.get("HYD_CWD", "")


def _emit_state(exports: dict, human: str = "") -> None:
    """Apply env changes. Under the shell wrapper (`$HYD_STATE_FILE` set) write
    export lines to that file for the parent shell to source; otherwise print
    eval-safe output (a `# comment` for humans + the `export` lines)."""
    lines = [f"export {k}={shlex.quote(str(v))}" for k, v in exports.items()]
    sf = os.environ.get("HYD_STATE_FILE")
    if sf:
        with open(sf, "a") as f:
            f.write("\n".join(lines) + "\n")
        if human:
            sys.stderr.write(human + "\n")
    else:
        if human:
            print("# " + human)
        for line in lines:
            print(line)


def _write_cwd(new_cwd: str) -> None:
    """After `hyd sh`, persist the new cwd to the shell (only via the wrapper's
    state file — never to stdout, which carries the command output)."""
    sf = os.environ.get("HYD_STATE_FILE")
    if sf and new_cwd:
        with open(sf, "a") as f:
            f.write(f"export HYD_CWD={shlex.quote(new_cwd)}\n")


# ---- resolution ----------------------------------------------------------
def _normalize_url(url: str) -> str:
    url = url.strip().rstrip("/")
    for suffix in ("/get_skill_md", "/get_page_info"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url.rstrip("/")


# ---- profile type (terminal vs browser) ----------------------------------
def _profile_type(profile: dict) -> str:
    return profile.get("type", "terminal")


def _infer_type(url: str) -> str:
    """Guess the profile type from the service id in the URL."""
    u = url.lower()
    if "web-navigator" in u or "web-debugger" in u or "navigator" in u:
        return "browser"
    return "terminal"


def _print_value(value) -> None:
    """Print a service result: strings verbatim, everything else as JSON."""
    if value is None:
        return
    if isinstance(value, str):
        sys.stdout.write(value if value.endswith("\n") else value + "\n")
    else:
        print(json.dumps(value, indent=2, default=str))


def _resolve_profile(explicit: str = "") -> tuple:
    """Return (name, profile_dict). Priority: -p flag > $HYD_PROFILE > sole profile."""
    profiles = _load_profiles()
    if not profiles:
        raise CliError("no profiles configured. Run: hyd profile add <name> <service_url> --use")
    name = explicit or _env_profile()
    if not name:
        if len(profiles) == 1:
            name = next(iter(profiles))
        else:
            raise CliError(
                "no active profile. Set one: `export HYD_PROFILE=<name>` (or `eval \"$(hyd use <name>)\"`, "
                f"or pass `-p <name>`). Profiles: {', '.join(profiles)}"
            )
    if name not in profiles:
        raise CliError(f"unknown profile '{name}'. Profiles: {', '.join(profiles) or '(none)'}")
    return name, profiles[name]


# ---- transport -----------------------------------------------------------
def _call_remote(profile: dict, fn: str, params: dict, http_timeout: int = 75) -> dict:
    url = _normalize_url(profile["service_url"]) + f"/{fn}?_mode=last"
    req = urllib.request.Request(url, data=json.dumps(params).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if profile.get("token"):
        req.add_header("Authorization", "Bearer " + profile["token"])
    try:
        with urllib.request.urlopen(req, timeout=http_timeout, context=_SSL_CTX) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise CliError(f"remote HTTP {e.code} calling {fn}: {body[:400]}")
    except urllib.error.URLError as e:
        raise CliError(f"cannot reach {url}: {e.reason}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"stdout": raw, "exit_code": 0, "cwd": params.get("cwd", "")}
    if isinstance(data, dict) and "detail" in data and "stdout" not in data and "exit_code" not in data:
        raise CliError(f"gateway error: {data['detail']} (is the debugger still connected?)")
    return data


# ---- run -----------------------------------------------------------------
def _extract_opts(args: list) -> tuple:
    """Pull -p/--profile, -t/--timeout, --cwd out of args; return (opts, rest)."""
    opts = {"profile": "", "timeout": None, "cwd": ""}
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-p", "--profile") and i + 1 < len(args):
            opts["profile"] = args[i + 1]; i += 2; continue
        if a in ("-t", "--timeout") and i + 1 < len(args):
            opts["timeout"] = int(args[i + 1]); i += 2; continue
        if a == "--cwd" and i + 1 < len(args):
            opts["cwd"] = args[i + 1]; i += 2; continue
        rest.append(a); i += 1
    return opts, rest


def _run_shell(profile: dict, command: str, cwd: str, timeout: int) -> int:
    data = _call_remote(
        profile, "execute_bash",
        {"command": command, "cwd": cwd, "timeout": timeout},
        http_timeout=(timeout or 60) + 15,
    )
    out = data.get("stdout", "")
    if out:
        sys.stdout.write(out if out.endswith("\n") else out + "\n")
    if data.get("error"):
        sys.stderr.write(f"hyd: {data['error']}\n")
    _write_cwd(data.get("cwd", cwd))  # keep cwd in sync (via the shell wrapper)
    return int(data.get("exit_code", 0) or 0)


def _run_js(profile: dict, code: str, timeout: int) -> int:
    data = _call_remote(profile, "execute_script", {"code": code}, http_timeout=(timeout or 60) + 15)
    if isinstance(data, dict):
        if data.get("error"):
            sys.stderr.write(f"hyd: {data['error']}\n")
            return 1
        # execute_script returns {result, type, ...}; print just the result.
        _print_value(data["result"] if "result" in data else data)
    else:
        _print_value(data)
    return 0


def cmd_run(args: list, bare: bool = False) -> int:
    """Type-adaptive run: shell on a terminal profile, JavaScript on a browser one."""
    if bare:
        opts, parts = {"profile": "", "timeout": None, "cwd": ""}, args
    else:
        opts, parts = _extract_opts(args)
    payload = " ".join(parts).strip()
    if not payload:
        raise CliError("nothing to run. Usage: hyd '<shell command or JS>'")
    name, profile = _resolve_profile(opts["profile"])
    timeout = opts["timeout"] if opts["timeout"] is not None else 30
    if _profile_type(profile) == "browser":
        return _run_js(profile, payload, timeout)
    return _run_shell(profile, payload, opts["cwd"] or _env_cwd(), timeout)


def cmd_sh(args: list) -> int:
    opts, parts = _extract_opts(args)
    command = " ".join(parts).strip()
    if not command:
        raise CliError("nothing to run. Usage: hyd sh '<command>'")
    name, profile = _resolve_profile(opts["profile"])
    if _profile_type(profile) == "browser":
        raise CliError(f"profile '{name}' is a browser profile — use `hyd js '<code>'` (or bare `hyd '<code>'`).")
    timeout = opts["timeout"] if opts["timeout"] is not None else 30
    return _run_shell(profile, command, opts["cwd"] or _env_cwd(), timeout)


def cmd_js(args: list) -> int:
    opts, parts = _extract_opts(args)
    code = " ".join(parts).strip()
    if not code:
        raise CliError("nothing to run. Usage: hyd js '<javascript>'")
    name, profile = _resolve_profile(opts["profile"])
    if _profile_type(profile) != "browser":
        raise CliError(f"profile '{name}' is a terminal profile — use `hyd sh '<command>'`.")
    timeout = opts["timeout"] if opts["timeout"] is not None else 30
    return _run_js(profile, code, timeout)


def cmd_call(args: list) -> int:
    """Generic passthrough: call any service function. `hyd call <fn> [--json '{...}'] [k=v ...]`."""
    opts, rest = _extract_opts(args)
    if not rest:
        raise CliError("usage: hyd call <function> [--json '{...}'] [key=value ...]")
    fn, params = rest[0], {}
    i = 1
    while i < len(rest):
        a = rest[i]
        if a == "--json" and i + 1 < len(rest):
            params.update(json.loads(rest[i + 1])); i += 2; continue
        if "=" in a:
            k, v = a.split("=", 1)
            params[k] = v; i += 1; continue
        i += 1
    _name, profile = _resolve_profile(opts["profile"])
    _print_value(_call_remote(profile, fn, params))
    return 0


def cmd_nav(args: list) -> int:
    if not args:
        raise CliError("usage: hyd nav <url>")
    name, profile = _resolve_profile()
    if _profile_type(profile) != "browser":
        raise CliError(f"profile '{name}' is not a browser profile.")
    _print_value(_call_remote(profile, "navigate", {"url": args[0]}))
    return 0


def cmd_shot(args: list) -> int:
    import base64
    name, profile = _resolve_profile()
    if _profile_type(profile) != "browser":
        raise CliError(f"profile '{name}' is not a browser profile.")
    data = _call_remote(profile, "take_screenshot", {})
    b64 = data.get("base64") or (data.get("data_url", "").split(",", 1)[-1] if data.get("data_url") else "")
    if not b64:
        raise CliError(f"no screenshot data: {data.get('error', data)}")
    path = args[0] if args else "screenshot.png"
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    print(path)
    return 0


def cmd_py(args: list) -> int:
    opts, code_parts = _extract_opts(args)
    code = " ".join(code_parts).strip()
    if not code:
        raise CliError("nothing to run. Usage: hyd py '<python code>'")
    name, profile = _resolve_profile(opts["profile"])
    if _profile_type(profile) == "browser":
        raise CliError(f"profile '{name}' is a browser profile — use `hyd js '<code>'`.")
    data = _call_remote(profile, "execute_code", {"code": code})
    if isinstance(data, dict):
        if data.get("stdout"):
            sys.stdout.write(data["stdout"])
        for key in ("result", "value"):
            if data.get(key) is not None:
                print(data[key]); break
        if data.get("error"):
            sys.stderr.write(f"hyd: {data['error']}\n"); return 1
    else:
        print(data)
    return 0


# ---- profiles ------------------------------------------------------------
def cmd_profile(args: list) -> int:
    if not args:
        return cmd_profile_list([])
    sub, rest = args[0], args[1:]
    if sub == "add":
        return cmd_profile_add(rest)
    if sub in ("list", "ls"):
        return cmd_profile_list(rest)
    if sub == "show":
        return cmd_profile_show(rest)
    if sub in ("rm", "remove", "delete"):
        return cmd_profile_rm(rest)
    raise CliError(f"unknown 'profile' subcommand: {sub}")


def cmd_profile_add(args: list) -> int:
    use = "--use" in args
    args = [a for a in args if a != "--use"]
    opts, pos = {}, []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--token", "--workspace", "--type") and i + 1 < len(args):
            opts[a.lstrip("-")] = args[i + 1]; i += 2; continue
        pos.append(a); i += 1
    if len(pos) < 2:
        raise CliError("usage: hyd profile add <name> <service_url> [--type terminal|browser] [--token T] [--use]")
    name, url = pos[0], _normalize_url(pos[1])
    ptype = opts.get("type")
    if ptype and ptype not in ("terminal", "browser"):
        raise CliError("--type must be 'terminal' or 'browser'")
    profiles = _load_profiles()
    entry = profiles.get(name, {})
    entry["service_url"] = url
    entry["type"] = ptype or entry.get("type") or _infer_type(url)
    if opts.get("token"):
        entry["token"] = opts["token"]
    if opts.get("workspace"):
        entry["workspace"] = opts["workspace"]
    profiles[name] = entry
    _save_profiles(profiles)
    label = f"{url} [{entry['type']}]"
    if use:
        _emit_state({"HYD_PROFILE": name}, human=f"profile '{name}' -> {label} (now active)")
    else:
        print(f"# profile '{name}' -> {label}   (activate: export HYD_PROFILE={name})")
    return 0


def cmd_profile_list(_args: list) -> int:
    profiles = _load_profiles()
    if not profiles:
        print("no profiles. Add one: hyd profile add <name> <service_url> --use")
        return 0
    active = _env_profile()
    for name, p in profiles.items():
        mark = "*" if name == active else " "
        tok = " (token)" if p.get("token") else ""
        print(f"{mark} {name}  [{_profile_type(p)}]  {p.get('service_url', '')}{tok}")
    return 0


def cmd_profile_show(args: list) -> int:
    if not args:
        raise CliError("usage: hyd profile show <name>")
    p = _load_profiles().get(args[0])
    if not p:
        raise CliError(f"unknown profile '{args[0]}'")
    shown = dict(p)
    if shown.get("token"):
        shown["token"] = shown["token"][:6] + "…"
    print(json.dumps({args[0]: shown}, indent=2))
    return 0


def cmd_profile_rm(args: list) -> int:
    if not args:
        raise CliError("usage: hyd profile rm <name>")
    profiles = _load_profiles()
    if args[0] not in profiles:
        raise CliError(f"unknown profile '{args[0]}'")
    del profiles[args[0]]
    _save_profiles(profiles)
    print(f"# removed profile '{args[0]}'")
    return 0


# ---- current state commands (emit env exports) ---------------------------
def cmd_use(args: list) -> int:
    if not args:
        raise CliError("usage: hyd use <profile>")
    name = args[0]
    if name not in _load_profiles():
        raise CliError(f"unknown profile '{name}'. Add it: hyd profile add {name} <service_url>")
    _emit_state({"HYD_PROFILE": name}, human=f"active profile -> {name}")
    return 0


def cmd_cd(args: list) -> int:
    target = args[0] if args else ""
    _emit_state({"HYD_CWD": target}, human=f"cwd -> {target or '(remote default)'}")
    return 0


def cmd_pwd(_args: list) -> int:
    print(_env_cwd() or "(remote default)")
    return 0


def cmd_status(_args: list) -> int:
    try:
        name, profile = _resolve_profile()
    except CliError as e:
        print(e); return 1
    ptype = _profile_type(profile)
    print(f"profile: {name} [{ptype}]   cwd: {_env_cwd() or '(remote default)'}   (HYD_PROFILE/HYD_CWD)")
    print(f"url: {_normalize_url(profile['service_url'])}")
    try:
        if ptype == "browser":
            info = _call_remote(profile, "get_page_info", {})
            print(f"connected: url={info.get('url')} title={info.get('title')}")
        else:
            info = _call_remote(profile, "get_process_info", {})
            print(f"connected: pid={info.get('pid')} host={info.get('hostname')} py={info.get('python_version')}")
    except CliError as e:
        print(f"UNREACHABLE: {e}"); return 1
    return 0


def cmd_shell_init(_args: list) -> int:
    print(
        "# hyd shell integration — add to your shell rc:  eval \"$(hyd shell-init)\"\n"
        "# Wraps hyd so `use`/`cd`/`profile add --use` update this shell's env and\n"
        "# `hyd sh` keeps HYD_CWD in sync. State lives in env vars (per-terminal), not on disk.\n"
        "hyd() {\n"
        "  local __f; __f=\"$(mktemp)\"\n"
        "  HYD_STATE_FILE=\"$__f\" command hyd \"$@\"; local __rc=$?\n"
        "  [ -s \"$__f\" ] && . \"$__f\"\n"
        "  rm -f \"$__f\"\n"
        "  return $__rc\n"
        "}"
    )
    return 0


def _print_help() -> int:
    print(
        """hyd — Hypha remote CLI: drive a terminal (Python process) OR a browser with minimal overhead

USAGE (adapts to the active profile's type)
  hyd '<x>'                    Bare: runs <x> as SHELL on a terminal profile, JAVASCRIPT on a browser one
  hyd sh '<command>'           Force a shell command (terminal profile; cwd via HYD_CWD)
  hyd js '<javascript>'        Force JavaScript (browser profile) — returns the result
  hyd py '<python>'            Run Python via execute_code (terminal profile)
  hyd call <fn> [--json '{…}'] [k=v …]   Call ANY service function (either type)
  hyd nav <url> | shot [file]  Browser: navigate / save a screenshot (PNG)
  hyd -p <profile> …           Run against a specific profile (overrides HYD_PROFILE)

PROFILES (machines — stored on disk; each has a type: terminal|browser)
  hyd profile add <name> <service_url> [--type terminal|browser] [--token T] [--use]
  hyd profile list | show <name> | rm <name>       (type inferred from the URL if omitted)

CURRENT STATE (env vars, per-terminal — NOT on disk)
  export HYD_PROFILE=<name>    Select the active profile for this shell
  export HYD_CWD=<dir>         Set the current remote directory for this shell
  hyd use <name>              Prints `export HYD_PROFILE=<name>` (eval it, or use the wrapper)
  hyd cd <dir> | pwd          Prints `export HYD_CWD=<dir>` / shows HYD_CWD
  hyd shell-init              Wrapper so use/cd/sh update this shell's env automatically
  hyd status                  Show active profile + cwd and ping the remote

Profiles: $XDG_CONFIG_HOME/hypha-debugger (or ~/.hypha-debugger). Setup docs:
GET <service_url>/get_skill_md."""
    )
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        return _print_help()
    cmd = argv[0]
    try:
        if cmd in ("help", "-h", "--help"):
            return _print_help()
        if cmd in ("version", "--version"):
            from hypha_debugger import __version__
            print(f"hyd (hypha-debugger) {__version__}")
            return 0
        if cmd in ("run", "exec"):
            return cmd_run(argv[1:])
        if cmd == "sh":
            return cmd_sh(argv[1:])
        if cmd == "js":
            return cmd_js(argv[1:])
        if cmd == "py":
            return cmd_py(argv[1:])
        if cmd == "call":
            return cmd_call(argv[1:])
        if cmd == "nav":
            return cmd_nav(argv[1:])
        if cmd == "shot":
            return cmd_shot(argv[1:])
        if cmd in ("profile", "profiles"):
            return cmd_profile(argv[1:] if cmd == "profile" else ["list"] + argv[1:])
        if cmd == "use":
            return cmd_use(argv[1:])
        if cmd == "cd":
            return cmd_cd(argv[1:])
        if cmd == "pwd":
            return cmd_pwd(argv[1:])
        if cmd == "status":
            return cmd_status(argv[1:])
        if cmd == "shell-init":
            return cmd_shell_init(argv[1:])
        # Bare fallback: run the whole argv, dispatching by profile type
        # (shell on a terminal profile, JavaScript on a browser one).
        return cmd_run(argv, bare=True)
    except CliError as e:
        sys.stderr.write(f"hyd: {e}\n")
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
