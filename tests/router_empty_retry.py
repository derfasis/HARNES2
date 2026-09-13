"""Offline regression: the pinned Hermes Router decision run must recover from
an empty provider response using its builtin empty-response retry ladder.

Runs the REAL scripts/situation_router_worker.py as a subprocess with a
PYTHONPATH shadow ``openai`` package (tests/fixtures/stub_openai_provider), so
pinned Hermes production code is unchanged and no network/model call happens.

Scenario A: attempt #1 empty -> attempt #2 valid. One worker process, exactly
two provider attempts, completed=true, final_response=second answer, tools=0.
Scenario B: attempts #1 and #2 empty. Strictly two attempts, completed=false,
no third attempt.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "scripts" / "situation_router_worker.py"
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
STUB_DIR = ROOT / "tests" / "fixtures" / "stub_openai_provider"
VALID_TEXT = json.dumps({
    "contract_version": "opportunity-projection-v0",
    "situation_id": "stub-situation",
    "opportunity": {"hypothesis": "stub valid second attempt", "evidence": [],
                    "contradictions": [], "unknowns": []},
    "next_action": {"decision": "HANDOFF", "confidence": 0.5},
    "authority": {"contact_permission": False, "allowed_effects": []},
}, ensure_ascii=False)


class RouterEmptyRetryRegression(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="harnes2-router-retry-")
        self.addCleanup(self.scratch.cleanup)
        self.base = Path(self.scratch.name)

    def run_worker(self, script):
        script_path = self.base / "script.json"
        log_path = self.base / "provider.jsonl"
        script_path.write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
        log_path.write_text("", encoding="utf-8")
        run_id = "00000000-0000-4000-8000-%012d" % (abs(hash(tuple(map(str, script)))) % 10 ** 12)
        envelope = {
            "run_id": run_id,
            "situation_id": "stub-situation",
            "context": {"input": {"situation_id": "stub-situation", "message": {
                "text": "Stub context for the offline empty-response regression."}},
                "router_instructions": "Trusted no-tool policy", "active_offer": None},
            "system_prompt": "Trusted no-tool policy",
            "model": {"model": "stub-model", "provider": "custom", "apiMode": "chat_completions",
                      "baseUrl": "https://stub.invalid/v1", "maxIterations": 2,
                      "maxOutputTokens": 3000, "timeoutSeconds": 120},
            "tools": [],
        }
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("PARTNER_") and key not in ("OPENAI_API_KEY",)}
        env.update({
            "PYTHONPATH": str(STUB_DIR),
            "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
            "PARTNER_MODEL_API_KEY": "invented-stub-primary",
            "STUB_PROVIDER_SCRIPT": str(script_path),
            "STUB_PROVIDER_LOG": str(log_path),
        })
        cwd = ROOT / "data" / "runtime"
        cwd.mkdir(parents=True, exist_ok=True)
        completed = subprocess.run(
            [str(PYTHON), str(WORKER)], input=json.dumps(envelope, ensure_ascii=False),
            capture_output=True, text=True, encoding="utf-8", cwd=str(cwd), env=env, timeout=300)
        output = None
        if completed.returncode == 0:
            # The worker prints its JSON envelope on the redirected real stdout;
            # the last non-empty stdout line is the envelope.
            lines = [line for line in completed.stdout.splitlines() if line.strip()]
            output = json.loads(lines[-1])
        return {"completed": completed, "output": output,
                "calls": self.provider_calls(log_path), "run_id": run_id}

    @staticmethod
    def provider_calls(log_path):
        events = [json.loads(line) for line in
                  log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [event for event in events if event.get("event") == "call"]

    def tearDown(self):
        # Keep the shared Hermes scratch area free of regression run dirs.
        for run_id in getattr(self, "_run_dirs", []):
            shutil.rmtree(ROOT / "data" / "runtime" / "benchmarks" / "situation-router" / run_id,
                          ignore_errors=True)

    def record_run_dir(self, run_id):
        self._run_dirs = getattr(self, "_run_dirs", [])
        self._run_dirs.append(run_id)

    def test_scenario_a_empty_then_valid_completes_with_second_answer(self):
        result = self.run_worker([{"kind": "empty"}, {"kind": "text", "text": VALID_TEXT}])
        self.record_run_dir(result["run_id"])
        if result["output"] is None:
            self.fail("worker failed rc=%s stderr=%s" % (result["completed"].returncode,
                                                         result["completed"].stderr[-4000:]))
        output = result["output"]
        self.assertEqual(len(result["calls"]), 2, result["calls"])
        self.assertEqual(output["api_calls"], 2)
        self.assertTrue(output["completed"], output.get("error"))
        self.assertIsNone(output["error"])
        self.assertEqual(output["final_response"], VALID_TEXT)
        self.assertEqual(output["tool_calls"], [])
        self.assertNotIn("prompt", output)

    def test_scenario_b_two_empties_stay_bounded_and_fail_closed(self):
        result = self.run_worker([{"kind": "empty"}, {"kind": "empty"}])
        self.record_run_dir(result["run_id"])
        if result["output"] is None:
            self.fail("worker failed rc=%s stderr=%s" % (result["completed"].returncode,
                                                         result["completed"].stderr[-4000:]))
        output = result["output"]
        self.assertEqual(len(result["calls"]), 2, result["calls"])
        self.assertEqual(output["api_calls"], 2)
        self.assertFalse(output["completed"])
        self.assertNotEqual(output["final_response"], VALID_TEXT)


if __name__ == "__main__":
    unittest.main()
