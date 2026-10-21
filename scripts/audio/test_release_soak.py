import unittest
from unittest.mock import patch
import release_soak

class ReleaseGuards(unittest.TestCase):
    def test_debug_or_missing_package_flags_cannot_be_measured_as_release(self):
        for raw in ['', 'flags=[ HAS_CODE DEBUGGABLE ALLOW_BACKUP ]']:
            with self.assertRaises(RuntimeError): release_soak.release_flags(raw)
        self.assertEqual(release_soak.release_flags(' flags=[ HAS_CODE ALLOW_BACKUP ]'), 'HAS_CODE ALLOW_BACKUP')

    def test_physical_serial_is_rejected_before_accessing_adb(self):
        with patch('sys.argv', ['release_soak.py','--serial','physical-123','--output','/tmp/unused-release-test']), patch('release_soak.soak.Device') as device:
            with self.assertRaises(SystemExit): release_soak.main()
            device.assert_not_called()

if __name__ == '__main__': unittest.main()
