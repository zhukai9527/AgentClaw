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
    def test_converts_msys_path_to_windows_path(self):
        self.assertEqual(process.msys_to_windows_path("/e/Aibote"), "E:\\Aibote")
        self.assertEqual(
            process.msys_to_windows_path("/e/So-VITS-SVC/so-vits-svc/ffmpeg/bin"),
            "E:\\So-VITS-SVC\\so-vits-svc\\ffmpeg\\bin",
        )

    def test_finds_ffmpeg_location_from_ffprobe_when_ffmpeg_dir_is_incomplete(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ffmpeg_only = Path(tmpdir) / "ffmpeg-only"
            complete = Path(tmpdir) / "complete"
            ffmpeg_only.mkdir()
            complete.mkdir()
            (ffmpeg_only / "ffmpeg.exe").write_bytes(b"")
            (complete / "ffmpeg.exe").write_bytes(b"")
            (complete / "ffprobe.exe").write_bytes(b"")

            with (
                patch.dict(os.environ, {}, clear=True),
                patch.object(process.shutil, "which", side_effect=lambda name: str(ffmpeg_only / "ffmpeg.exe") if name == "ffmpeg" else str(complete / "ffprobe.exe")),
                patch.object(process.subprocess, "run") as run,
            ):
                found = process.find_ffmpeg_location()

        self.assertEqual(found, str(complete))
        run.assert_not_called()

    def test_finds_ffmpeg_location_from_msys_env_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            drive_root = Path(tmpdir) / "E"
            complete = drive_root / "tools" / "ffmpeg" / "bin"
            complete.mkdir(parents=True)
            (complete / "ffmpeg.exe").write_bytes(b"")
            (complete / "ffprobe.exe").write_bytes(b"")

            with (
                patch.dict(os.environ, {"FFMPEG_LOCATION": "/e/tools/ffmpeg/bin"}, clear=True),
                patch.object(process, "msys_drive_root", return_value=str(drive_root)),
                patch.object(process.shutil, "which", return_value=None),
            ):
                found = process.find_ffmpeg_location()

        self.assertEqual(found, str(complete))

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

    def test_fast_transcript_url_download_uses_video_container_not_hls_audio(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video = os.path.join(tmpdir, "main.mp4")
            Path(video).write_bytes(b"1" * 10)
            completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            with (
                patch.object(process.subprocess, "run", return_value=completed) as run,
                patch.object(os, "listdir", side_effect=[[], ["main.mp4"]]),
                patch.object(process, "find_ffmpeg_location", return_value=tmpdir, create=True),
            ):
                media_file, cc_srt_files = process.download_from_url(
                    "https://x.com/example/status/123",
                    tmpdir,
                    srt_only=True,
                    language="zh",
                    prefer_video=True,
                )

        commands = [call.args[0] for call in run.call_args_list]
        video_command = commands[1]
        self.assertEqual(media_file, video)
        self.assertEqual(cc_srt_files, [])
        self.assertIn("-f", video_command)
        self.assertTrue(any("bv*" in arg for arg in video_command))
        self.assertIn("--merge-output-format", video_command)
        self.assertNotIn("-x", video_command)

    def test_url_download_retries_once_on_transient_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video = os.path.join(tmpdir, "main.mp4")
            failed = CompletedProcess(args=[], returncode=1, stdout="", stderr="EOF occurred in violation of protocol")
            succeeded = CompletedProcess(args=[], returncode=0, stdout="", stderr="")
            calls = {"count": 0}

            def fake_run(*args, **kwargs):
                calls["count"] += 1
                if calls["count"] == 2:
                    return failed
                Path(video).write_bytes(b"1" * 10)
                return succeeded

            with (
                patch.object(process.subprocess, "run", side_effect=fake_run) as run,
                patch.object(os, "listdir", side_effect=[[], ["main.mp4"]]),
                patch.object(process, "find_ffmpeg_location", return_value=tmpdir, create=True),
            ):
                media_file, cc_srt_files = process.download_from_url(
                    "https://x.com/example/status/123",
                    tmpdir,
                    srt_only=True,
                    language="zh",
                    prefer_video=True,
                )

        self.assertEqual(media_file, video)
        self.assertEqual(cc_srt_files, [])
        self.assertEqual(run.call_count, 3)

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

    def test_write_plain_text_creates_parent_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = os.path.join(tmpdir, "missing", "subtitle.txt")

            process.write_plain_text(
                [{"start": 0, "end": 1, "text": "hello"}],
                output,
            )

            text = Path(output).read_text(encoding="utf-8")

        self.assertEqual(text, "hello\n")


if __name__ == "__main__":
    unittest.main()
