"""Offline regression of the actual process-local Hermes credential adapter."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime' / 'hermes-agent'))
sys.path.insert(0, str(ROOT / 'adapters' / 'hermes'))


class CredentialRegression(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix='harnes2-credentials-')
        self.addCleanup(self.home.cleanup)
        self.environment = patch.dict(os.environ, {
            'HERMES_HOME': self.home.name,
            'PARTNER_MODEL_API_KEY': 'invented-primary',
            'PARTNER_MODEL_API_KEY_SECONDARY': 'invented-secondary',
            'PARTNER_MODEL_API_KEY_TERTIARY': 'invented-tertiary',
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.network = patch('socket.socket.connect', side_effect=AssertionError('Network forbidden'))
        self.connect = self.network.start()
        self.addCleanup(self.network.stop)
        from credentials import runtime_credentials
        self.credentials = runtime_credentials

    def tearDown(self):
        self.connect.assert_not_called()
        self.assertFalse(list(Path(self.home.name).rglob('auth.json')))

    def test_primary_required_even_if_fallback_exists(self):
        os.environ['PARTNER_MODEL_API_KEY'] = ''
        with self.assertRaisesRegex(RuntimeError, 'required'):
            self.credentials('https://invalid.example/v1')

    def test_three_keys_keep_order_and_same_provider(self):
        key, pool = self.credentials('https://invalid.example/v1')
        self.assertEqual(key, 'invented-primary')
        self.assertEqual([entry.id for entry in pool.entries()], ['primary', 'secondary', 'tertiary'])
        self.assertTrue(all(entry.provider == 'custom' for entry in pool.entries()))
        self.assertTrue(all(entry.base_url == 'https://invalid.example/v1' for entry in pool.entries()))

    def test_duplicate_keys_are_not_added(self):
        os.environ['PARTNER_MODEL_API_KEY_SECONDARY'] = ' invented-primary '
        _, pool = self.credentials('https://invalid.example/v1')
        self.assertEqual([entry.id for entry in pool.entries()], ['primary', 'tertiary'])

    def test_healthy_keys_do_not_rotate(self):
        _, pool = self.credentials('https://invalid.example/v1')
        self.assertEqual([pool.select().id for _ in range(5)], ['primary'] * 5)

    def test_key_failures_rotate_in_memory_without_auth_persistence(self):
        _, pool = self.credentials('https://invalid.example/v1')
        with patch('agent.credential_pool.persist_pool_entries') as persist:
            self.assertEqual(pool.select().id, 'primary')
            self.assertEqual(pool.mark_exhausted_and_rotate(status_code=429, credential_id='primary').id, 'secondary')
            self.assertEqual(pool.mark_exhausted_and_rotate(status_code=429, credential_id='secondary').id, 'tertiary')
            persist.assert_not_called()


if __name__ == '__main__':
    unittest.main()
