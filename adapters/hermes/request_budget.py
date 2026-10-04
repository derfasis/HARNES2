"""One isolated worker's authority budget, using HTTPX's existing request hooks.

No transport, provider client, credentials or payload logging live here. The hook
counts requests before network dispatch, including SDK retries, redirects,
replacement clients and Hermes' auxiliary summary requests. The model-only mode
excludes GET/HEAD and the pinned Hermes' read-only Ollama /api/show metadata probe.
"""
from contextlib import contextmanager
import threading

import httpx


class RequestBudgetExceeded(RuntimeError):
    pass


class RequestBudget:
    def __init__(self, limit, *, model_requests_only=False):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise ValueError("Invalid request budget")
        if not isinstance(model_requests_only, bool):
            raise ValueError("Invalid request budget scope")
        self.limit = limit
        self.model_requests_only = model_requests_only
        self.calls = 0
        self.exhausted = False
        self.on_exhausted = None
        self._lock = threading.Lock()

    def before_request(self, _request):
        if self.model_requests_only and (_request.method in {"GET", "HEAD"}
                or _request.method == "POST" and _request.url.path == "/api/show"):
            return
        with self._lock:
            blocked = self.calls >= self.limit
            if blocked:
                self.exhausted = True
            else:
                self.calls += 1
        if blocked:
            if self.on_exhausted is not None:
                self.on_exhausted()
            raise RequestBudgetExceeded("MODEL_REQUEST_BUDGET_EXHAUSTED")

    async def before_async_request(self, request):
        self.before_request(request)

    @contextmanager
    def install(self):
        # A worker owns one fresh process. Installing before importing Hermes
        # covers all new SDK clients without changing its pinned source or HTTP
        # transport. HTTPX invokes request hooks for each redirect/retry as well.
        original_sync = httpx.Client.__init__
        original_async = httpx.AsyncClient.__init__

        def hooks(kwargs, before):
            existing = dict(kwargs.pop("event_hooks", None) or {})
            existing["request"] = [before, *existing.get("request", [])]
            kwargs["event_hooks"] = existing

        def sync_init(client, *args, **kwargs):
            hooks(kwargs, self.before_request)
            original_sync(client, *args, **kwargs)

        def async_init(client, *args, **kwargs):
            hooks(kwargs, self.before_async_request)
            original_async(client, *args, **kwargs)

        httpx.Client.__init__ = sync_init
        httpx.AsyncClient.__init__ = async_init
        try:
            yield self
        finally:
            httpx.Client.__init__ = original_sync
            httpx.AsyncClient.__init__ = original_async
