"""The owner's chat gateway pieces that are ours: the partner-desk plugin and the setup helpers.

Hermes itself is not under test here. What is asserted is what our thin layer sends to the local
business service around a chat turn, what it puts in front of the partner, and that the Hermes
home it prepares keeps the partner's boundaries (no terminal, no secrets in config).
"""
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
GATEWAY = ROOT / "adapters" / "hermes" / "owner_gateway"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Desk:
    """A loopback stand-in for the business service's /internal/chat/turn."""

    def __init__(self, sections):
        self.sections, self.calls, self.fail = sections, [], False
        desk = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                desk.calls.append({"path": self.path, "authorization": self.headers.get("Authorization"), **body})
                if desk.fail:
                    self.send_response(503); self.end_headers(); return
                answer = {"turn_id": body["turn_id"], "sections": desk.sections} if body["op"] == "begin" else {"turn_id": body["turn_id"], "closed": True}
                payload = json.dumps(answer).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.root = tempfile.TemporaryDirectory()
        runtime = Path(self.root.name) / "data" / "runtime"
        runtime.mkdir(parents=True)
        (runtime / "mcp-connection.json").write_text(json.dumps(
            {"url": f"http://127.0.0.1:{self.server.server_address[1]}", "token": "offline-desk-token"}), encoding="utf-8")

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.root.cleanup()


NOTEBOOK = {"key": "тетрадь", "marker": "[рабочий стол · тетрадь · aaaaaaaaaaaa]", "text": "[рабочий стол · тетрадь · aaaaaaaaaaaa]\n# Моя тетрадь\n- S-0001 чат взаимопиара"}
SITUATION = {"key": "обстановка", "marker": "[рабочий стол · обстановка · bbbbbbbbbbbb]", "text": "[рабочий стол · обстановка · bbbbbbbbbbbb]\n# Где мы сейчас"}


class PartnerDeskPlugin(unittest.TestCase):
    def setUp(self):
        self.desk = Desk([NOTEBOOK, SITUATION])
        self.addCleanup(self.desk.close)
        patcher = mock.patch.dict(os.environ, {"HARNES2_ROOT": self.desk.root.name})
        patcher.start(); self.addCleanup(patcher.stop)
        self.plugin = load("partner_desk_under_test", GATEWAY / "partner_desk" / "__init__.py")

    def test_registers_exactly_the_two_turn_hooks(self):
        hooks = []
        self.plugin.register(type("Ctx", (), {"register_hook": lambda self, name, fn: hooks.append(name)})())
        self.assertEqual(hooks, ["pre_llm_call", "post_llm_call"])

    def test_a_turn_is_opened_with_the_notebook_and_closed_after_the_answer(self):
        injected = self.plugin.begin_turn(session_id="s1", conversation_history=[], platform="telegram", turn_id="t1")
        self.assertEqual(injected, {"context": NOTEBOOK["text"] + "\n\n" + SITUATION["text"]})
        self.plugin.end_turn(session_id="s1", assistant_response="ok")
        self.assertEqual([(call["path"], call["op"], call["turn_id"]) for call in self.desk.calls],
                         [("/internal/chat/turn", "begin", "t1"), ("/internal/chat/turn", "end", "t1")])
        self.assertTrue(all(call["authorization"] == "Bearer offline-desk-token" for call in self.desk.calls))
        self.assertEqual(self.desk.calls[0]["session_id"], "s1")
        # Nothing is left open: a second end for the same session sends nothing.
        self.plugin.end_turn(session_id="s1")
        self.assertEqual(len(self.desk.calls), 2)

    def test_a_section_already_in_the_conversation_is_not_repeated_and_a_changed_one_is(self):
        history = [{"role": "user", "content": "привет", "api_content": "привет\n\n" + NOTEBOOK["text"] + "\n\n" + SITUATION["text"]},
                   {"role": "assistant", "content": "привет"}]
        self.assertIsNone(self.plugin.begin_turn(session_id="s1", conversation_history=history, platform="telegram", turn_id="t2"))
        self.assertEqual(self.desk.calls[-1]["op"], "begin", "the turn is opened even when nothing needs repeating")
        changed = dict(NOTEBOOK, marker="[рабочий стол · тетрадь · cccccccccccc]", text="[рабочий стол · тетрадь · cccccccccccc]\n# Моя тетрадь\n- J-0001")
        self.desk.sections = [changed, SITUATION]
        self.assertEqual(self.plugin.begin_turn(session_id="s1", conversation_history=history, platform="telegram", turn_id="t3"),
                         {"context": changed["text"]})
        # After a compaction the earlier text is gone from the conversation: everything is shown again.
        self.assertEqual(self.plugin.select_sections([changed, SITUATION], [{"role": "user", "content": "сжатая история"}]),
                         changed["text"] + "\n\n" + SITUATION["text"])

    def test_other_surfaces_and_review_forks_get_neither_the_notebook_nor_a_turn(self):
        self.assertIsNone(self.plugin.begin_turn(session_id="s1", conversation_history=[], platform="cli", turn_id="t1"))
        self.assertIsNone(self.plugin.begin_turn(session_id="s1-review", conversation_history=[], platform="telegram", parent_session_id="s1", turn_id="t1"))
        self.plugin.end_turn(session_id="s1")
        self.assertEqual(self.desk.calls, [])

    def test_when_the_service_is_down_the_partner_is_told_once_and_nothing_leaks(self):
        self.desk.fail = True
        first = self.plugin.begin_turn(session_id="s1", conversation_history=[], platform="telegram", turn_id="t1")
        self.assertEqual(first, {"context": self.plugin.UNAVAILABLE})
        for secret in ("offline-desk-token", self.desk.root.name, "127.0.0.1"):
            self.assertNotIn(secret, first["context"])
        again = self.plugin.begin_turn(session_id="s1", conversation_history=[{"role": "user", "content": "x", "api_content": "x\n\n" + self.plugin.UNAVAILABLE}],
                                       platform="telegram", turn_id="t2")
        self.assertIsNone(again)
        calls = len(self.desk.calls)
        self.plugin.end_turn(session_id="s1")
        self.assertEqual(len(self.desk.calls), calls, "a turn that never opened is not closed")


class GatewaySetup(unittest.TestCase):
    def setUp(self):
        self.setup = load("owner_gateway_setup_under_test", GATEWAY / "setup.py")
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch.object(self.setup, "HOME", Path(self.home.name))
        patcher.start(); self.addCleanup(patcher.stop)

    def test_the_chat_uses_the_same_hermes_switches_as_the_desk_runs(self):
        runner = (ROOT / "adapters" / "hermes" / "runner.py").read_text(encoding="utf-8")
        for key in ("tool_use_enforcement", "execution_guidance", "task_completion_guidance", "parallel_tool_call_guidance",
                    "environment_probe", "bot_mode_protocol"):
            self.assertIn(f"{key}: false", runner, key)
            self.assertIs(self.setup.AGENT[key], False, key)
        self.assertIn("coding_context: off", runner)
        self.assertEqual(self.setup.AGENT["coding_context"], "off")
        # The partner has no terminal, files, code, browser, cron or sub-agents in the chat.
        for toolset in ("terminal", "file", "code_execution", "browser", "computer_use", "delegation", "cronjob", "coding"):
            self.assertIn(toolset, self.setup.AGENT["disabled_toolsets"])
            self.assertNotIn(toolset, self.setup.TOOLSETS)

    def test_config_keeps_the_owners_additions_and_never_holds_the_key(self):
        import yaml

        path = Path(self.home.name) / "config.yaml"
        path.write_text(yaml.safe_dump({"display": {"language": "ru"}, "agent": {"max_turns": 40}}), encoding="utf-8")
        self.setup.write_config({"model": "invented-model", "baseUrl": "http://127.0.0.1:1/v1"})
        config = yaml.safe_load(path.read_text(encoding="utf-8"))
        self.assertEqual(config["display"], {"language": "ru"})
        self.assertEqual(config["agent"]["max_turns"], 40)
        self.assertEqual(config["model"], {"default": "invented-model", "provider": "custom", "base_url": "http://127.0.0.1:1/v1",
                                           "api_key": "${PARTNER_MODEL_API_KEY}"})
        self.assertEqual(config["platform_toolsets"]["telegram"], self.setup.TOOLSETS)
        self.assertEqual(config["plugins"]["enabled"], ["partner-desk"])
        self.assertEqual(config["memory"]["provider"], "hindsight")
        self.assertEqual(config["onboarding"]["profile_build"], "off")
        self.assertEqual(config["tools"]["tool_search"]["enabled"], "off")
        desk = config["mcp_servers"]["desk"]
        self.assertEqual(Path(desk["args"][0]), ROOT / "adapters" / "mcp" / "server.py")

    def test_env_values_lose_their_quotes_and_the_owner_is_required(self):
        env = Path(self.home.name) / "project.env"
        env.write_text('\ufeffPARTNER_MODEL_API_KEY="invented-key"\nPARTNER_OWNER_BOT_TOKEN=\'1:invented\'\n# comment\nPARTNER_OWNER_TELEGRAM_ID=42\n', encoding="utf-8")
        project = self.setup.read_env(env)
        self.assertEqual(project, {"PARTNER_MODEL_API_KEY": "invented-key", "PARTNER_OWNER_BOT_TOKEN": "1:invented", "PARTNER_OWNER_TELEGRAM_ID": "42"})
        made = self.setup.gateway_env(project)
        self.assertEqual((made["TELEGRAM_BOT_TOKEN"], made["TELEGRAM_ALLOWED_USERS"], made["TELEGRAM_HOME_CHANNEL"]), ("1:invented", "42", "42"))
        # No bot or no owner id means no chat: the gateway never starts open to whoever finds it.
        for missing in ("PARTNER_OWNER_BOT_TOKEN", "PARTNER_OWNER_TELEGRAM_ID"):
            with self.assertRaises(SystemExit):
                self.setup.gateway_env({key: value for key, value in project.items() if key != missing})
        with self.assertRaises(SystemExit):
            self.setup.gateway_env(dict(project, PARTNER_OWNER_TELEGRAM_ID="@someone"))
        # What the owner already set in the gateway's own .env wins over the project values.
        self.setup.write_env(Path(self.home.name) / ".env", {"TELEGRAM_BOT_TOKEN": "2:kept", "TELEGRAM_ALLOWED_USERS": "77"})
        kept = self.setup.gateway_env(project)
        self.assertEqual((kept["TELEGRAM_BOT_TOKEN"], kept["TELEGRAM_ALLOWED_USERS"]), ("2:kept", "77"))

    def test_the_identity_in_chat_is_the_partners_own_plus_how_he_talks_with_the_owner(self):
        self.setup.write_soul()
        soul = (Path(self.home.name) / "SOUL.md").read_text(encoding="utf-8")
        identity = (ROOT / "partner" / "identity.md").read_text(encoding="utf-8").strip()
        self.assertTrue(soul.startswith(identity))
        for heading in ("# Разговор с владельцем", "# Твоя тетрадь"):
            self.assertIn(heading, soul)
        self.assertNotIn("---\nname:", soul, "skill front matter is not part of who he is")
        self.assertLess(len(soul), 20000, "Hermes truncates a longer identity file")


if __name__ == "__main__":
    unittest.main()
