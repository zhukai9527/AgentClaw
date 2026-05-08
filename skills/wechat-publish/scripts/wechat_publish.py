#!/usr/bin/env python3
"""
Deterministic CLI envelope for the wechat-publish skill.

Stdout is JSON when --json is provided. Operational logs from wrapped scripts
are captured so agents can rely on the success/code/message/data contract.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cover as cover_script
import md2wx
import publish_draft


TITLE_LIMIT = 64
AUTHOR_LIMIT = 16
DIGEST_LIMIT = 120
JSON_CONTRACT = "success/code/message/data"


class StrictArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)


def response(success: bool, code: str, message: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "success": success,
        "code": code,
        "message": message,
        "data": data,
    }


def print_response(payload: dict[str, Any], json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, ensure_ascii=False))
        return
    print(f"{payload['code']}: {payload['message']}")
    data = payload.get("data")
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, (str, int, float)) or value is None:
                print(f"{key}={value}")


def fail(code: str, message: str, json_output: bool, data: dict[str, Any] | None = None) -> int:
    print_response(response(False, code, message, data or {}), json_output)
    return 1


def read_markdown(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"markdown not found: {path}")
    return path.read_text(encoding="utf-8-sig")


def clean_inline_markdown(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_`>#|~-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def markdown_without_first_h1(markdown: str) -> str:
    lines = markdown.splitlines()
    result: list[str] = []
    in_code = False
    removed = False

    for line in lines:
        if line.startswith("```"):
            in_code = not in_code
            result.append(line)
            continue
        if not removed and not in_code and re.match(r"^#\s+.+", line):
            removed = True
            continue
        result.append(line)

    return "\n".join(result)


def resolve_title(markdown: str, path: Path, override: str = "") -> dict[str, Any]:
    if override.strip():
        value = override.strip()
        source = "cli.title"
    else:
        match = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
        if match:
            value = match.group(1).strip()
            source = "markdown.heading"
        else:
            value = path.stem
            source = "filename"
    return metadata_field(value, source, TITLE_LIMIT)


def resolve_digest(markdown: str, override: str = "") -> dict[str, Any]:
    if override.strip():
        return metadata_field(override.strip(), "cli.digest", DIGEST_LIMIT)

    plain_lines: list[str] = []
    in_code = False
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if (
            in_code
            or not line
            or line.startswith("#")
            or line.startswith(">")
            or line.startswith("|")
        ):
            continue
        plain = clean_inline_markdown(line)
        if plain:
            plain_lines.append(plain)

    digest = " ".join(plain_lines)[:DIGEST_LIMIT]
    return metadata_field(digest, "markdown.body", DIGEST_LIMIT)


def metadata_field(value: str, source: str, limit: int) -> dict[str, Any]:
    return {
        "value": value,
        "source": source,
        "limit": limit,
        "length": len(value),
        "valid": bool(value.strip()) and len(value) <= limit,
    }


def inspect_article(
    markdown_path: Path,
    *,
    theme: str,
    title: str = "",
    digest: str = "",
    author: str = "爬爬虾",
    draft: bool = False,
    cover_path: str = "",
    thumb_media_id: str = "",
) -> dict[str, Any]:
    markdown = read_markdown(markdown_path)
    title_state = resolve_title(markdown, markdown_path, title)
    digest_state = resolve_digest(markdown, digest)
    author_state = metadata_field(author, "cli.author", AUTHOR_LIMIT)
    checks: list[dict[str, str]] = []

    for field_name, state, code in [
        ("title", title_state, "TITLE_INVALID"),
        ("author", author_state, "AUTHOR_INVALID"),
        ("digest", digest_state, "DIGEST_INVALID"),
    ]:
        if not state["valid"]:
            checks.append(
                {
                    "level": "error",
                    "code": code,
                    "field": field_name,
                    "message": f"{field_name} must be non-empty and within {state['limit']} characters",
                }
            )

    if theme not in md2wx.THEMES:
        checks.append(
            {
                "level": "error",
                "code": "THEME_UNKNOWN",
                "field": "theme",
                "message": f"unknown theme: {theme}",
            }
        )

    cover_exists = False
    if cover_path:
        cover_exists = Path(cover_path).is_file()
        if not cover_exists:
            checks.append(
                {
                    "level": "error",
                    "code": "COVER_NOT_FOUND",
                    "field": "cover",
                    "message": f"cover image not found: {cover_path}",
                }
            )

    generated_cover_available = importlib.util.find_spec("playwright") is not None
    if draft and not (cover_exists or bool(thumb_media_id.strip())) and not generated_cover_available:
        checks.append(
            {
                "level": "error",
                "code": "COVER_GENERATOR_UNAVAILABLE",
                "field": "cover",
                "message": "draft creation requires Playwright-generated cover, --cover, or --thumb-media-id",
            }
        )

    blocking = {check["code"] for check in checks if check["level"] == "error"}
    convert_ready = not (blocking & {"TITLE_INVALID", "AUTHOR_INVALID", "DIGEST_INVALID", "THEME_UNKNOWN"})
    draft_ready = convert_ready and (not draft or not (blocking & {"COVER_REQUIRED", "COVER_NOT_FOUND"}))

    return {
        "source_file": str(markdown_path),
        "metadata": {
            "title": title_state,
            "author": author_state,
            "digest": digest_state,
        },
        "theme": theme,
        "cover": {
            "path": cover_path or None,
            "exists": cover_exists,
            "thumb_media_id": thumb_media_id or None,
            "generated": not cover_path and not thumb_media_id,
        },
        "readiness": {
            "convert_ready": convert_ready,
            "draft_ready": draft_ready,
        },
        "checks": checks,
    }


def write_article_json(
    markdown_path: Path,
    *,
    theme: str,
    out_path: Path,
    title: str = "",
    digest: str = "",
) -> dict[str, Any]:
    markdown = read_markdown(markdown_path)
    title_state = resolve_title(markdown, markdown_path, title)
    digest_state = resolve_digest(markdown, digest)
    html = md2wx.md_to_wx_html(markdown_without_first_h1(markdown), theme)
    article = {
        "title": title_state["value"],
        "digest": digest_state["value"],
        "content": html,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(article, ensure_ascii=False), encoding="utf-8")
    return article


def standalone_preview_html(title: str, body_html: str) -> str:
    escaped_title = (
        title.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="zh-CN">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            f"<title>{escaped_title}</title>",
            "</head>",
            '<body style="margin:0;background:#f6f7f9;">',
            body_html,
            "</body>",
            "</html>",
        ]
    )


def run_cover(title: str, subtitle: str, scheme: str, out_path: Path) -> None:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "cover.py"),
        title,
        subtitle,
        "--scheme",
        scheme,
        "--out",
        str(out_path),
    ]
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"cover generation failed: {detail}")


def write_draft(
    article_json: Path,
    *,
    out_path: Path,
    author: str,
    content_source_url: str,
    cover_path: Path | None,
    thumb_media_id: str,
    dry_run: bool,
) -> str | None:
    article = publish_draft.read_article(article_json)
    media_id = thumb_media_id
    if dry_run:
        if not media_id:
            media_id = "test_thumb"
    else:
        access_token = publish_draft.get_access_token()
        if not media_id:
            if cover_path is None:
                raise ValueError("live publish requires cover_path or thumb_media_id")
            media_id = publish_draft.upload_cover(access_token, cover_path)

    draft = publish_draft.build_draft(article, media_id, author, content_source_url)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")

    if dry_run:
        return None
    if thumb_media_id:
        access_token = publish_draft.get_access_token()
    return publish_draft.create_draft(access_token, draft)


def capabilities() -> dict[str, Any]:
    return {
        "commands": ["capabilities", "inspect", "preview", "publish"],
        "themes": sorted(md2wx.THEMES.keys()),
        "cover_schemes": sorted(cover_script.SCHEMES.keys()),
        "json_contract": JSON_CONTRACT,
        "canonical_args": {
            "inspect": ["--draft", "--theme", "--article-title", "--digest", "--author", "--cover", "--thumb-media-id", "--json"],
            "preview": ["--out-dir", "--theme", "--article-title", "--digest", "--author", "--json"],
            "publish": ["--out-dir", "--theme", "--article-title", "--digest", "--author", "--title", "--subtitle", "--scheme", "--dry-run", "--thumb-media-id", "--content-source-url", "--json"],
        },
        "limits": {
            "title": TITLE_LIMIT,
            "author": AUTHOR_LIMIT,
            "digest": DIGEST_LIMIT,
        },
        "dependencies": {
            "playwright": importlib.util.find_spec("playwright") is not None,
        },
        "side_effects": {
            "capabilities": "none",
            "inspect": "none",
            "preview": "writes local HTML only",
            "publish": "creates WeChat draft unless --dry-run is used",
        },
    }


def add_common_article_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("markdown", help="Input Markdown file")
    parser.add_argument("--theme", default="tech-modern", choices=list(md2wx.THEMES.keys()))
    parser.add_argument("--article-title", default="", help="Override article metadata title")
    parser.add_argument("--digest", default="", help="Override article digest")
    parser.add_argument("--author", default="爬爬虾", help="Article author")
    parser.add_argument("--json", action="store_true", help="Emit JSON envelope")


def build_parser() -> argparse.ArgumentParser:
    parser = StrictArgumentParser(description="wechat-publish deterministic CLI")
    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
        parser_class=StrictArgumentParser,
    )

    p_cap = subparsers.add_parser(
        "capabilities",
        help="Show runtime capabilities",
    )
    p_cap.add_argument("--json", action="store_true", help="Emit JSON envelope")

    p_inspect = subparsers.add_parser(
        "inspect",
        help="Inspect article readiness",
    )
    add_common_article_args(p_inspect)
    p_inspect.add_argument("--draft", action="store_true", help="Evaluate draft readiness")
    p_inspect.add_argument("--cover", default="", help="Existing cover image path")
    p_inspect.add_argument("--thumb-media-id", default="", help="Existing WeChat cover media_id")

    p_preview = subparsers.add_parser(
        "preview",
        help="Write local preview HTML",
    )
    add_common_article_args(p_preview)
    p_preview.add_argument("--out-dir", required=True, help="Output directory")

    p_publish = subparsers.add_parser(
        "publish",
        help="Create draft or dry-run draft JSON",
    )
    add_common_article_args(p_publish)
    p_publish.add_argument(
        "--title",
        default="",
        help="Cover title. Defaults to Markdown H1 when omitted.",
    )
    p_publish.add_argument("--subtitle", default="", help="Cover subtitle")
    p_publish.add_argument("--scheme", default="dark", choices=list(cover_script.SCHEMES.keys()))
    p_publish.add_argument("--out-dir", required=True, help="Output directory")
    p_publish.add_argument("--dry-run", action="store_true", help="Do not create live draft")
    p_publish.add_argument("--thumb-media-id", default="", help="Existing cover media_id")
    p_publish.add_argument(
        "--skip-cover",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    p_publish.add_argument("--content-source-url", default="", help="Original URL")
    return parser


def handle(args: argparse.Namespace) -> tuple[str, str, dict[str, Any]]:
    if args.command == "capabilities":
        return "CAPABILITIES_SHOWN", "Capabilities shown", capabilities()

    markdown = Path(args.markdown)
    if args.command == "inspect":
        data = inspect_article(
            markdown,
            theme=args.theme,
            title=args.article_title,
            digest=args.digest,
            author=args.author,
            draft=args.draft,
            cover_path=args.cover,
            thumb_media_id=args.thumb_media_id,
        )
        return "INSPECT_READY", "Inspect ready", data

    if args.command == "preview":
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        html_path = out_dir / f"{markdown.stem}.preview.html"
        markdown_text = read_markdown(markdown)
        title_state = resolve_title(markdown_text, markdown, args.article_title)
        html = standalone_preview_html(
            title_state["value"],
            md2wx.md_to_wx_html(markdown_without_first_h1(markdown_text), args.theme),
        )
        html_path.write_text(html, encoding="utf-8")
        data = inspect_article(
            markdown,
            theme=args.theme,
            title=args.article_title,
            digest=args.digest,
            author=args.author,
        )
        data["artifacts"] = {"preview_html": str(html_path)}
        return "PREVIEW_READY", "Preview ready", data

    if args.command == "publish":
        if args.skip_cover and not args.dry_run:
            raise ValueError("--skip-cover is only allowed with --dry-run")
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        article_json = out_dir / "article.json"
        draft_json = out_dir / "draft.json"
        manifest_json = out_dir / "manifest.json"
        cover_path = None if args.skip_cover else out_dir / "cover.png"

        cover_title = args.title.strip()
        if not cover_title:
            markdown_text = read_markdown(markdown)
            cover_title = resolve_title(markdown_text, markdown, args.article_title)[
                "value"
            ]

        if cover_path is not None:
            run_cover(cover_title, args.subtitle, args.scheme, cover_path)

        write_article_json(
            markdown,
            theme=args.theme,
            out_path=article_json,
            title=args.article_title,
            digest=args.digest,
        )
        draft_media_id = write_draft(
            article_json,
            out_path=draft_json,
            author=args.author,
            content_source_url=args.content_source_url,
            cover_path=cover_path,
            thumb_media_id=args.thumb_media_id,
            dry_run=args.dry_run,
        )
        code = "DRAFT_DRY_RUN_READY" if args.dry_run else "DRAFT_CREATED"
        artifacts = {
            "cover": str(cover_path) if cover_path is not None else None,
            "article_json": str(article_json),
            "draft_json": str(draft_json),
            "manifest_json": str(manifest_json),
        }
        manifest = {
            "code": code,
            "mode": "dry-run" if args.dry_run else "live",
            "source_file": str(markdown),
            "theme": args.theme,
            "scheme": args.scheme,
            "cover_title": cover_title,
            "draft_media_id": draft_media_id,
            "artifacts": artifacts,
        }
        manifest_json.write_text(
            json.dumps(manifest, ensure_ascii=False),
            encoding="utf-8",
        )
        data = {
            "mode": "dry-run" if args.dry_run else "live",
            "draft_media_id": draft_media_id,
            "artifacts": artifacts,
        }
        return code, "Draft dry-run ready" if args.dry_run else "Draft created", data

    raise ValueError(f"unknown command: {args.command}")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    json_output = bool(getattr(args, "json", False))
    try:
        code, message, data = handle(args)
    except Exception as exc:
        return fail("WECHAT_PUBLISH_FAILED", str(exc), json_output)
    print_response(response(True, code, message, data), json_output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
