"""One isolated Situation Router model run with no business/effect tools."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


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
    (hermes_home / "SOUL.md").write_bytes((ROOT / "partner" / "identity.md").read_bytes())
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
            skip_context_files=True, load_soul_identity=True, skip_memory=True,
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
        raw_messages = result.get("messages", [])
        assistant_texts = [
            message["content"] for message in raw_messages
            if isinstance(message, dict) and message.get("role") == "assistant" and message.get("content")
        ]
        output = {
            "schema_version": 1,
            "situation_id": envelope["situation_id"],
            "run_id": run_id,
            "completed": bool(result.get("completed", False)) and not result.get("error"),
            "final_response": result.get("final_response") or "",
            "assistant_texts": assistant_texts,
            "tool_calls": [],
            "error": str(result.get("error"))[:4000] if result.get("error") else None,
            "messages": raw_messages,
            "api_calls": result.get("api_calls"),
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
    except Exception as error:
        print(json.dumps({"completed": False, "error": "Situation Router worker failed: " + type(error).__name__}))
        sys.exit(1)
