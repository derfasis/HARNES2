"""Private single-run adapter. Hermes owns the model/tool loop; business owns effects.

One process per run prevents profile/scope sharing. Stdin is the request envelope;
stdout is one JSON result, while upstream console output is redirected to stderr.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys
import uuid
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def business_call(envelope, name, args):
    payload = json.dumps({"name": name, "arguments": args, "request_id": str(uuid.uuid4())}).encode()
    request = urllib.request.Request(
        envelope["business_url"] + "/internal/tools/call", data=payload,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["PARTNER_RUN_TOKEN"]},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        return json.dumps({"error": error.read(8192).decode(errors="replace"), "status": error.code})
    except (OSError, TimeoutError):
        return json.dumps({"error": "Business service unavailable; action was not confirmed"})


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


def main():
    envelope = json.load(sys.stdin)
    run_id = str(uuid.UUID(envelope["run_id"]))
    # Every run has a private home; no existing user Hermes/Codex credentials or memory.
    hermes_home = ROOT / "data" / "runtime" / "hermes" / run_id
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
        from tools.registry import registry
        from toolsets import create_custom_toolset
        from credentials import runtime_credentials

        allowed = {tool["name"] for tool in envelope["tools"]}
        for tool in envelope["tools"]:
            def handler(args, _name=tool["name"], **kwargs):
                return business_call(envelope, _name, args)
            registry.register(
                name=tool["name"], toolset="partner_business",
                schema={"name": tool["name"], "description": tool["description"], "parameters": tool["inputSchema"]},
                handler=handler, check_fn=lambda: True,
            )
        create_custom_toolset("partner_business", "HARNES2 business tools for this isolated run", sorted(allowed))
        cfg = envelope["model"]
        context = envelope["context"]
        system_parts = [context.get("behavioral_examples", "")]
        system_parts.extend(s["content"] for s in context["skills"])
        system = "\n\n".join(part for part in system_parts if part.strip())
        model_context = compact_prompt_context(context)
        api_key, credential_pool = runtime_credentials(cfg["baseUrl"])
        agent = AIAgent(
            model=cfg["model"], provider=cfg["provider"], api_mode=cfg["apiMode"],
            base_url=cfg["baseUrl"], api_key=api_key,
            enabled_toolsets=["partner_business"],
            skip_context_files=True, load_soul_identity=True, skip_memory=True,
            skip_background_review=True, save_trajectories=False, quiet_mode=True,
            max_iterations=cfg["maxIterations"], max_tokens=cfg["maxOutputTokens"],
            run_budget_seconds=cfg["timeoutSeconds"], session_id=run_id,
            ephemeral_system_prompt=system, checkpoints_enabled=False,
            fallback_model=None, credential_pool=credential_pool,
        )
        advertised = {tool["function"]["name"] for tool in agent.tools}
        if advertised != allowed:
            raise RuntimeError("Hermes tool surface differs from the explicit business allowlist")
        result = agent.run_conversation(
            user_message=json.dumps(model_context, ensure_ascii=False), task_id=run_id,
        )
        output = {
            "schema_version": 1, "run_id": run_id,
            "completed": bool(result.get("completed", False)) and not result.get("error"),
            "final_response": result.get("final_response") or "",
            "error": str(result.get("error"))[:2000] if result.get("error") else None,
            "messages": result.get("messages", []),
            "api_calls": result.get("api_calls"),
            "usage": {
                "input_tokens": getattr(agent, "session_input_tokens", None),
                "output_tokens": getattr(agent, "session_output_tokens", None),
                "estimated_cost_usd": getattr(agent, "session_estimated_cost_usd", None),
                "cost_status": getattr(agent, "session_cost_status", "unknown"),
            },
        }
    print(json.dumps(output, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print provider request objects, keys, environment or a traceback.
        print(json.dumps({"completed": False, "error": "Hermes adapter failed: " + type(error).__name__}))
        sys.exit(1)
