"""Pure checks of the emulator QA harness; these tests do not call ADB."""
import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import soak
import unittest
from soak import button_center, memory_summary, validate_samples


class SoakTest(unittest.TestCase):
    def button(self, label="Start microphone test", enabled="true", bounds="[10,20][110,80]"):
        return f'<hierarchy><node class="android.widget.Button" content-desc="{label}" enabled="{enabled}" bounds="{bounds}" /></hierarchy>'

    def test_start_requires_explicit_enabled_control_in_either_language(self):
        for label in ["Start microphone test", "Spustit test mikrofonu"]:
            self.assertEqual(button_center(self.button(label)), (60, 50))
        for xml in [self.button(enabled="false"), self.button("Stop and keep local recording"), '<hierarchy/>']:
            with self.assertRaises(RuntimeError):
                button_center(xml)

    def test_duplicate_and_offscreen_controls_are_rejected(self):
        duplicate = self.button().replace('</hierarchy>', self.button().replace('<hierarchy>', ''))
        for xml in [duplicate, self.button(bounds="[10,80][110,20]"), self.button(bounds="invalid")]:
            with self.assertRaises(RuntimeError):
                button_center(xml)

    def samples(self):
        return [dict(elapsed_s=1, bytes=28, pid="123", foreground=True, microphone_active=True),
                dict(elapsed_s=60, bytes=700000, pid="123", foreground=True, microphone_active=True)]

    def test_healthy_samples_reach_duration(self):
        validate_samples(self.samples(), 60)

    def test_short_inactive_or_restarted_run_cannot_pass(self):
        with self.assertRaises(RuntimeError):
            validate_samples(self.samples(), 61)
        for key, value in [("pid", "456"), ("foreground", False), ("microphone_active", False)]:
            samples = self.samples()
            samples[1][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                validate_samples(samples, 60)

    def test_file_must_grow_and_samples_must_be_ordered(self):
        for key, value in [("bytes", 28), ("bytes", 0), ("elapsed_s", 1)]:
            samples = copy.deepcopy(self.samples())
            samples[1][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                validate_samples(samples, 1)

    def test_memory_fields_are_required_without_guessing_zero(self):
        self.assertEqual(memory_summary("TOTAL PSS: 245678 TOTAL RSS: 365432"),
                         {"pss_kib": 245678, "rss_kib": 365432})
        with self.assertRaises(RuntimeError):
            memory_summary("TOTAL PSS: 245678")

    def test_non_emulator_is_rejected_before_capture(self):
        with tempfile.TemporaryDirectory() as root, patch.object(soak, "Device") as factory, patch.object(soak.signal, "signal"), contextlib.redirect_stdout(io.StringIO()):
            output = str(Path(root, "run"))
            factory.return_value.shell.return_value = "0"
            with patch("sys.argv", ["soak.py", "--output", output]):
                with self.assertRaisesRegex(RuntimeError, "not an emulator"):
                    soak.main()
            factory.return_value.run.assert_not_called()
            factory.return_value.shell.assert_called_once_with("getprop", "ro.kernel.qemu")
            self.assertEqual(json.loads(Path(output, "report.json").read_text())["status"], "failed")

    def test_uncertain_start_attempt_still_cleans_up_and_restores_timeout(self):
        with tempfile.TemporaryDirectory() as root, patch.object(soak, "Device") as factory, patch.object(soak.signal, "signal"), patch.object(soak.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            output = str(Path(root, "run"))
            device = factory.return_value
            device.foreground.return_value = True
            device.microphone_active.side_effect = [False, True]
            device.files.return_value = set()
            def shell(*args):
                if args[:2] == ("getprop", "ro.kernel.qemu"):
                    return "1"
                if args[:2] == ("settings", "get"):
                    return "12345"
                if args[:2] == ("uiautomator", "dump"):
                    return "UI hierchary dumped to /sdcard/agent-audio-soak.xml"
                if args[:2] == ("input", "tap"):
                    raise RuntimeError("uncertain input failure")
                return "test"
            device.shell.side_effect = shell
            device.run.side_effect = lambda *args, **kwargs: "OK" if args[0] == "emu" else self.button()
            with patch("sys.argv", ["soak.py", "--output", output]):
                with self.assertRaisesRegex(RuntimeError, "uncertain input failure"):
                    soak.main()
            device.shell.assert_any_call("input", "keyevent", "3")
            device.shell.assert_any_call("am", "force-stop", soak.PACKAGE)
            device.shell.assert_any_call("settings", "put", "system", "screen_off_timeout", "12345")
            self.assertEqual(json.loads(Path(output, "report.json").read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
