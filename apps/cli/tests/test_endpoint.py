import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import endpoint


class Discovery(unittest.TestCase):
    def test_signal_probe_outcomes(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'ArdiaControl.json'
            path.write_text(json.dumps({'port': 9222, 'browser': '/devtools/browser/abc', 'token': 't' * 32, 'pid': os.getpid()}))
            path.chmod(0o600)
            for error in (None, PermissionError(1, 'Operation not permitted')):
                with self.subTest(error=error), mock.patch.object(endpoint.os, 'kill', side_effect=error):
                    found = endpoint.from_control_file(path)
                    self.assertEqual(found.ws, 'ws://127.0.0.1:9222/devtools/browser/abc?token=' + 't' * 32)
                    self.assertFalse(found.explicit)
            with mock.patch.object(endpoint.os, 'kill', side_effect=ProcessLookupError()):
                with self.assertRaisesRegex(endpoint.EndpointError, "Ardia isn't running"):
                    endpoint.from_control_file(path)

    def test_denied_probe_keeps_discovery_file_checks(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'ArdiaControl.json'
            path.write_text(json.dumps({'port': 9222, 'browser': '/devtools/browser/abc', 'token': 't' * 32, 'pid': os.getpid()}))
            path.chmod(0o600)
            with mock.patch.object(endpoint.os, 'kill', side_effect=PermissionError()):
                path.chmod(0o644)
                with self.assertRaisesRegex(endpoint.EndpointError, 'mode 0600'):
                    endpoint.from_control_file(path)
                path.chmod(0o600)
                with mock.patch.object(endpoint.os, 'getuid', return_value=os.getuid() + 1):
                    with self.assertRaisesRegex(endpoint.EndpointError, 'belongs to another user'):
                        endpoint.from_control_file(path)
                link = Path(root) / 'link'
                link.symlink_to(path)
                with self.assertRaisesRegex(endpoint.EndpointError, 'symbolic link'):
                    endpoint.from_control_file(link)
                with mock.patch.object(endpoint.os, 'open', side_effect=PermissionError(13, 'Permission denied')):
                    with self.assertRaisesRegex(endpoint.EndpointError, 'Permission denied'):
                        endpoint.from_control_file(path)
