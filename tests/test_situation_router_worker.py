"""Offline tests for the worker's closed provider-failure classification."""

import json
import unittest

from scripts.situation_router_worker import (classify_provider_failure, collect_response_models,
                                        served_identity)


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




class ServedIdentityTests(unittest.TestCase):
    """The served model name is only ever what a provider response carried."""

    def test_a_single_served_model_is_taken_from_the_provider_response(self):
        identity, reason = served_identity({"model": "configured-model"}, ["served-model"])
        # One canonical provider token: both fields carry it. That is the strongest identity the
        # provider exposed, not a version derived from configuration.
        self.assertEqual(identity, {"model_id": "served-model", "model_version": "served-model"})
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
        self.assertEqual(identity, {"model_id": "served-model", "model_version": "served-model"})
        self.assertIsNone(reason)

    def test_blank_names_do_not_count_as_served(self):
        identity, reason = served_identity({}, ["", "   "])
        self.assertIsNone(identity)
        self.assertEqual(reason, "runtime_did_not_expose_a_served_model_identity")

    def test_the_collector_wraps_the_real_lifecycle_dispatch(self):
        # This drives collect_response_models itself. A test that repeats the narrowing by hand
        # would stay green while the actual wrapper was broken, which is the whole point of the
        # seam being worth pinning.
        import hermes_cli.lifecycle as lifecycle
        from agent import turn_response_intake  # noqa: F401  (the module the hook lives in)

        original_has, original_invoke = lifecycle.has_hook, lifecycle.invoke_hook
        # The counter goes underneath the collector, not over it: the collector captures the
        # dispatcher at install time, so only a wrapper placed first is one it will delegate to.
        reached = []

        def counting_invoke(name, *a, **k):
            reached.append(name)
            return original_invoke(name, *a, **k)

        lifecycle.has_hook, lifecycle.invoke_hook = original_has, counting_invoke
        lifecycle._harnes_identity_collector = False
        try:
            seen = collect_response_models()
            # A read-only run has no plugins registered, so the SDK skips the hook entirely. The
            # collector has to make post_api_request visible or the payload is never dispatched.
            self.assertTrue(lifecycle.has_hook("post_api_request"))
            self.assertFalse(lifecycle.has_hook("some_other_hook"))

            lifecycle.invoke_hook("post_api_request", response_model="served-model",
                                      usage={"total_tokens": 5}, assistant_content_chars=12,
                                      base_url="https://example.invalid", model="configured-model")
            self.assertEqual(seen, ["served-model"])
            # Nothing but the model name, and never the configured one the runtime also passes.
            for value in seen:
                self.assertNotIn("example.invalid", value)
                self.assertNotIn("configured-model", value)
            # An unrelated hook must still reach the original dispatcher. Comparing return values
            # is not enough, because an unregistered hook returns nothing either way; what matters
            # is that the original was called, so it is wrapped and counted.
            reached = []
            lifecycle.invoke_hook("some_other_hook", task_id="t1")
            self.assertEqual(reached, ["some_other_hook"],
                             "a foreign hook must be forwarded to the original dispatcher")
            self.assertFalse(lifecycle.has_hook("some_other_hook"),
                             "only post_api_request may be force-enabled")
            self.assertEqual(seen, ["served-model"], "a foreign hook must not record a model")
        finally:
            lifecycle.has_hook, lifecycle.invoke_hook = original_has, original_invoke
            for name in ("_harnes_identity_collector", "_harnes_response_models"):
                if hasattr(lifecycle, name):
                    delattr(lifecycle, name)

    def test_a_run_with_no_collected_model_still_refuses(self):
        identity, reason = served_identity({"model": "configured-model"}, [])
        self.assertIsNone(identity)
        self.assertEqual(reason, "runtime_did_not_expose_a_served_model_identity")


if __name__ == "__main__":
    unittest.main()
