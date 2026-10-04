"""Black-box HTTP request limits for bounded Hermes model turns.

These tests use HTTPX transports and a loopback-only completion stub. No provider keys or
external network access are involved.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

import httpx
from openai import OpenAI

from adapters.hermes.request_budget import RequestBudget, RequestBudgetExceeded


_LOOPBACK_ONLY_BOOTSTRAP = r'''
import ipaddress, socket
_original_getaddrinfo = socket.getaddrinfo
_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
def _loopback_host(host):
    if isinstance(host, bytes):
        host = host.decode("ascii", errors="strict")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, TypeError):
        return False
def _guarded_getaddrinfo(host, port, *args, **kwargs):
    if not _loopback_host(host):
        raise OSError("offline worker permits loopback only")
    rows = _original_getaddrinfo(host, port, *args, **kwargs)
    if not rows or any(not ipaddress.ip_address(row[4][0]).is_loopback for row in rows):
        raise OSError("offline worker permits loopback only")
    return rows
def _guarded_connect(sock, address):
    host = address[0] if isinstance(address, tuple) else address
    if not _loopback_host(host):
        raise OSError("offline worker permits loopback only")
    return _original_connect(sock, address)
def _guarded_connect_ex(sock, address):
    host = address[0] if isinstance(address, tuple) else address
    if not _loopback_host(host):
        raise OSError("offline worker permits loopback only")
    return _original_connect_ex(sock, address)
socket.getaddrinfo = _guarded_getaddrinfo
socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex
'''


class RequestBudgetTests(unittest.TestCase):
    def test_third_sync_request_is_blocked_before_transport_dispatch(self):
        dispatched = []

        def handler(request):
            dispatched.append(request.url.path)
            return httpx.Response(200, json={"ok": True})

        budget = RequestBudget(2)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                client.get("https://stub.test/one")
                client.get("https://stub.test/two")
                with self.assertRaises(RequestBudgetExceeded):
                    client.get("https://stub.test/three")

        self.assertEqual(dispatched, ["/one", "/two"])
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)

    def test_distinct_clients_share_one_counter_and_existing_hooks_are_forwarded(self):
        dispatched = []
        existing_hooks = []

        def transport(request):
            dispatched.append(request.url.path)
            return httpx.Response(200)

        def existing_hook(request):
            existing_hooks.append(request.url.path)

        budget = RequestBudget(2)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(transport),
                              event_hooks={"request": [existing_hook]}) as first:
                first.get("https://stub.test/a")
            with httpx.Client(transport=httpx.MockTransport(transport)) as second:
                second.get("https://stub.test/b")
                with self.assertRaises(RequestBudgetExceeded):
                    second.get("https://stub.test/c")

        self.assertEqual(dispatched, ["/a", "/b"])
        self.assertEqual(existing_hooks, ["/a"])
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)

    def test_async_clients_are_limited_by_the_same_installed_budget(self):
        async def exercise():
            dispatched = []

            async def handler(request):
                dispatched.append(request.url.path)
                return httpx.Response(200)

            budget = RequestBudget(2)
            with budget.install():
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as first:
                    await first.get("https://stub.test/a")
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as second:
                    await second.get("https://stub.test/b")
                    with self.assertRaises(RequestBudgetExceeded):
                        await second.get("https://stub.test/c")
            return budget, dispatched

        import asyncio
        budget, dispatched = asyncio.run(exercise())
        self.assertEqual(dispatched, ["/a", "/b"])
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)

    def test_openai_retries_cannot_dispatch_a_third_http_request(self):
        dispatched = []

        def always_fail(request):
            dispatched.append(request.url.path)
            return httpx.Response(500, json={"error": {"message": "stub failure"}})

        budget = RequestBudget(2)
        with budget.install():
            transport = httpx.MockTransport(always_fail)
            raw_client = httpx.Client(transport=transport)
            client = OpenAI(api_key="offline-test-key", max_retries=4, http_client=raw_client,
                            base_url="https://stub.test/v1")
            try:
                with self.assertRaises(Exception):
                    client.chat.completions.create(
                        model="stub-model", messages=[{"role": "user", "content": "test"}]
                    )
            finally:
                client.close()

        self.assertEqual(len(dispatched), 2, "SDK retries must be counted as HTTP requests")
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)

    def test_worker_mode_ignores_metadata_probes_but_caps_generation_posts(self):
        dispatched = []

        def handler(request):
            dispatched.append((request.method, request.url.path))
            return httpx.Response(200, json={"ok": True})

        budget = RequestBudget(2, model_requests_only=True)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                client.get("https://stub.test/v1/models")
                client.post("https://stub.test/api/show", json={"name": "offline-model"})
                client.post("https://stub.test/v1/chat/completions", json={"messages": []})
                client.post("https://stub.test/v1/chat/completions", json={"messages": []})
                with self.assertRaises(RequestBudgetExceeded):
                    client.post("https://stub.test/v1/chat/completions", json={"messages": []})

        self.assertEqual(dispatched, [
            ("GET", "/v1/models"), ("POST", "/api/show"),
            ("POST", "/v1/chat/completions"), ("POST", "/v1/chat/completions"),
        ])
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)

    def test_redirect_target_is_counted_and_blocked_before_following(self):
        seen = []

        def redirector(request):
            seen.append(str(request.url))
            if request.url.host == "origin.test":
                return httpx.Response(302, headers={"Location": "https://outside.test/landing"})
            return httpx.Response(200)

        budget = RequestBudget(1)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(redirector), follow_redirects=True) as client:
                with self.assertRaises(RequestBudgetExceeded):
                    client.get("https://origin.test/start")

        self.assertEqual(seen, ["https://origin.test/start"])
        self.assertEqual(budget.calls, 1)
        self.assertTrue(budget.exhausted)

    def test_installed_budget_restores_client_constructors_and_preserves_other_hooks(self):
        seen = []
        dispatched = []

        def hook(request):
            seen.append(request.url.path)

        def transport(request):
            dispatched.append(request.url.path)
            return httpx.Response(200)

        budget = RequestBudget(1)
        with budget.install():
            with httpx.Client(transport=httpx.MockTransport(transport),
                              event_hooks={"request": [hook]}) as inside:
                inside.get("https://stub.test/inside")
        # Once the context is restored, a newly-created client is not charged to the old budget.
        with httpx.Client(transport=httpx.MockTransport(transport),
                          event_hooks={"request": [hook]}) as outside:
            outside.get("https://stub.test/outside")

        self.assertEqual(seen, ["/inside", "/outside"])
        self.assertEqual(dispatched, ["/inside", "/outside"])
        self.assertEqual(budget.calls, 1)
        self.assertFalse(budget.exhausted)

    def test_concurrent_requests_never_exceed_the_transport_cap(self):
        dispatched = []
        dispatch_lock = threading.Lock()
        start = threading.Barrier(12)

        def transport(request):
            with dispatch_lock:
                dispatched.append(request.url.path)
            return httpx.Response(200)

        budget = RequestBudget(2)

        def one_request(index):
            start.wait(timeout=5)
            try:
                with httpx.Client(transport=httpx.MockTransport(transport)) as client:
                    client.get(f"https://stub.test/{index}")
                return "sent"
            except RequestBudgetExceeded:
                return "blocked"

        with budget.install():
            with ThreadPoolExecutor(max_workers=12) as pool:
                results = list(pool.map(one_request, range(12)))

        self.assertEqual(dispatched.__len__(), 2)
        self.assertEqual(results.count("sent"), 2)
        self.assertEqual(results.count("blocked"), 10)
        self.assertEqual(budget.calls, 2)
        self.assertTrue(budget.exhausted)


class WorkerRequestBudgetIntegrationTests(unittest.TestCase):
    def _run_worker(self, answer):
        metadata_requests = []
        generation_paths = []

        class Handler(BaseHTTPRequestHandler):
            def _json(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                metadata_requests.append(self.path)
                self._json({"models": [{"id": "offline-stub-model", "key": "offline-stub-model",
                                         "loaded_instances": []}]})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                parsed = json.loads(body)
                if self.path.endswith("/api/show"):
                    metadata_requests.append(self.path)
                    self.send_error(404)
                    return
                generation_paths.append(self.path)
                completion_tokens = 0 if not answer else 6
                usage = {"prompt_tokens": 17, "completion_tokens": completion_tokens,
                         "total_tokens": 17 + completion_tokens}
                response_id = f"chatcmpl-{len(generation_paths)}"
                chunks = [
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-stub-model", "choices": [{"index": 0,
                     "delta": {"role": "assistant"}, "finish_reason": None}]},
                ]
                if answer:
                    chunks.append({"id": response_id, "object": "chat.completion.chunk", "created": 1,
                                   "model": "offline-stub-model", "choices": [{"index": 0,
                                   "delta": {"content": answer}, "finish_reason": None}]})
                chunks.extend([
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-stub-model", "choices": [{"index": 0,
                     "delta": {}, "finish_reason": "stop"}]},
                    {"id": response_id, "object": "chat.completion.chunk", "created": 1,
                     "model": "offline-stub-model", "choices": [], "usage": usage},
                ])
                stream_body = "".join(
                    "data: " + json.dumps(chunk) + "\n\n" for chunk in chunks
                ) + "data: [DONE]\n\n"
                encoded = stream_body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        run_id = str(uuid.uuid4())
        hermes_home = (Path(__file__).resolve().parents[1] / "data" / "runtime" / "benchmarks"
                       / "situation-router" / run_id)
        command = [sys.executable, "-c", _LOOPBACK_ONLY_BOOTSTRAP +
                   "\nfrom scripts.situation_router_worker import main; main()"]
        envelope = {
            "run_id": run_id,
            "situation_id": "need-followup-local-stub",
            "tools": [],
            "model": {
                "provider": "openai", "apiMode": "chat_completions",
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "model": "offline-stub-model", "maxIterations": 2,
                "maxOutputTokens": 32, "timeoutSeconds": 15, "maxApiCalls": 2,
            },
            "context": {"packet": {"followup": {"version": 1}}, "exchanges": []},
            "system_prompt": "Summarize the supplied evidence. If uncertain, say so.",
        }
        safe_env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
                    if key in os.environ}
        try:
            with tempfile.TemporaryDirectory(prefix="harnes-request-budget-home-") as isolated_home:
                safe_env.update({"PARTNER_MODEL_API_KEY": "offline-test-key", "PYTHONIOENCODING": "utf-8",
                                 "HOME": isolated_home, "USERPROFILE": isolated_home,
                                 "APPDATA": isolated_home, "LOCALAPPDATA": isolated_home})
                completed = subprocess.run(
                    command, input=json.dumps(envelope), text=True, capture_output=True,
                    timeout=45, env=safe_env, check=False,
                )
            self.assertEqual(completed.returncode, 0, (completed.stderr + completed.stdout)[-1000:])
            return completed, json.loads(completed.stdout), generation_paths, metadata_requests
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            resolved_home = hermes_home.resolve()
            allowed_parent = (Path(__file__).resolve().parents[1] / "data" / "runtime"
                              / "benchmarks" / "situation-router").resolve()
            if resolved_home.parent == allowed_parent and resolved_home.exists():
                import shutil
                shutil.rmtree(resolved_home)

    def test_hermes_worker_reports_actual_two_http_calls_and_no_completion(self):
        completed, result, generation_paths, metadata_requests = self._run_worker("")
        self.assertEqual(len(generation_paths), 2,
                         f"expected two generation POSTs, got {len(generation_paths)}; metadata={len(metadata_requests)}")
        self.assertTrue(all(path.endswith("/chat/completions") for path in generation_paths))
        self.assertEqual(result.get("api_calls"), 2, "receipt must report dispatched HTTP calls")
        self.assertFalse(result.get("completed"), "empty provider answers must not count as completion")
        self.assertEqual(result.get("usage", {}).get("input_tokens"), 34)
        self.assertEqual(result.get("usage", {}).get("output_tokens"), 0)
        self.assertNotIn("offline-test-key", completed.stdout + completed.stderr)

    def test_valid_hermes_stream_is_not_mistaken_for_budget_exhaustion(self):
        answer = "The packet supports no confirmed proposal."
        completed, result, generation_paths, _metadata_requests = self._run_worker(answer)
        self.assertEqual(len(generation_paths), 1)
        self.assertTrue(result.get("completed"))
        self.assertEqual(result.get("api_calls"), 1)
        self.assertEqual(result.get("final_response"), answer)
        self.assertEqual(result.get("usage", {}).get("input_tokens"), 17)
        self.assertEqual(result.get("usage", {}).get("output_tokens"), 6)
        self.assertNotIn("offline-test-key", completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
