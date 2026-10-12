"""Scout's one-request worker authority, exercised through HTTPX request hooks."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
HERMES_ADAPTER = str(ROOT / "adapters" / "hermes")
if HERMES_ADAPTER not in sys.path:
    sys.path.insert(0, HERMES_ADAPTER)

from adapters.hermes.request_budget import RequestBudget, RequestBudgetExceeded
from scripts.situation_router_worker import request_budget_policy
from test_request_budget import _LOOPBACK_ONLY_BOOTSTRAP


def envelope(packet, *, max_iterations=2, max_api_calls=1):
    return {
        "context": {"packet": packet},
        "model": {"maxIterations": max_iterations, "maxApiCalls": max_api_calls},
    }


class ScoutBudgetPolicyTests(unittest.TestCase):
    def test_scout_metadata_selects_exactly_one_request_and_two_hermes_iterations(self):
        self.assertEqual(
            request_budget_policy(envelope({"scout_assessment_request": {"version": 1}})),
            ("scout_assessment", 1),
        )

    def test_followup_policy_remains_two_requests(self):
        self.assertEqual(
            request_budget_policy(envelope({"followup": {"version": 1}}, max_api_calls=2)),
            ("followup", 2),
        )

    def test_ordinary_packet_has_no_scoped_budget(self):
        self.assertIsNone(request_budget_policy(envelope({})))

    def test_scout_rejects_non_one_request_budgets_including_bool(self):
        for value in (0, 2, True, 1.0, "1", None):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                request_budget_policy(envelope({"scout_assessment_request": {}}, max_api_calls=value))

    def test_scout_requires_hermes_compatible_iteration_count(self):
        for value in (1, 3, True, 2.0, "2", None):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                request_budget_policy(envelope({"scout_assessment_request": {}}, max_iterations=value))

    def test_followup_and_scout_metadata_fail_closed_when_ambiguous(self):
        packet = {"followup": {"version": 1}, "scout_assessment_request": {"version": 1}}
        with self.assertRaises(RuntimeError):
            request_budget_policy(envelope(packet, max_api_calls=2))


class ScoutHookedRequestTests(unittest.TestCase):
    def test_sync_hook_counts_each_generation_request_before_dispatch(self):
        dispatched = []

        def transport(request):
            dispatched.append((request.method, request.url.path))
            return httpx.Response(200)

        budget = RequestBudget(1, model_requests_only=True)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(transport)) as client:
                client.get("https://stub.test/v1/models")
                client.post("https://stub.test/v1/chat/completions")
                # A retry or credential-rotation attempt is a second HTTP request,
                # even when it reuses the same client and logical model turn.
                with self.assertRaises(RequestBudgetExceeded):
                    client.post("https://stub.test/v1/chat/completions")

        self.assertEqual(dispatched, [
            ("GET", "/v1/models"),
            ("POST", "/v1/chat/completions"),
        ])
        self.assertEqual(budget.calls, 1)
        self.assertTrue(budget.exhausted)

    def test_async_hook_counts_each_generation_request_before_dispatch(self):
        dispatched = []

        async def run():
            async def transport(request):
                dispatched.append((request.method, request.url.path))
                return httpx.Response(200)

            budget = RequestBudget(1, model_requests_only=True)
            with budget.install():
                async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                    await client.get("https://stub.test/v1/models")
                    await client.post("https://stub.test/v1/chat/completions")
                    with self.assertRaises(RequestBudgetExceeded):
                        await client.post("https://stub.test/v1/chat/completions")
            return budget

        budget = asyncio.run(run())
        self.assertEqual(dispatched, [
            ("GET", "/v1/models"),
            ("POST", "/v1/chat/completions"),
        ])
        self.assertEqual(budget.calls, 1)
        self.assertTrue(budget.exhausted)


class ScoutWorkerRequestBudgetIntegrationTests(unittest.TestCase):
    def test_scout_worker_forwards_one_generation_request_to_loopback_provider(self):
        generation_paths = []
        answer = "No current evidence supports a new recommendation."

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"models": [{"id": "offline-scout-stub", "key": "offline-scout-stub",
                                                 "loaded_instances": []}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path.endswith("/api/show"):
                    self.send_error(404)
                    return
                generation_paths.append(self.path)
                response_id = f"chatcmpl-{len(generation_paths)}"
                chunks = [
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-scout-stub", "choices": [{"index": 0,
                     "delta": {"role": "assistant"}, "finish_reason": None}]},
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-scout-stub", "choices": [{"index": 0,
                     "delta": {"content": answer}, "finish_reason": None}]},
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-scout-stub", "choices": [{"index": 0,
                     "delta": {}, "finish_reason": "stop"}]},
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-scout-stub", "choices": [],
                     "usage": {"prompt_tokens": 11, "completion_tokens": 8, "total_tokens": 19}},
                ]
                body = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                        + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        run_id = str(uuid.uuid4())
        hermes_home = (ROOT / "data" / "runtime" / "benchmarks" / "situation-router" / run_id)
        command = [sys.executable, "-c", _LOOPBACK_ONLY_BOOTSTRAP +
                   "\nfrom scripts.situation_router_worker import main; main()"]
        scout_envelope = {
            "run_id": run_id,
            "situation_id": "scout-assessment-local-stub",
            "tools": [],
            "model": {
                "provider": "custom", "apiMode": "chat_completions",
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "model": "offline-scout-stub", "maxIterations": 2,
                "maxOutputTokens": 32, "timeoutSeconds": 15, "maxApiCalls": 1,
            },
            "context": {"packet": {"scout_assessment_request": {"version": 1}}, "evidence": []},
            "system_prompt": "Assess only the supplied evidence. State uncertainty plainly.",
        }
        safe_env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
                    if key in os.environ}
        try:
            with tempfile.TemporaryDirectory(prefix="harnes-scout-budget-home-") as isolated_home:
                safe_env.update({"PARTNER_MODEL_API_KEY": "offline-test-key", "PYTHONIOENCODING": "utf-8",
                                 "HOME": isolated_home, "USERPROFILE": isolated_home,
                                 "APPDATA": isolated_home, "LOCALAPPDATA": isolated_home})
                completed = subprocess.run(
                    command, input=json.dumps(scout_envelope), text=True, encoding="utf-8",
                    capture_output=True, timeout=45, env=safe_env, check=False,
                )
            self.assertEqual(completed.returncode, 0, (completed.stderr + completed.stdout)[-1000:])
            result = json.loads(completed.stdout)
            self.assertEqual(generation_paths, ["/v1/chat/completions"])
            self.assertEqual(result.get("api_calls"), 1)
            self.assertTrue(result.get("completed"))
            self.assertEqual(result.get("final_response"), answer)
            self.assertNotIn("offline-test-key", completed.stdout + completed.stderr)
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            resolved_home = hermes_home.resolve()
            allowed_parent = (ROOT / "data" / "runtime" / "benchmarks" / "situation-router").resolve()
            if resolved_home.parent == allowed_parent and resolved_home.exists():
                import shutil
                shutil.rmtree(resolved_home)

if __name__ == "__main__":
    unittest.main()
