"""The real Hermes workers, against a loopback stand-in for the model endpoint.

What is asserted is the request the provider would actually receive: it carries the partner's
own prompt and tools, and it does not carry Hermes' host/terminal environment block.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from test_request_budget import _LOOPBACK_ONLY_BOOTSTRAP

ROOT = Path(__file__).resolve().parents[1]
MODEL = {"provider": "custom", "apiMode": "chat_completions", "model": "offline-stub-model",
         "maxIterations": 2, "maxOutputTokens": 32, "timeoutSeconds": 15}
HOST_BLOCK = ("Hermes runtime environment", "User home directory", "Current working directory", "`terminal` tool")


def run_worker(script, envelope_for, home_parent):
    """Run one worker in a child process and return (stdout JSON, generation request bodies, home used)."""
    bodies = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            payload = json.dumps({"models": [{"id": "offline-stub-model", "key": "offline-stub-model", "loaded_instances": []}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path.endswith("/api/show"):
                self.send_error(404); return
            bodies.append(json.loads(body))
            chunk = lambda delta, finish=None: {"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1,
                                                "model": "offline-stub-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            chunks = [chunk({"role": "assistant"}), chunk({"content": "ok"}), chunk({}, "stop"),
                      {"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1, "model": "offline-stub-model", "choices": [],
                       "usage": {"prompt_tokens": 17, "completion_tokens": 1, "total_tokens": 18}}]
            stream = ("".join("data: " + json.dumps(item) + "\n\n" for item in chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(stream))); self.end_headers(); self.wfile.write(stream)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    run_id = str(uuid.uuid4())
    hermes_home = (ROOT / home_parent / run_id)
    command = [sys.executable, "-c", _LOOPBACK_ONLY_BOOTSTRAP
               + f"\nimport sys, runpy; sys.path.insert(0, {str((ROOT / script).parent)!r}); runpy.run_path({str(ROOT / script)!r}, run_name='__main__')"]
    safe_env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
    try:
        with tempfile.TemporaryDirectory(prefix="harnes-prompt-scope-home-") as isolated_home:
            safe_env.update({"PARTNER_MODEL_API_KEY": "offline-test-key", "PARTNER_RUN_TOKEN": "offline-run-token",
                             "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "HOME": isolated_home,
                             "USERPROFILE": isolated_home, "APPDATA": isolated_home, "LOCALAPPDATA": isolated_home})
            completed = subprocess.run(command, input=json.dumps(envelope_for(run_id, server.server_port)), text=True,
                                       encoding="utf-8", capture_output=True, timeout=60, env=safe_env, cwd=str(ROOT), check=False)
            if completed.returncode != 0:
                raise AssertionError((completed.stderr + completed.stdout)[-1200:])
            return json.loads(completed.stdout), bodies, isolated_home
    finally:
        server.shutdown(); thread.join(timeout=5); server.server_close()
        resolved = hermes_home.resolve()
        if resolved.parent == (ROOT / home_parent).resolve() and resolved.exists():
            shutil.rmtree(resolved)


def system_text(body):
    return "\n".join(message["content"] for message in body["messages"] if message["role"] == "system" and isinstance(message["content"], str))


class PromptScopeTests(unittest.TestCase):
    def assert_no_host_block(self, bodies, home):
        self.assertGreaterEqual(len(bodies), 1, "the worker reached the model endpoint")
        for body in bodies:
            text = system_text(body)
            for fragment in (*HOST_BLOCK, home):
                self.assertNotIn(fragment, text)

    def test_partner_run_sends_its_own_prompt_and_tools_without_the_host_block(self):
        tool = {"name": "partner_list_work", "description": "Read existing tasks in this run's scope.",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}
        envelope = lambda run_id, port: {
            "run_id": run_id, "business_url": "http://127.0.0.1:9", "tools": [tool],
            "model": {**MODEL, "baseUrl": f"http://127.0.0.1:{port}/v1"},
            "context": {"behavioral_examples": "OFFLINE-EXAMPLES: answer the question first.",
                        "skills": [{"name": "planning", "content": "OFFLINE-SKILL: plan the next useful step."},
                                   {"name": "partner-notebook", "content": "OFFLINE-NOTEBOOK: R-0001 [гипотеза] правило."}],
                        "task": {"title": "Offline prompt-scope check"}}}
        output, bodies, home = run_worker("adapters/hermes/runner.py", envelope, "data/runtime/hermes")
        self.assertTrue(output["completed"], output.get("error"))
        self.assertEqual(output["final_response"], "ok")
        self.assert_no_host_block(bodies, home)
        text = system_text(bodies[0])
        # Leaving the host block out must not cost the partner anything that is his.
        for kept in ("OFFLINE-EXAMPLES", "OFFLINE-SKILL", "OFFLINE-NOTEBOOK: R-0001 [гипотеза] правило.", "## Ты и владелец"):
            self.assertIn(kept, text)
        self.assertEqual([item["function"]["name"] for item in bodies[0]["tools"]], ["partner_list_work"])
        self.assertIn("Offline prompt-scope check", json.dumps(bodies[0]["messages"], ensure_ascii=False))

    def test_decision_worker_request_has_no_host_block_either(self):
        envelope = lambda run_id, port: {
            "run_id": run_id, "situation_id": "prompt-scope-local-stub", "tools": [],
            "model": {**MODEL, "baseUrl": f"http://127.0.0.1:{port}/v1", "maxApiCalls": 2},
            "context": {"packet": {"note": "offline"}, "exchanges": []},
            "system_prompt": "OFFLINE-DECISION: summarize the supplied evidence."}
        output, bodies, home = run_worker("scripts/situation_router_worker.py", envelope, "data/runtime/benchmarks/situation-router")
        self.assertTrue(output["completed"], output.get("error"))
        self.assert_no_host_block(bodies, home)
        self.assertIn("OFFLINE-DECISION", system_text(bodies[0]))
        self.assertFalse(bodies[0].get("tools"))


if __name__ == "__main__":
    unittest.main()
