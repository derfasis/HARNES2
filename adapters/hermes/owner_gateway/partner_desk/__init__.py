"""Hermes plugin: the partner's desk in the owner's chat.

Hermes carries the conversation. This plugin does two small things around each turn of it:

* before the model answers, it opens the turn with the local business service and puts in front
  of the partner what the service returns - his own notebook and where the work stands - unless
  that exact text is already in the conversation;
* after the answer, it closes the turn.

One open turn is what lets the partner write in his notebook or set himself desk work from the
chat: the service admits those writes as one run of his own (business/owner-chat.mjs). Nothing
here decides, stores or sends anything. Standard library only, so it loads in any Hermes.
"""
from __future__ import annotations

import json
import os
import urllib.request
import uuid
from pathlib import Path

# The gateway's platforms this desk belongs to. A review fork, a cron job or another surface of
# the same Hermes home is not the owner talking, and gets neither the notebook nor a turn.
PLATFORMS = frozenset(name.strip() for name in os.environ.get("PARTNER_DESK_PLATFORMS", "telegram").split(",") if name.strip())
UNAVAILABLE = ("[рабочий стол недоступен]\nСервис партнёра сейчас не отвечает: тетрадь и задачи не видны, записать ничего нельзя. "
               "Если владелец спрашивает о работе, скажи ему об этом прямо и не отвечай по памяти.")
_turns: dict[str, str] = {}


def _call(payload: dict, timeout: float) -> dict:
    root = os.environ.get("HARNES2_ROOT")
    if not root:
        raise RuntimeError("HARNES2_ROOT is not set")
    connection = json.loads((Path(root) / "data" / "runtime" / "mcp-connection.json").read_text(encoding="utf-8"))
    request = urllib.request.Request(
        connection["url"] + "/internal/chat/turn", data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + connection["token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def _sent_so_far(history) -> str:
    """Every text the model has already been sent in this conversation, injected context included."""
    parts: list[str] = []
    for message in history or []:
        if not isinstance(message, dict):
            continue
        for key in ("api_content", "content"):
            value = message.get(key)
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, list):
                parts.extend(str(part.get("text", "")) for part in value if isinstance(part, dict))
    return "\n".join(parts)


def select_sections(sections, history) -> str:
    """The sections whose marker is not in the conversation yet: new, changed, or lost to compaction."""
    sent = _sent_so_far(history)
    fresh = [section["text"] for section in sections or []
             if isinstance(section, dict) and section.get("marker") and section.get("text") and section["marker"] not in sent]
    return "\n\n".join(fresh)


def begin_turn(session_id="", conversation_history=None, platform="", parent_session_id="", turn_id="", **_ignored):
    if platform not in PLATFORMS or parent_session_id:
        return None
    session = str(session_id or "")
    turn = str(turn_id or uuid.uuid4())
    try:
        opened = _call({"op": "begin", "turn_id": turn, "session_id": session}, timeout=20)
    except Exception:
        # No detail on purpose: an error text could carry the local token or a path.
        _turns.pop(session, None)
        return None if UNAVAILABLE in _sent_so_far(conversation_history) else {"context": UNAVAILABLE}
    _turns[session] = turn
    context = select_sections(opened.get("sections"), conversation_history)
    return {"context": context} if context else None


def end_turn(session_id="", **_ignored):
    turn = _turns.pop(str(session_id or ""), None)
    if not turn:
        return
    try:
        _call({"op": "end", "turn_id": turn}, timeout=10)
    except Exception:
        pass  # the service closes a turn nobody closed: at the next message, or when its time runs out


def register(ctx):
    ctx.register_hook("pre_llm_call", begin_turn)
    ctx.register_hook("post_llm_call", end_turn)
