"""One isolated, side-effect-free Conversation Brain benchmark turn."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def compact_prompt_context(context):
    compact = dict(context)
    compact["prompt_assets"] = {
        "identity": {"source": "partner/identity.md", "sha256": context.get("identity_sha256")},
        "behavioral_examples": {
            "source": "partner/behavioral_examples.md",
            "sha256": context.get("behavioral_examples_sha256"),
        },
        "skills": [
            {
                key: skill[key]
                for key in ("name", "version", "sha256")
                if skill.get(key)
            }
            for skill in context.get("skills", [])
        ],
    }
    compact.pop("identity", None)
    compact.pop("behavioral_examples", None)
    compact.pop("skills", None)
    return compact


def safe_benchmark_tool(context, compact_context, name):
    """Return read context and explicit no-op results for effect tools."""
    if name == "partner_get_context":
        return json.dumps(compact_context, ensure_ascii=False)
    if name == "partner_list_work":
        return json.dumps(context.get("tasks", []), ensure_ascii=False)
    if name == "partner_search_experience":
        return json.dumps(context.get("lessons", []), ensure_ascii=False)
    return json.dumps({
        "benchmark_only": True,
        "executed": False,
        "tool": name,
        "message": "Offline benchmark: this proposal was not saved and no external action was taken.",
    }, ensure_ascii=False)


def main():
    envelope = json.load(sys.stdin)
    run_id = envelope["run_id"]
    hermes_home = ROOT / "data" / "runtime" / "benchmarks" / run_id
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
        "checkpoints:\n  enabled: false\n", encoding="utf-8"
    )
    (hermes_home / ".no-bundled-skills").touch()
    sys.path.insert(0, str(ROOT / "runtime" / "hermes-agent"))

    with contextlib.redirect_stdout(sys.stderr):
        from run_agent import AIAgent
        from toolsets import create_custom_toolset
        from tools.registry import registry

        context = envelope["context"]
        model_context = compact_prompt_context(context)
        allowed = {tool["name"] for tool in envelope["tools"]}
        for tool in envelope["tools"]:
            def handler(args, _name=tool["name"], **kwargs):
                return safe_benchmark_tool(context, model_context, _name)

            registry.register(
                name=tool["name"], toolset="partner_business",
                schema={"name": tool["name"], "description": tool["description"], "parameters": tool["inputSchema"]},
                handler=handler, check_fn=lambda: True,
            )
        create_custom_toolset("partner_business", "Offline HARNES2 business tools", sorted(allowed))

        cfg = envelope["model"]
        system_parts = [context.get("behavioral_examples", "")]
        system_parts.extend(skill["content"] for skill in context["skills"])
        partner_system = "\n\n".join(part for part in system_parts if part.strip())
        agent = AIAgent(
            model=cfg["model"], provider=cfg["provider"], api_mode=cfg["apiMode"],
            base_url=cfg["baseUrl"], api_key=os.environ["PARTNER_MODEL_API_KEY"],
            enabled_toolsets=["partner_business"],
            skip_context_files=True, load_soul_identity=True, skip_memory=True,
            skip_background_review=True, save_trajectories=False, quiet_mode=True,
            max_iterations=cfg["maxIterations"], max_tokens=cfg["maxOutputTokens"],
            run_budget_seconds=cfg["timeoutSeconds"], session_id=run_id,
            ephemeral_system_prompt=partner_system, checkpoints_enabled=False,
            fallback_model=None, credential_pool=None,
        )
        if {tool["function"]["name"] for tool in agent.tools} != allowed:
            raise RuntimeError("Hermes tool surface differs from the benchmark allowlist")
        result = agent.run_conversation(
            user_message=json.dumps(model_context, ensure_ascii=False), task_id=run_id,
        )
        base_system = agent._cached_system_prompt or ""
        effective_system = (base_system + "\n\n" + partner_system).strip()
        raw_messages = result.get("messages", [])
        assistant_texts = []
        tool_calls = []
        for message in raw_messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            if message.get("content"):
                assistant_texts.append(message["content"])
            if message.get("tool_calls"):
                tool_calls.extend(message["tool_calls"])
        output = {
            "schema_version": 1,
            "scenario_id": envelope["scenario_id"],
            "run_id": run_id,
            "completed": bool(result.get("completed", False)) and not result.get("error"),
            "final_response": result.get("final_response") or "",
            "assistant_texts": assistant_texts,
            "tool_calls": tool_calls,
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
            output["prompt"] = {
                "hermes_base_system": base_system,
                "partner_ephemeral_system": partner_system,
                "effective_system": effective_system,
                "user_context": json.dumps(model_context, ensure_ascii=False),
                "tool_schemas": agent.tools,
            }
        agent.close()
    print(json.dumps(output, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"completed": False, "error": "Benchmark worker failed: " + type(error).__name__}))
        sys.exit(1)
