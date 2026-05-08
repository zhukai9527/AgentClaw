import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CLI = REPO_ROOT / "skills" / "wechat-publish" / "scripts" / "wechat_publish.py"
SKILL = REPO_ROOT / "skills" / "wechat-publish" / "SKILL.md"


def run_cli(*args: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"command failed: {result.returncode}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"stdout is not JSON: {result.stdout}") from exc
    return payload


class WechatPublishCliTest(unittest.TestCase):
    def make_article(self, root: Path) -> Path:
        article = root / "article.md"
        article.write_text(
            "\n".join(
                [
                    "# 测试标题",
                    "",
                    "这是一段用于验收的正文，包含 AgentClaw 和微信公众号发布。",
                    "",
                    "- 第一项",
                    "- 第二项",
                ]
            ),
            encoding="utf-8",
        )
        return article

    def assert_success(self, payload: dict, code: str) -> dict:
        self.assertIs(payload.get("success"), True)
        self.assertEqual(payload.get("code"), code)
        data = payload.get("data")
        self.assertIsInstance(data, dict)
        return data

    def test_capabilities_exposes_runtime_contract(self):
        data = self.assert_success(
            run_cli("capabilities", "--json"),
            "CAPABILITIES_SHOWN",
        )

        self.assertIn("publish", data["commands"])
        self.assertIn("inspect", data["commands"])
        self.assertIn("preview", data["commands"])
        self.assertIn("tech-modern", data["themes"])
        self.assertIn("dark", data["cover_schemes"])
        self.assertEqual(data["json_contract"], "success/code/message/data")
        self.assertIn("--out-dir", data["canonical_args"]["publish"])
        self.assertNotIn("--out", data["canonical_args"]["publish"])

    def test_inspect_reports_metadata_readiness_and_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            article = self.make_article(Path(tmp))
            data = self.assert_success(
                run_cli("inspect", str(article), "--draft", "--json"),
                "INSPECT_READY",
            )

        self.assertEqual(data["metadata"]["title"]["value"], "测试标题")
        self.assertEqual(data["metadata"]["title"]["source"], "markdown.heading")
        self.assertLessEqual(data["metadata"]["digest"]["length"], 120)
        self.assertIs(data["readiness"]["convert_ready"], True)
        self.assertIs(data["readiness"]["draft_ready"], True)
        self.assertEqual(data["checks"], [])
        self.assertIs(data["cover"]["generated"], True)

    def test_preview_writes_html_without_draft_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = self.make_article(root)
            data = self.assert_success(
                run_cli("preview", str(article), "--out-dir", str(root), "--json"),
                "PREVIEW_READY",
            )
            preview = Path(data["artifacts"]["preview_html"])
            draft = root / "draft.json"

            self.assertTrue(preview.is_file())
            self.assertFalse(draft.exists())
            html = preview.read_text(encoding="utf-8")

        self.assertIn("<!doctype html>", html.lower())
        self.assertIn('<meta charset="utf-8">', html.lower())
        self.assertIn("<title>测试标题</title>", html)
        self.assertIn("测试标题", html)

    def test_publish_dry_run_returns_json_contract_and_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = self.make_article(root)
            data = self.assert_success(
                run_cli(
                    "publish",
                    str(article),
                    "--title",
                    "测试标题",
                    "--subtitle",
                    "dry run",
                    "--out-dir",
                    str(root),
                    "--dry-run",
                    "--skip-cover",
                    "--json",
                ),
                "DRAFT_DRY_RUN_READY",
            )

            self.assertIsNone(data["draft_media_id"])
            self.assertEqual(data["mode"], "dry-run")
            self.assertTrue(Path(data["artifacts"]["article_json"]).is_file())
            self.assertTrue(Path(data["artifacts"]["draft_json"]).is_file())
            self.assertTrue(Path(data["artifacts"]["manifest_json"]).is_file())
            self.assertIsNone(data["artifacts"]["cover"])

            manifest = json.loads(
                Path(data["artifacts"]["manifest_json"]).read_text(encoding="utf-8")
            )

        self.assertEqual(manifest["mode"], "dry-run")
        self.assertEqual(manifest["code"], "DRAFT_DRY_RUN_READY")
        self.assertEqual(manifest["source_file"], str(article))
        self.assertEqual(manifest["artifacts"]["draft_json"], data["artifacts"]["draft_json"])

    def test_publish_uses_markdown_h1_as_default_cover_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = self.make_article(root)
            data = self.assert_success(
                run_cli(
                    "publish",
                    str(article),
                    "--out-dir",
                    str(root),
                    "--dry-run",
                    "--skip-cover",
                    "--json",
                ),
                "DRAFT_DRY_RUN_READY",
            )

            draft = json.loads(
                Path(data["artifacts"]["draft_json"]).read_text(encoding="utf-8")
            )

        self.assertEqual(draft["articles"][0]["title"], "测试标题")

    def test_cli_rejects_abbreviated_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = self.make_article(root)
            result = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    "publish",
                    str(article),
                    "--out",
                    str(root),
                    "--dry-run",
                    "--json",
                ],
                cwd=REPO_ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("the following arguments are required: --out-dir", result.stderr)

    def test_skip_cover_is_hidden_from_help(self):
        result = subprocess.run(
            [sys.executable, str(CLI), "publish", "--help"],
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.assertEqual(result.returncode, 0)
        self.assertNotIn("--skip-cover", result.stdout)

    def test_skill_primary_path_uses_unified_cli(self):
        text = SKILL.read_text(encoding="utf-8")

        self.assertIn("wechat_publish.py publish", text)
        self.assertIn("wechat_publish.py inspect", text)
        self.assertNotIn("publish_article.py {INPUT_MD}", text)


if __name__ == "__main__":
    unittest.main()
