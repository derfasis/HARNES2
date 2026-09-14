"""Offline tests for the worker's closed provider-failure classification."""

import json
import unittest

from scripts.situation_router_worker import classify_provider_failure


class SituationRouterFailureCauseTests(unittest.TestCase):
    def test_http_402_is_billing_without_provider_text(self):
        cause = classify_provider_failure({
            "error": "HTTP 402: provider body contains a secret URL",
            "failure_reason": "billing",
            "failure_retryable": False,
            "api_calls": 1,
        })
        self.assertEqual(cause, {
            "kind": "provider_error", "http_status": 402, "provider_error_type": "billing_error",
            "retryable": False, "attempt_count": 1, "child_exit_code": None,
            "timed_out": False, "stdout_json_valid": True,
        })
        self.assertNotIn("secret URL", json.dumps(cause))

    def test_api_connection_error_is_retryable_and_has_no_status(self):
        cause = classify_provider_failure({
            "error": "Connection error.",
            "failure_reason": "unknown",
            "api_calls": 3,
        })
        self.assertEqual(cause["kind"], "provider_error")
        self.assertEqual(cause["provider_error_type"], "connection_error")
        self.assertIsNone(cause["http_status"])
        self.assertTrue(cause["retryable"])
        self.assertEqual(cause["attempt_count"], 3)

    def test_timeout_is_classified_without_raw_exception(self):
        cause = classify_provider_failure({
            "error": "Request timed out",
            "failure_reason": "timeout",
            "failure_retryable": True,
            "api_calls": 1,
        })
        self.assertEqual(cause["provider_error_type"], "timeout")
        self.assertTrue(cause["retryable"])
        self.assertIsNone(cause["http_status"])


if __name__ == "__main__":
    unittest.main()
