"""Prepare the owner's chat: Hermes' gateway home and its Hindsight memory server.

Nothing here is a second Hermes or a second memory. It writes the files Hermes and Hindsight
read themselves, with their own installers and setup functions where they exist:

* data/hermes-gateway   - the Hermes home: config.yaml, .env, SOUL.md, the partner-desk plugin,
                          the Hindsight client Hermes pins, the memory provider settings;
* data/hindsight/venv   - Hindsight as a local server in its own environment, so the pinned
                          Hermes environment (.venv) is never changed by it.

Safe to run again: existing values the owner set are kept, secrets are never printed.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HOME = ROOT / "data" / "hermes-gateway"
MEMORY = ROOT / "data" / "hindsight" / "venv"
# Hindsight release and the newest publication date any of its dependencies may have. Both are the
# state verified on 2026-11-25; a release is taken only once it is at least a week old.
MEMORY_VERSION, MEMORY_NOT_NEWER_THAN = "1.2.1", "2026-11-18T00:00:00Z"
MEMORY_PROFILE, MEMORY_PORT = "harnes2", 8890
# Memory extraction is many small calls: a fast model, two at a time, on the same local route.
MEMORY_MODEL = "gemini-3-flash"
# The partner's own browser (owner decision, 2026-11-25: a browser with full access and his own
# YOVI account, no technical locks). Hermes attaches to a dedicated Chrome window with its own
# profile, started by scripts/partner-chat.ps1; the owner signs in there himself.
BROWSER_PORT = 9222
# The same Hermes switches the partner's desk runs use (adapters/hermes/runner.py): he has no
# terminal and no files, so Hermes' guidance for coding agents is off. Memory and his browser stay on.
AGENT = {"tool_use_enforcement": False, "execution_guidance": False, "task_completion_guidance": False,
         "parallel_tool_call_guidance": False, "environment_probe": False, "bot_mode_protocol": False, "coding_context": "off",
         "disabled_toolsets": ["terminal", "file", "code_execution", "computer_use", "delegation", "cronjob", "coding"]}
TOOLSETS = ["memory", "session_search", "todo", "clarify", "browser"]


def say(text: str) -> None:
    print(text, flush=True)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    return values


def write_env(path: Path, values: dict[str, str]) -> None:
    kept = [line for line in (path.read_text(encoding="utf-8-sig").splitlines() if path.is_file() else [])
            if line.split("=", 1)[0].strip() not in values]
    path.write_text("\n".join(kept + [f"{key}={value}" for key, value in values.items()]) + "\n", encoding="utf-8")


def merged(base: dict, extra: dict) -> dict:
    out = dict(base)
    for key, value in extra.items():
        out[key] = merged(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def runtime() -> dict:
    config = json.loads((ROOT / "config" / "default.json").read_text(encoding="utf-8"))["runtime"]
    local = ROOT / "config" / "local.json"
    if local.is_file():
        config = merged(config, json.loads(local.read_text(encoding="utf-8-sig")).get("runtime", {}))
    if not config.get("model") or not config.get("baseUrl"):
        sys.exit("Set runtime.model and runtime.baseUrl in config/local.json first (README.md).")
    return config


def gateway_env(project: dict[str, str]) -> dict[str, str]:
    """The bot and the one person it answers. Both come from the owner; nothing is guessed."""
    current = read_env(HOME / ".env")
    token = current.get("TELEGRAM_BOT_TOKEN") or project.get("PARTNER_OWNER_BOT_TOKEN", "")
    owner = current.get("TELEGRAM_ALLOWED_USERS") or project.get("PARTNER_OWNER_TELEGRAM_ID", "")
    if not token or not owner:
        sys.exit("The owner chat needs the owner's bot and the owner's Telegram id. Put PARTNER_OWNER_BOT_TOKEN "
                 "(from @BotFather) and PARTNER_OWNER_TELEGRAM_ID (a number) into .env and run this again.")
    if not all(part.strip().lstrip("-").isdigit() for part in owner.split(",")):
        sys.exit("PARTNER_OWNER_TELEGRAM_ID must be a numeric Telegram id.")
    key = project.get("PARTNER_MODEL_API_KEY", "")
    if not key:
        sys.exit("PARTNER_MODEL_API_KEY is missing in .env.")
    return {"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_ALLOWED_USERS": owner,
            # Hermes delivers its own notices to a home channel; the only place is the owner's chat.
            "TELEGRAM_HOME_CHANNEL": current.get("TELEGRAM_HOME_CHANNEL") or owner.split(",")[0].strip(),
            "PARTNER_MODEL_API_KEY": key, "HINDSIGHT_TIMEOUT": current.get("HINDSIGHT_TIMEOUT", "120")}


def write_config(model: dict) -> None:
    import yaml  # ships with Hermes

    path = HOME / "config.yaml"
    current = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else None
    python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    wanted = {
        # The key itself stays in .env; Hermes expands the reference.
        "model": {"default": model["model"], "provider": "custom", "base_url": model["baseUrl"], "api_key": "${PARTNER_MODEL_API_KEY}"},
        "platform_toolsets": {"telegram": TOOLSETS},
        "agent": AGENT,
        "tools": {"tool_search": {"enabled": "off"}},
        # backend "off" selects Hermes' built-in browser tools. Its default driver runs model-written
        # Python on this machine and is only offered together with a terminal, which he does not have.
        "browser": {"backend": "off", "cdp_url": f"http://127.0.0.1:{BROWSER_PORT}"},
        "checkpoints": {"enabled": False},
        "memory": {"provider": "hindsight"},
        # Hermes' first-message offer to "build a profile" of the user: the owner is not a new user.
        "onboarding": {"profile_build": "off"},
        "plugins": {"enabled": ["partner-desk"]},
        # The partner's own desk: the existing MCP adapter over the business service.
        "mcp_servers": {"desk": {"command": str(python), "args": [str(ROOT / "adapters" / "mcp" / "server.py")], "timeout": 90, "connect_timeout": 30}},
    }
    path.write_text(yaml.safe_dump(merged(current if isinstance(current, dict) else {}, wanted), allow_unicode=True, sort_keys=False), encoding="utf-8")


def body(path: Path) -> str:
    """A skill's text without its front matter."""
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("---"):
        text = text.split("---", 2)[2].strip()
    return text


def write_soul() -> None:
    """Who the partner is in this chat: his identity, how he talks with the owner, how he keeps his notebook."""
    parts = [(ROOT / "partner" / "identity.md").read_text(encoding="utf-8").strip(),
             body(ROOT / "partner" / "skills" / "owner-chat" / "SKILL.md"),
             body(ROOT / "partner" / "skills" / "notebook" / "SKILL.md")]
    (HOME / "SOUL.md").write_text("\n\n".join(parts) + "\n", encoding="utf-8")


def install_plugin() -> None:
    target = HOME / "plugins" / "partner-desk"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "plugin.yaml"):
        shutil.copyfile(HERE / "partner_desk" / name, target / name)


def memory_client() -> None:
    """The Hindsight client exactly as Hermes pins it, placed by Hermes' own installer next to the
    home (never into .venv), and the provider settings written by the provider itself."""
    os.environ["HERMES_HOME"] = str(HOME)
    os.environ["HERMES_LAZY_INSTALL_TARGET"] = str(HOME / "packages")
    sys.path.insert(0, str(ROOT / "runtime" / "hermes-agent"))
    import hermes_bootstrap  # noqa: F401  (puts the package folder on sys.path)
    from tools.lazy_deps import ensure
    from plugins.memory.hindsight import HindsightMemoryProvider

    ensure("memory.hindsight", prompt=False)
    # recall_sync: memories are looked up for the message being answered, including the first
    # one of a session, instead of for the previous message.
    wanted = {"mode": "local_external", "api_url": f"http://127.0.0.1:{MEMORY_PORT}", "bank_id": "hermes",
              "recall_budget": "mid", "timeout": 120, "recall_sync": True}
    path = HOME / "hindsight" / "config.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    # Only what is not set yet: a bank or a budget the owner chose stays his.
    HindsightMemoryProvider().save_config({key: value for key, value in wanted.items() if key not in current}, str(HOME))


def memory_server(model: dict, key: str) -> None:
    scripts = MEMORY / ("Scripts" if os.name == "nt" else "bin")
    python = scripts / ("python.exe" if os.name == "nt" else "python")
    if not (scripts / ("hindsight-embed.exe" if os.name == "nt" else "hindsight-embed")).exists():
        say(f"Installing Hindsight {MEMORY_VERSION} into its own environment (a few minutes the first time)...")
        if not python.exists():
            subprocess.run(["uv", "venv", str(MEMORY), "--python", "3.11"], check=True)
        subprocess.run(["uv", "pip", "install", "--python", str(python), "--exclude-newer", MEMORY_NOT_NEWER_THAN,
                        "--compile-bytecode", f"hindsight-all=={MEMORY_VERSION}"], check=True)
    # The profile is created through Hindsight's own profile manager; the key travels on stdin,
    # not on a command line. An existing profile is the owner's and is left as it is.
    settings = {"HINDSIGHT_API_LLM_PROVIDER": "openai", "HINDSIGHT_API_LLM_BASE_URL": model["baseUrl"], "HINDSIGHT_API_LLM_API_KEY": key,
                "HINDSIGHT_API_LLM_MODEL": MEMORY_MODEL, "HINDSIGHT_API_LLM_MAX_CONCURRENT": "2",
                # The owner writes in Russian: multilingual embeddings and Russian text search.
                "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "onnx", "HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE": "russian"}
    code = ("import json,sys\nfrom hindsight_embed.profile_manager import ProfileManager\n"
            "request=json.load(sys.stdin); manager=ProfileManager(); exists=manager.profile_exists(request['name'])\n"
            "exists or manager.create_profile(request['name'], request['port'], request['settings'])\n"
            "print('kept' if exists else 'created')")
    result = subprocess.run([str(python), "-c", code], input=json.dumps({"name": MEMORY_PROFILE, "port": MEMORY_PORT, "settings": settings}),
                            capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        sys.exit("Hindsight profile setup failed (details withheld: they may contain the key).")
    say(f"Memory profile '{MEMORY_PROFILE}': {result.stdout.strip().splitlines()[-1]}.")


def main() -> None:
    model, project = runtime(), read_env(ROOT / ".env")
    HOME.mkdir(parents=True, exist_ok=True)
    env = gateway_env(project)
    write_env(HOME / ".env", env)
    write_config(model)
    write_soul()
    install_plugin()
    say("Hermes home: data/hermes-gateway (config, identity, partner-desk plugin).")
    memory_client()
    say("Hindsight client: the version Hermes pins, in data/hermes-gateway/packages.")
    # The memory server is installed once per machine; a second checkout reuses it.
    if "--no-memory-server" in sys.argv:
        say("Memory server: left as it is (--no-memory-server).")
    else:
        memory_server(model, env["PARTNER_MODEL_API_KEY"])
    say("Ready. Start the chat with START-PARTNER-CHAT.bat (or: npm run chat:start).")


if __name__ == "__main__":
    main()
