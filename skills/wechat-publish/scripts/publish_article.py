#!/usr/bin/env python3
"""
One-shot Markdown to WeChat draft publisher.

Wraps cover.py, md2wx.py and publish_draft.py so agents do not need to
manually orchestrate cover generation, conversion and publishing.
"""

import argparse
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate cover, convert Markdown and publish WeChat draft"
    )
    parser.add_argument("markdown", help="Input Markdown file")
    parser.add_argument("--title", required=True, help="Cover title")
    parser.add_argument("--subtitle", default="", help="Cover subtitle")
    parser.add_argument(
        "--scheme",
        default="dark",
        choices=["dark", "warm", "green", "purple", "blue"],
        help="Cover color scheme",
    )
    parser.add_argument(
        "--theme",
        default="tech-modern",
        choices=["tech-modern", "minimal", "sage"],
        help="WeChat article theme",
    )
    parser.add_argument("--author", default="爬爬虾", help="Article author")
    parser.add_argument(
        "--out-dir",
        required=True,
        help="Directory for cover.png, article.json and draft.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate cover/article/draft JSON only; do not create live draft",
    )
    parser.add_argument(
        "--thumb-media-id",
        default="test_thumb",
        help="Existing cover media id for --dry-run",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    markdown = Path(args.markdown)
    if not markdown.is_file():
        raise FileNotFoundError(f"markdown not found: {markdown}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cover = out_dir / "cover.png"
    article = out_dir / "article.json"
    draft = out_dir / "draft.json"

    run(
        [
            sys.executable,
            str(SCRIPT_DIR / "cover.py"),
            args.title,
            args.subtitle,
            "--scheme",
            args.scheme,
            "--out",
            str(cover),
        ]
    )
    run(
        [
            sys.executable,
            str(SCRIPT_DIR / "md2wx.py"),
            str(markdown),
            "--theme",
            args.theme,
            "--json",
            "--out",
            str(article),
        ]
    )

    publish_cmd = [
        sys.executable,
        str(SCRIPT_DIR / "publish_draft.py"),
        str(article),
        "--author",
        args.author,
        "--out",
        str(draft),
    ]
    if args.dry_run:
        publish_cmd += ["--thumb-media-id", args.thumb_media_id, "--dry-run"]
    else:
        publish_cmd += ["--cover", str(cover)]
    run(publish_cmd)

    print(f"cover={cover}")
    print(f"article_json={article}")
    print(f"draft_json={draft}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
