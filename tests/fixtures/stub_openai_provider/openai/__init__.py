"""Shadow ``openai`` package for offline Hermes worker regression tests.

Installed only for spawned worker subprocesses via PYTHONPATH, so the pinned
Hermes tree never changes and the real package stays untouched on disk. The
stub performs no network IO: every ``chat.completions.create`` call returns a
scripted in-memory stream. The script is a JSON file named by
``STUB_PROVIDER_SCRIPT``; every event is appended to ``STUB_PROVIDER_LOG`` so
the parent test can assert exact attempt counts.

Script entries:
  {"kind": "empty"}                          - stream with no content/reasoning
  {"kind": "text", "text": "..."}            - streamed visible content
  {"kind": "raise", "error": "...", "status": 402} - APIStatusError-style failure
"""

import json
import os
import time
import uuid

__version__ = "0.0.0-stub"


class APIError(Exception):
    pass


class APIStatusError(APIError):
    def __init__(self, message, *, status_code=None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIConnectionError):
    pass


class AuthenticationError(APIStatusError):
    pass


class BadRequestError(APIStatusError):
    pass


class PermissionDeniedError(APIStatusError):
    pass


class NotFoundError(APIStatusError):
    pass


class UnprocessableEntityError(APIStatusError):
    pass


class InternalServerError(APIStatusError):
    pass


class RateLimitError(APIStatusError):
    pass


def _log(event):
    path = os.environ.get("STUB_PROVIDER_LOG")
    if not path:
        return
    event = dict(event, at=time.time())
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def _script():
    with open(os.environ["STUB_PROVIDER_SCRIPT"], "r", encoding="utf-8") as handle:
        return json.load(handle)


_CALLS = [0]


def _next_call():
    _CALLS[0] += 1
    return _CALLS[0]


def _missing(name):
    def raise_stub(*args, **kwargs):
        raise APIConnectionError("stub openai: %s is not available offline" % name)
    return raise_stub


def _missing_class(name):
    return type(name, (APIError,), {})


class _Delta:
    def __init__(self, content=None):
        self.content = content
        self.tool_calls = None
        self.function_call = None
        self.reasoning_content = None
        self.reasoning = None
        self.refusal = None


class _Choice:
    def __init__(self, delta, finish_reason=None):
        self.delta = delta
        self.finish_reason = finish_reason
        self.index = 0
        self.logprobs = None


class _Usage:
    def __init__(self, prompt_tokens, completion_tokens):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = prompt_tokens + completion_tokens


class _Chunk:
    def __init__(self, choices, usage=None):
        self.choices = choices
        self.usage = usage
        self.model = "stub-model"
        self.id = "chatcmpl-stub-" + uuid.uuid4().hex
        self.object = "chat.completion.chunk"
        self.created = int(time.time())
        self.service_tier = None
        self.system_fingerprint = None


class Stream:
    """Minimal SDK-like stream wrapper kept for ``from openai import Stream``."""

    def __init__(self, chunks):
        self._chunks = list(chunks)

    def __iter__(self):
        return iter(self._chunks)

    def close(self):
        pass


class _Completions:
    def create(self, **kwargs):
        script = _script()
        index = _next_call()
        _log({"event": "call", "call": index, "model": kwargs.get("model"),
              "stream": bool(kwargs.get("stream")), "messages": len(kwargs.get("messages") or [])})
        if index > len(script):
            raise APIStatusError("stub provider exhausted after %d scripted attempts" % len(script),
                                 status_code=500)
        entry = script[index - 1]
        kind = entry.get("kind")
        if kind == "raise":
            raise APIStatusError(entry.get("error", "stub scripted failure"),
                                 status_code=entry.get("status"))
        if kind == "text":
            chunks = [
                _Chunk([_Choice(_Delta(entry.get("text", "")))]),
                _Chunk([_Choice(_Delta(), finish_reason="stop")]),
                _Chunk([], usage=_Usage(entry.get("prompt_tokens", 100),
                                        entry.get("completion_tokens", 32))),
            ]
        else:
            chunks = [
                _Chunk([_Choice(_Delta(""))]),
                _Chunk([_Choice(_Delta(), finish_reason="stop")]),
                _Chunk([], usage=_Usage(entry.get("prompt_tokens", 100), 0)),
            ]
        return Stream(chunks)


class _Models:
    def list(self):
        raise APIConnectionError("stub openai: models.list is not available offline")

    def retrieve(self, *args, **kwargs):
        raise APIConnectionError("stub openai: models.retrieve is not available offline")


class _Chat:
    def __init__(self):
        self.completions = _Completions()


class OpenAI:
    def __init__(self, **kwargs):
        _log({"event": "client_created", "base_url": str(kwargs.get("base_url")),
              "api_key_present": bool(kwargs.get("api_key"))})
        self.chat = _Chat()
        self.models = _Models()

    def close(self):
        pass

    def with_options(self, **kwargs):
        return self


class AsyncOpenAI(OpenAI):
    pass


def __getattr__(name):
    # Unknown SDK symbols (types, helpers, new error classes) resolve to inert
    # placeholders so ``from openai import X`` keeps working offline.
    if name.startswith("_"):
        raise AttributeError(name)
    value = _missing_class(name)
    globals()[name] = value
    return value
