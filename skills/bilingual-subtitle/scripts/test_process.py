import os
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process


class DownloadFromUrlTests(unittest.TestCase):
    def test_uses_python_module_for_yt_dlp_on_windows_safe_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            with (
                patch.object(process.subprocess, "run", return_value=completed) as run,
                patch.object(os, "listdir", return_value=[]),
            ):
                with self.assertRaises(SystemExit):
                    process.download_from_url(
                        "https://x.com/example/status/123",
                        tmpdir,
                        srt_only=True,
                        language="zh",
                    )

        commands = [call.args[0] for call in run.call_args_list]
        self.assertGreaterEqual(len(commands), 2)
        for command in commands:
            self.assertEqual(command[:3], [sys.executable, "-m", "yt_dlp"])

    def test_returns_largest_downloaded_audio_when_url_has_multiple_media(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            small = os.path.join(tmpdir, "short.mp3")
            large = os.path.join(tmpdir, "main.mp3")
            Path(small).write_bytes(b"1")
            Path(large).write_bytes(b"1" * 10)
            completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            with (
                patch.object(process.subprocess, "run", return_value=completed),
                patch.object(os, "listdir", side_effect=[[], ["short.mp3", "main.mp3"]]),
            ):
                media_file, cc_srt_files = process.download_from_url(
                    "https://x.com/example/status/123",
                    tmpdir,
                    srt_only=True,
                    language="zh",
                )

        self.assertEqual(media_file, large)
        self.assertEqual(cc_srt_files, [])


if __name__ == "__main__":
    unittest.main()
