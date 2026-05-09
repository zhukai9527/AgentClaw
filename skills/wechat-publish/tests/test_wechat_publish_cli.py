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
        return self.make_article_with_content(
            root,
            "测试标题",
            "\n".join(
                [
                    "这是一段用于验收的正文，包含 AgentClaw 和微信公众号发布。",
                    "",
                    "- 第一项",
                    "- 第二项",
                ]
            ),
        )

    def make_article_with_content(self, root: Path, title: str, body: str) -> Path:
        article = root / "article.md"
        article.write_text(
            "\n".join(
                [
                    f"# {title}",
                    "",
                    body,
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
        self.assertIn("auto", data["themes"])
        self.assertIn("tech-modern", data["themes"])
        self.assertEqual(data["default_theme"], "auto")
        self.assertEqual(data["auto_theme"]["mapping"]["reading_notes"], "minimal")
        self.assertEqual(data["auto_theme"]["mapping"]["brand_product"], "sage")
        self.assertEqual(data["auto_theme"]["mapping"]["technical"], "tech-modern")
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
        self.assertNotIn("<h1", html.lower())

    def test_auto_theme_selects_minimal_for_reading_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = self.make_article_with_content(
                root,
                "《纳瓦尔宝典》读书笔记",
                "\n".join(
                    [
                        "今天整理一段书摘和阅读心得。",
                        "",
                        "> 金句：自由来自长期主义和判断力。",
                    ]
                ),
            )
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
            manifest = json.loads(
                Path(data["artifacts"]["manifest_json"]).read_text(encoding="utf-8")
            )

        self.assertEqual(data["theme_selection"]["requested"], "auto")
        self.assertEqual(data["theme_selection"]["resolved"], "minimal")
        self.assertEqual(data["theme_selection"]["source"], "heuristic")
        self.assertIn("读书笔记", data["theme_selection"]["reason"])
        self.assertEqual(manifest["theme"], "minimal")
        self.assertEqual(manifest["theme_selection"], data["theme_selection"])

    def test_reading_note_genre_overrides_technical_terms(self):
        with tempfile.TemporaryDirectory() as tmp:
            article = self.make_article_with_content(
                Path(tmp),
                "《AI Agent 工程实践》读书笔记",
                "这篇阅读心得摘录了 API、CLI、代码、配置、部署和工程实践里的关键章节。",
            )
            data = self.assert_success(
                run_cli("inspect", str(article), "--json"),
                "INSPECT_READY",
            )

        self.assertEqual(data["theme"], "minimal")
        self.assertEqual(data["theme_selection"]["resolved"], "minimal")
        self.assertIn("读书笔记", data["theme_selection"]["reason"])

    def test_auto_theme_selects_sage_for_agentclaw_brand_posts(self):
        with tempfile.TemporaryDirectory() as tmp:
            article = self.make_article_with_content(
                Path(tmp),
                "AgentClaw 产品发布复盘",
                "这次品牌公众号发布会介绍 AgentClaw 的产品能力、路线图和运营复盘。",
            )
            data = self.assert_success(
                run_cli("inspect", str(article), "--json"),
                "INSPECT_READY",
            )

        self.assertEqual(data["theme"], "sage")
        self.assertEqual(data["theme_selection"]["requested"], "auto")
        self.assertEqual(data["theme_selection"]["resolved"], "sage")
        self.assertEqual(data["theme_selection"]["source"], "heuristic")

    def test_auto_theme_selects_tech_modern_for_technical_articles(self):
        with tempfile.TemporaryDirectory() as tmp:
            article = self.make_article_with_content(
                Path(tmp),
                "CLI API 部署教程",
                "本文讲解代码实现、API 调用、CLI 参数、配置文件和部署流程。",
            )
            data = self.assert_success(
                run_cli("inspect", str(article), "--json"),
                "INSPECT_READY",
            )

        self.assertEqual(data["theme"], "tech-modern")
        self.assertEqual(data["theme_selection"]["requested"], "auto")
        self.assertEqual(data["theme_selection"]["resolved"], "tech-modern")
        self.assertEqual(data["theme_selection"]["source"], "heuristic")

    def test_explicit_theme_overrides_auto_theme_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            article = self.make_article_with_content(
                Path(tmp),
                "《纳瓦尔宝典》读书笔记",
                "今天整理一段书摘和阅读心得。",
            )
            data = self.assert_success(
                run_cli("inspect", str(article), "--theme", "sage", "--json"),
                "INSPECT_READY",
            )

        self.assertEqual(data["theme"], "sage")
        self.assertEqual(data["theme_selection"]["requested"], "sage")
        self.assertEqual(data["theme_selection"]["resolved"], "sage")
        self.assertEqual(data["theme_selection"]["source"], "explicit")

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

            article_payload = json.loads(
                Path(data["artifacts"]["article_json"]).read_text(encoding="utf-8")
            )
            manifest = json.loads(
                Path(data["artifacts"]["manifest_json"]).read_text(encoding="utf-8")
            )

        self.assertEqual(article_payload["title"], "测试标题")
        self.assertNotIn("<h1", article_payload["content"].lower())
        self.assertIn("这是一段用于验收的正文", article_payload["content"])
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
