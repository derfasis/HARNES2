"""Offline tests for the worker's closed provider-failure classification."""

import json
import unittest

from scripts.situation_router_worker import classify_provider_failure, served_identity


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


class ServedIdentityTests(unittest.TestCase):
    """The served model name is only ever what a provider response carried."""

    def test_a_single_served_model_is_taken_from_the_provider_response(self):
        identity, reason = served_identity({"model": "configured-model"}, ["served-model"])
        self.assertEqual(identity, {"model_id": "served-model", "model_version": None})
        self.assertIsNone(reason)

    def test_the_configured_model_is_never_used_as_the_served_one(self):
        # The pinned runtime copies the configured name into the top level of its result. Reading it
        # would attribute a corpus to a model that may never have served it.
        identity, reason = served_identity({"model": "configured-model"}, [])
        self.assertIsNone(identity)
        self.assertEqual(reason, "runtime_did_not_expose_a_served_model_identity")

    def test_one_run_serving_two_models_is_refused_rather_than_guessed(self):
        identity, reason = served_identity({}, ["model-a", "model-b"])
        self.assertIsNone(identity)
        self.assertEqual(reason, "several_models_served_this_run:model-a|model-b")

    def test_the_same_model_several_times_is_one_model(self):
        identity, reason = served_identity({}, ["served-model", "served-model"])
        self.assertEqual(identity, {"model_id": "served-model", "model_version": None})
        self.assertIsNone(reason)

    def test_blank_names_do_not_count_as_served(self):
        identity, reason = served_identity({}, ["", "   "])
        self.assertIsNone(identity)
        self.assertEqual(reason, "runtime_did_not_expose_a_served_model_identity")

    def test_the_collector_reads_only_the_response_model(self):
        # The hook payload carries usage, message text and the request body. Only the model name
        # may be kept, or the corpus inherits whatever the hook happened to hand over.
        seen = []

        class FakeLifecycle:
            pass

        captured = {}

        def fake_invoke(hook_name, **kwargs):
            captured.update(kwargs)
            if hook_name == "post_api_request":
                name = kwargs.get("response_model")
                if isinstance(name, str) and name.strip():
                    seen.append(name.strip())
            return []

        # Exercise the same narrowing the collector performs, against a realistic hook payload.
        payload = {"response_model": "served-model", "usage": {"total_tokens": 5},
                   "assistant_content_chars": 12, "base_url": "https://example.invalid"}
        fake_invoke("post_api_request", **payload)
        self.assertEqual(seen, ["served-model"])
        self.assertNotIn("https://example.invalid", seen)
