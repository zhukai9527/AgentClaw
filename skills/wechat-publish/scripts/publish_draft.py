#!/usr/bin/env python3
"""
Publish md2wx JSON to WeChat Official Account draft via wx-proxy.

Input must be the JSON produced by md2wx.py --json:
  {"title": "...", "digest": "...", "content": "..."}

The script never calls the official WeChat API directly.
"""

import argparse
import json
import mimetypes
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


PROXY_BASE = "https://www.maikami.com/wx-proxy.php"
PROXY_SECRET = "wx-proxy-2026"


def proxy_url(path: str, params: dict[str, str] | None = None) -> str:
    query = {"secret": PROXY_SECRET, "path": path}
    if params:
        query.update(params)
    return f"{PROXY_BASE}?{urllib.parse.urlencode(query)}"


def read_article(path: Path) -> dict[str, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("article json must be an object")

    required = ("title", "digest", "content")
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"article json missing fields: {', '.join(missing)}")

    article = {key: data[key] for key in required}
    for key, value in article.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"article field must be a non-empty string: {key}")

    if len(article["digest"]) > 120:
        raise ValueError("digest must be 120 characters or fewer")

    return article


def build_draft(
    article: dict[str, str],
    thumb_media_id: str,
    author: str,
    content_source_url: str,
) -> dict[str, list[dict[str, object]]]:
    if not thumb_media_id.strip():
        raise ValueError("thumb_media_id must be non-empty")

    return {
        "articles": [
            {
                "title": article["title"],
                "author": author,
                "digest": article["digest"],
                "content": article["content"],
                "thumb_media_id": thumb_media_id,
                "content_source_url": content_source_url,
                "need_open_comment": 1,
                "only_fans_can_comment": 0,
            }
        ]
    }


def read_json_response(req: urllib.request.Request | str) -> dict[str, object]:
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected response: {raw}")
    if data.get("errcode"):
        raise RuntimeError(json.dumps(data, ensure_ascii=False))
    return data


def get_access_token() -> str:
    data = read_json_response(
        proxy_url("/cgi-bin/token", {"grant_type": "client_credential"})
    )
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("token response missing access_token")
    return token


def upload_cover(access_token: str, cover: Path) -> str:
    if not cover.is_file():
        raise FileNotFoundError(f"cover image not found: {cover}")

    boundary = f"----agentclaw-{uuid.uuid4().hex}"
    filename = cover.name
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    file_bytes = cover.read_bytes()

    body = b"".join(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            (
                f'Content-Disposition: form-data; name="media"; '
                f'filename="{filename}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
            file_bytes,
            f"\r\n--{boundary}--\r\n".encode("utf-8"),
        ]
    )

    req = urllib.request.Request(
        proxy_url(
            "/cgi-bin/material/add_material",
            {"access_token": access_token, "type": "image"},
        ),
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    data = read_json_response(req)
    media_id = data.get("media_id")
    if not isinstance(media_id, str) or not media_id:
        raise RuntimeError("cover upload response missing media_id")
    return media_id


def create_draft(access_token: str, draft: dict[str, object]) -> str:
    payload = json.dumps(draft, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        proxy_url("/cgi-bin/draft/add", {"access_token": access_token}),
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    data = read_json_response(req)
    media_id = data.get("media_id")
    if not isinstance(media_id, str) or not media_id:
        raise RuntimeError("draft response missing media_id")
    return media_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish md2wx JSON to WeChat draft via wx-proxy"
    )
    parser.add_argument("article_json", help="JSON produced by md2wx.py --json")
    parser.add_argument("--cover", help="Cover image path to upload")
    parser.add_argument(
        "--thumb-media-id",
        help="Existing cover media_id. Required for --dry-run; skips cover upload.",
    )
    parser.add_argument("--author", default="爬爬虾", help="Article author")
    parser.add_argument("--content-source-url", default="", help="Original URL")
    parser.add_argument("--out", help="Write assembled draft JSON to this path")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only validate and write draft JSON; do not call wx-proxy.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    article_json = Path(args.article_json)
    article = read_article(article_json)

    if args.dry_run and not args.thumb_media_id:
        raise ValueError("--dry-run requires --thumb-media-id")
    if not args.thumb_media_id and not args.cover:
        raise ValueError("provide --cover or --thumb-media-id")

    thumb_media_id = args.thumb_media_id
    if not args.dry_run and not thumb_media_id:
        access_token = get_access_token()
        thumb_media_id = upload_cover(access_token, Path(args.cover))

    draft = build_draft(
        article,
        thumb_media_id,
        args.author,
        args.content_source_url,
    )

    out_path = Path(args.out) if args.out else article_json.with_suffix(".draft.json")
    out_path.write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")

    if args.dry_run:
        print(f"DRY_RUN draft_json={out_path}")
        return 0

    if args.thumb_media_id:
        access_token = get_access_token()
    draft_media_id = create_draft(access_token, draft)
    print(f"draft_media_id={draft_media_id}")
    print(f"draft_json={out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
