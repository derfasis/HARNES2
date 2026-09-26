"""One isolated Situation Router model run with no business/effect tools."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]

_PROVIDER_ERROR_TYPES = {
    "billing": "billing_error",
    "timeout": "timeout",
    "rate_limit": "rate_limit",
    "auth": "auth_error",
    "auth_permanent": "auth_error",
    "server_error": "server_error",
    "overloaded": "server_error",
    "model_not_found": "model_not_found",
    "format_error": "invalid_request",
    "invalid_request": "invalid_request",
    "unknown": "unknown",
}


def _http_status(value):
    if isinstance(value, bool):
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if 100 <= value <= 599 else None


def _status_from_safe_text(text):
    import re
    match = re.search(r"(?:http\s*|error\s+code:\s*)([1-5]\d{2})\b", str(text or ""), re.IGNORECASE)
    return int(match.group(1)) if match else None


def classify_provider_failure(result):
    """Return only the closed, persisted failure-cause schema; never provider text."""
    error_text = str(result.get("error") or "")
    failure_reason = str(result.get("failure_reason") or "").lower()
    lowered = error_text.lower()
    status = _http_status(result.get("http_status")) or _status_from_safe_text(error_text)
    if "timeout" in lowered or "timed out" in lowered or failure_reason == "timeout":
        provider_type = "timeout"
    elif any(marker in lowered for marker in ("connection error", "can't reach", "network error", "connection reset")):
        provider_type = "connection_error"
    else:
        provider_type = _PROVIDER_ERROR_TYPES.get(failure_reason, "unknown")
    explicit_retryable = result.get("failure_retryable")
    if isinstance(explicit_retryable, bool):
        retryable = explicit_retryable
    else:
        retryable = provider_type in {"connection_error", "timeout", "rate_limit", "server_error"}
    attempt_count = result.get("api_calls")
    if not isinstance(attempt_count, int) or isinstance(attempt_count, bool) or attempt_count < 0 or attempt_count > 1000:
        attempt_count = 0
    return {
        "kind": "provider_error",
        "http_status": status,
        "provider_error_type": provider_type,
        "retryable": retryable,
        "attempt_count": attempt_count,
        "child_exit_code": None,
        "timed_out": False,
        "stdout_json_valid": True,
    }


def worker_failure_cause(result):
    if result.get("error") or result.get("failure_reason") or not result.get("completed", False):
        return classify_provider_failure(result)
    return None


def served_identity(result):
    """What the model service actually said it served.

    Read only from provider-returned data: the run result and any response metadata it carries.
    The agent object is deliberately not consulted, because its `model` attribute is the
    configured name — trusting it would let a configuration masquerade as a served model.
    Returns (identity, reason); identity is None when nothing usable was returned.
    """
    sources = [result]
    for key in ("last_response", "response", "response_meta", "metadata"):
        nested = result.get(key) if isinstance(result, dict) else None
        if isinstance(nested, dict):
            sources.append(nested)
    for source in sources:
        for key in ("served_model", "model_id", "model"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                version = source.get("model_version") or source.get("version")
                return {"model_id": value.strip(),
                        "model_version": version if isinstance(version, str) and version.strip() else None}, None
    return None, "runtime_did_not_expose_a_served_model_identity"


def main():
    envelope = json.load(sys.stdin)
    run_id = str(envelope["run_id"])
    if envelope.get("tools"):
        raise RuntimeError("Situation Router must not receive effect tools")

    hermes_home = ROOT / "data" / "runtime" / "benchmarks" / "situation-router" / run_id
    hermes_home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(hermes_home)
    os.environ["HERMES_CWD"] = str(hermes_home)
    os.chdir(hermes_home)
    (hermes_home / "config.yaml").write_text(
        "memory:\n  memory_enabled: false\n  user_profile_enabled: false\n  write_approval: true\n"
        "skills:\n  write_approval: true\n"
        "agent:\n  skip_memory: true\n  tool_use_enforcement: false\n  execution_guidance: false\n"
        "  task_completion_guidance: false\n  parallel_tool_call_guidance: false\n"
        "  environment_probe: false\n  bot_mode_protocol: false\n  coding_context: off\n"
        "tools:\n  tool_search:\n    enabled: off\n"
        "checkpoints:\n  enabled: false\n",
        encoding="utf-8",
    )
    (hermes_home / ".no-bundled-skills").touch()
    sys.path.insert(0, str(ROOT / "runtime" / "hermes-agent"))
    sys.path.insert(0, str(ROOT / "adapters" / "hermes"))

    with contextlib.redirect_stdout(sys.stderr):
        from run_agent import AIAgent
        from credentials import runtime_credentials

        cfg = envelope["model"]
        api_key, credential_pool = runtime_credentials(cfg["baseUrl"])
        agent = AIAgent(
            model=cfg["model"], provider=cfg["provider"], api_mode=cfg["apiMode"],
            base_url=cfg["baseUrl"], api_key=api_key,
            enabled_toolsets=[],
            skip_context_files=True, load_soul_identity=False, skip_memory=True,
            skip_background_review=True, save_trajectories=False, quiet_mode=True,
            max_iterations=cfg["maxIterations"], max_tokens=cfg["maxOutputTokens"],
            run_budget_seconds=cfg["timeoutSeconds"], session_id=run_id,
            ephemeral_system_prompt=envelope["system_prompt"], checkpoints_enabled=False,
            fallback_model=None, credential_pool=credential_pool,
        )
        if agent.tools:
            raise RuntimeError("Hermes advertised tools for a no-tool Situation Router run")
        result = agent.run_conversation(
            user_message=json.dumps(envelope["context"], ensure_ascii=False), task_id=run_id,
        )
        failure_cause = worker_failure_cause(result)
        completed = bool(result.get("completed", False)) and not result.get("error")
        raw_messages = result.get("messages", [])
        assistant_texts = [
            message["content"] for message in raw_messages
            if isinstance(message, dict) and message.get("role") == "assistant" and message.get("content")
        ]
        identity, identity_reason = served_identity(result)
        output = {
            "schema_version": 1,
            "situation_id": envelope["situation_id"],
            "model_identity": identity,
            "model_identity_reason": identity_reason,
            "run_id": run_id,
            "completed": completed,
            "final_response": (result.get("final_response") or "") if completed else "",
            "assistant_texts": assistant_texts if completed else [],
            "tool_calls": [],
            "error": "MODEL_FAILED" if not completed else None,
            "failure_cause": failure_cause,
            "messages": raw_messages if completed else [],
            "api_calls": result.get("api_calls") if isinstance(result.get("api_calls"), int) else None,
            "usage": {
                "input_tokens": getattr(agent, "session_input_tokens", None),
                "output_tokens": getattr(agent, "session_output_tokens", None),
                "estimated_cost_usd": getattr(agent, "session_estimated_cost_usd", None),
                "cost_status": getattr(agent, "session_cost_status", "unknown"),
            },
        }
        if envelope.get("include_prompt"):
            base_system = agent._cached_system_prompt or ""
            output["prompt"] = {
                "hermes_base_system": base_system,
                "router_system": envelope["system_prompt"],
                "user_context": json.dumps(envelope["context"], ensure_ascii=False),
                "tool_schemas": [],
            }
        agent.close()
    print(json.dumps(output, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"completed": False, "error": "WORKER_FAILURE", "failure_cause": {
            "kind": "worker_failure", "http_status": None, "provider_error_type": None,
            "retryable": False, "attempt_count": 0, "child_exit_code": None,
            "timed_out": False, "stdout_json_valid": True,
        }}))
        sys.exit(1)
