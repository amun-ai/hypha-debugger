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
import sys
import urllib.error
import urllib.request

__all__ = ["main"]


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
        with urllib.request.urlopen(req, timeout=http_timeout) as resp:
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


def cmd_sh(args: list, bare: bool = False) -> int:
    if bare:
        opts, command_parts = {"profile": "", "timeout": None, "cwd": ""}, args
    else:
        opts, command_parts = _extract_opts(args)
    command = " ".join(command_parts).strip()
    if not command:
        raise CliError("nothing to run. Usage: hyd sh '<command>'")
    _name, profile = _resolve_profile(opts["profile"])
    cwd = opts["cwd"] or _env_cwd()
    timeout = opts["timeout"] if opts["timeout"] is not None else 30
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


def cmd_py(args: list) -> int:
    opts, code_parts = _extract_opts(args)
    code = " ".join(code_parts).strip()
    if not code:
        raise CliError("nothing to run. Usage: hyd py '<python code>'")
    _name, profile = _resolve_profile(opts["profile"])
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
        if a in ("--token", "--workspace") and i + 1 < len(args):
            opts[a.lstrip("-")] = args[i + 1]; i += 2; continue
        pos.append(a); i += 1
    if len(pos) < 2:
        raise CliError("usage: hyd profile add <name> <service_url> [--token T] [--workspace W] [--use]")
    name, url = pos[0], _normalize_url(pos[1])
    profiles = _load_profiles()
    entry = profiles.get(name, {})
    entry["service_url"] = url
    if opts.get("token"):
        entry["token"] = opts["token"]
    if opts.get("workspace"):
        entry["workspace"] = opts["workspace"]
    profiles[name] = entry
    _save_profiles(profiles)
    if use:
        _emit_state({"HYD_PROFILE": name}, human=f"profile '{name}' -> {url} (now active)")
    else:
        # No current-state change → just confirm (eval-safe comment).
        print(f"# profile '{name}' -> {url}   (activate: export HYD_PROFILE={name})")
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
        print(f"{mark} {name}  {p.get('service_url', '')}{tok}")
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
    print(f"profile: {name}   cwd: {_env_cwd() or '(remote default)'}   (HYD_PROFILE/HYD_CWD)")
    print(f"url: {_normalize_url(profile['service_url'])}")
    try:
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
        """hyd — Hypha remote debugger CLI (run remote shell commands with minimal overhead)

USAGE
  hyd sh '<command>'            Run a shell command on the active profile (cwd via HYD_CWD)
  hyd '<command>'              Same (bare form; anything not a subcommand runs as a command)
  hyd py '<python>'            Run Python via the debugger's execute_code
  hyd -p <profile> sh '...'    Run against a specific profile (overrides HYD_PROFILE)

PROFILES (machines — stored on disk)
  hyd profile add <name> <service_url> [--token T] [--workspace W] [--use]
  hyd profile list | show <name> | rm <name>

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
        if cmd in ("sh", "run", "exec"):
            return cmd_sh(argv[1:])
        if cmd == "py":
            return cmd_py(argv[1:])
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
        # Bare fallback: the whole argv is a shell command.
        return cmd_sh(argv, bare=True)
    except CliError as e:
        sys.stderr.write(f"hyd: {e}\n")
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
