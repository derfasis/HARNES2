"""Process-local model credentials for one isolated Hermes run."""
from __future__ import annotations

import os
from typing import Optional, Tuple

from agent.credential_pool import (
    AUTH_TYPE_API_KEY,
    STRATEGY_FILL_FIRST,
    CredentialPool,
    PooledCredential,
)


class EphemeralCredentialPool(CredentialPool):
    """Keep failover state in memory and never write Hermes auth state."""

    def _persist(self, *, removed_ids=None, status_cleared_ids=None) -> None:
        return None


def runtime_credentials(base_url: str) -> Tuple[str, Optional[CredentialPool]]:
    primary = os.environ.get("PARTNER_MODEL_API_KEY", "").strip()
    secondary = os.environ.get("PARTNER_MODEL_API_KEY_SECONDARY", "").strip()
    tertiary = os.environ.get("PARTNER_MODEL_API_KEY_TERTIARY", "").strip()
    if not primary:
        raise RuntimeError("PARTNER_MODEL_API_KEY is required")

    entries = []
    seen = set()
    for credential_id, label, api_key in (
        ("primary", "primary", primary),
        ("secondary", "secondary", secondary),
        ("tertiary", "tertiary", tertiary),
    ):
        if not api_key or api_key in seen:
            continue
        seen.add(api_key)
        entries.append(
            PooledCredential(
                provider="custom",
                id=credential_id,
                label=label,
                auth_type=AUTH_TYPE_API_KEY,
                priority=len(entries),
                source="partner_env",
                access_token=api_key,
                base_url=base_url,
            )
        )

    pool = EphemeralCredentialPool("custom", entries)
    pool._strategy = STRATEGY_FILL_FIRST
    return primary, pool
