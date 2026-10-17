"""Exercise the real worker/Hermes HTTP boundary without a paid model or owner keys."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import unittest
from uuid import uuid4

from scripts.situation_router_worker import query_generation_overrides


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "contracts/scout-query-intent.schema.json").read_text(encoding="utf-8"))


class ScoutQueryGenerationTests(unittest.TestCase):
    def test_other_transports_and_unscoped_packets_do_not_gain_overrides(self):
        base = {"context": {"packet": {"scout_assessment_request": {}, "receipt_id": "fixture"},
                            "output_contract": CONTRACT},
                "model": {"provider": "custom", "apiMode": "chat_completions"}}
        for provider, mode in [("custom", "responses"), ("anthropic", "chat_completions"), ("custom", None)]:
            envelope = json.loads(json.dumps(base))
            envelope["model"].update(provider=provider, apiMode=mode)
            self.assertIsNone(query_generation_overrides(envelope))
        envelope = json.loads(json.dumps(base))
        del envelope["context"]["packet"]["scout_assessment_request"]
        self.assertIsNone(query_generation_overrides(envelope))

    def test_missing_query_contract_fails_before_provider_dispatch(self):
        with self.assertRaisesRegex(RuntimeError, "Invalid Scout query output contract"):
            query_generation_overrides({"context": {"packet": {"scout_assessment_request": {}, "receipt_id": "fixture"}},
                                        "model": {"provider": "custom", "apiMode": "chat_completions"}})

    def worker(self, *, content="{}", status=200, query=True):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                # Pinned Hermes probes local Ollama metadata; this cannot generate
                # model output and is outside the production generation budget.
                if self.path == "/api/show":
                    data = b'{"model_info":{"fixture.context_length":131072}}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                body["_fixture_request_path"] = self.path
                received.append(body)
                response = ({"error": {"message": "fixture rejects schema", "type": "invalid_request_error"}}
                            if status != 200 else {
                                "id": "chatcmpl-local-fixture", "object": "chat.completion", "created": 1,
                                "model": "local-query-fixture",
                                "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                                             "finish_reason": "stop"}],
                                "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
                            })
                data = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        run_id = str(uuid4())
        home = ROOT / "data/runtime/benchmarks/situation-router" / run_id
        try:
            packet = {"scout_assessment_request": {"id": str(uuid4()), "fingerprint": "a" * 64}}
            if query:
                packet.update(receipt_id=str(uuid4()), receipt_digest="b" * 64)
            else:
                packet["sample"] = {"id": str(uuid4()), "digest": "b" * 64}
            contract = CONTRACT if query else json.loads(
                (ROOT / "contracts/scout-assessment.schema.json").read_text(encoding="utf-8"))
            envelope = {
                "run_id": run_id, "situation_id": str(uuid4()), "tools": [],
                "system_prompt": "Return the requested JSON, no tools.",
                "context": {"packet": packet, "output_contract": contract},
                "model": {"model": "local-query-fixture", "provider": "custom", "apiMode": "chat_completions",
                          "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "maxIterations": 2,
                          "maxApiCalls": 1, "maxOutputTokens": 512, "timeoutSeconds": 20},
            }
            env = {k: v for k, v in os.environ.items() if k.upper() in {
                "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
                "PROGRAMFILES", "PATHEXT", "HOME"}}
            env.update(PARTNER_MODEL_API_KEY="offline-fixture-not-an-owner-key", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
            child = subprocess.run([sys.executable, str(ROOT / "scripts/situation_router_worker.py")],
                                   cwd=ROOT, env=env, input=json.dumps(envelope), text=True, encoding="utf-8",
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
            # Raw SDK stderr is deliberately excluded from assertion diagnostics.
            self.assertEqual(child.returncode, 0, "worker failed before returning its normalized receipt")
            result = json.loads(child.stdout)
            self.assertEqual(len(received), 1, "no second generation request or format fallback is allowed")
            self.assertEqual(result["api_calls"], 1)
            self.assertEqual(received[0].pop("_fixture_request_path"), "/v1/chat/completions")
            self.assertFalse(received[0].get("tools"))
            self.assertEqual(received[0]["model"], "local-query-fixture")
            return result, received[0]
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            # Remove only the random run home created above, inside this test workspace.
            parent = (ROOT / "data/runtime/benchmarks/situation-router").resolve()
            target = home.resolve()
            self.assertEqual(target.parent, parent)
            self.assertEqual(target.name, run_id)
            if target.exists():
                shutil.rmtree(target)

    def test_query_schema_reaches_actual_hermes_http_request(self):
        result, request = self.worker(content='{"fixture":"wire shape only"}')
        self.assertEqual(request.get("response_format"), {
            "type": "json_schema", "json_schema": {"name": "scout_query_intent", "strict": True, "schema": CONTRACT},
        })
        self.assertTrue(result["completed"])
        # Generation constraints never replace the business validator: this deliberately
        # schema-invalid fixture is still returned literally for the parent to reject.
        self.assertEqual(result["final_response"], '{"fixture":"wire shape only"}')

    def test_malformed_provider_text_is_never_repaired(self):
        raw = "This is not JSON. Do not accept it."
        result, request = self.worker(content=raw)
        self.assertIn("response_format", request.keys())
        self.assertEqual(result["final_response"], raw)

    def test_provider_rejection_never_falls_back_to_freeform_or_another_call(self):
        result, request = self.worker(status=400)
        self.assertIn("response_format", request.keys())
        self.assertFalse(result["completed"])
        self.assertEqual(result["final_response"], "")

    def test_history_assessment_wire_contract_is_unchanged(self):
        result, request = self.worker(content="{}", query=False)
        self.assertNotIn("response_format", request)
        self.assertTrue(result["completed"])


if __name__ == "__main__":
    unittest.main()
