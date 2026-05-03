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
                patch.object(process, "find_ffmpeg_location", return_value=tmpdir),
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
                patch.object(process, "find_ffmpeg_location", return_value=tmpdir),
            ):
                media_file, cc_srt_files = process.download_from_url(
                    "https://x.com/example/status/123",
                    tmpdir,
                    srt_only=True,
                    language="zh",
                )

        self.assertEqual(media_file, large)
        self.assertEqual(cc_srt_files, [])

    def test_srt_only_url_download_uses_audio_with_explicit_ffmpeg_location(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            audio = os.path.join(tmpdir, "main.mp3")
            Path(audio).write_bytes(b"1" * 10)
            completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            with (
                patch.object(process.subprocess, "run", return_value=completed) as run,
                patch.object(os, "listdir", side_effect=[[], ["main.mp3"]]),
                patch.object(process, "find_ffmpeg_location", return_value=tmpdir, create=True),
            ):
                media_file, cc_srt_files = process.download_from_url(
                    "https://x.com/example/status/123",
                    tmpdir,
                    srt_only=True,
                    language="zh",
                )

        commands = [call.args[0] for call in run.call_args_list]
        audio_command = commands[1]
        self.assertEqual(media_file, audio)
        self.assertEqual(cc_srt_files, [])
        self.assertIn("-x", audio_command)
        self.assertIn("--playlist-items", audio_command)
        self.assertIn("1", audio_command)
        self.assertIn("-f", audio_command)
        self.assertTrue(any("worst" in arg for arg in audio_command))
        self.assertIn("--ffmpeg-location", audio_command)
        self.assertIn(tmpdir, audio_command)
        self.assertNotIn("--merge-output-format", audio_command)

    def test_write_plain_text_removes_timestamp_structure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = os.path.join(tmpdir, "subtitle.txt")

            process.write_plain_text(
                [
                    {"start": 0, "end": 1, "text": " first line "},
                    {"start": 1, "end": 2, "text": "second line"},
                ],
                output,
            )

            text = Path(output).read_text(encoding="utf-8")

        self.assertEqual(text, "first line\nsecond line\n")
        self.assertNotIn("-->", text)
        self.assertNotIn("00:00", text)


if __name__ == "__main__":
    unittest.main()
