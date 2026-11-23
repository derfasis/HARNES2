"""What the partner's prompt may say about the machine it runs on.

Hermes appends a "runtime environment" block to every system prompt: the host OS, the user's
home directory, the working directory and instructions for a terminal tool. The partner has no
terminal. Its only tools are the business tools of one run, so that block describes a capability
it does not have and sends local paths to the model provider for no reason. The block is left out
here, in the adapter; the pinned Hermes checkout is not modified.

Recorded plainly: on 2026-11-23 the model route behind the local proxy answered HTTP 429 to every
request that carried this block's closing marker and accepted the same request without it. Why
the provider does that is not established. Leaving the block out on this route is an owner
decision (see docs/PARTNER_NOTEBOOK_V1.md). Nothing else about a request is altered or disguised.
"""
from __future__ import annotations


def omit_host_environment() -> None:
    """Make Hermes build its system prompt without the host/terminal environment block.

    Call after the Hermes checkout is on sys.path and before the agent builds its prompt.
    """
    from agent import prompt_builder

    prompt_builder.build_environment_hints = lambda: ""
