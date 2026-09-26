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


def collect_response_models():
    """Record what the provider said it served, at the moment it said it.

    The pinned Hermes does not carry a provider response into its final result, so the only place
    the served model name exists is the post_api_request lifecycle hook, which is handed
    ``response_model`` straight off the SDK response. That hook is dispatched from a function that
    imports ``hermes_cli.lifecycle`` on every call, so wrapping the module's ``has_hook`` and
    ``invoke_hook`` is enough to observe it, and nothing inside Hermes is modified on disk.

    Only ``response_model`` is kept. Nothing else from the payload is read: no message text, no
    usage, no request or response body, nothing that could carry a secret into the corpus.
    """
    seen = []
    try:
        from hermes_cli import lifecycle
    except Exception:
        return seen
    if getattr(lifecycle, "_harnes_identity_collector", False):
        return getattr(lifecycle, "_harnes_response_models", [])

    original_has, original_invoke = lifecycle.has_hook, lifecycle.invoke_hook

    def has_hook(hook_name, *args, **kwargs):
        if hook_name == "post_api_request":
            return True
        return original_has(hook_name, *args, **kwargs)

    def invoke_hook(hook_name, *args, **kwargs):
        if hook_name == "post_api_request":
            name = kwargs.get("response_model")
            if isinstance(name, str) and name.strip():
                seen.append(name.strip())
        return original_invoke(hook_name, *args, **kwargs)

    lifecycle.has_hook, lifecycle.invoke_hook = has_hook, invoke_hook
    lifecycle._harnes_identity_collector = True
    lifecycle._harnes_response_models = seen
    return seen


def served_identity(result, response_models=()):
    """What the model service actually said it served.

    Only fields that come from a provider response are trusted. The pinned Hermes build copies the
    configured model name into the top level of its own result, so `result["model"]` is
    configuration wearing a provider's name and is deliberately not read. If nothing with a
    provider origin is present the answer is None, because a corpus attributed to a model that did
    not serve it is worse than no corpus.
    """
    # A run that reached more than one model is not one evaluation, and guessing which of them
    # served it would be exactly the kind of quiet invention this refuses to make.
    distinct = sorted({name for name in response_models if isinstance(name, str) and name.strip()})
    if len(distinct) > 1:
        return None, f"several_models_served_this_run:{'|'.join(distinct)}"
    if distinct:
        # A provider that exposes one canonical served-model token has said everything it is
        # willing to say about identity. Repeating that token in the version field is the
        # strongest identity the provider gave, not a version we made up; the configured model and
        # the agent's own name are never used for either field.
        return {"model_id": distinct[0], "model_version": distinct[0]}, None
    if not isinstance(result, dict):
        return None, "runtime_did_not_expose_a_served_model_identity"
    for container in ("last_response", "provider_response", "response_meta", "metadata"):
        source = result.get(container)
        if not isinstance(source, dict):
            continue
        for key in ("served_model", "model", "model_id"):
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
        response_models = collect_response_models()
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
        identity, identity_reason = served_identity(result, response_models)
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
