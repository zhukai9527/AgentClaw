#!/usr/bin/env python3
"""
Markdown → WeChat HTML converter with inline CSS themes.
Outputs body-only HTML ready for WeChat Draft API or manual paste.

Usage:
  python md2wx.py input.md                    # default theme (tech-modern)
  python md2wx.py input.md --theme minimal    # specify theme
  python md2wx.py input.md --out output.html  # write to file
"""

import re
import sys
import json
import argparse
from pathlib import Path

# ── Themes ──────────────────────────────────────────────────────────────

THEMES = {
    "tech-modern": {
        "body": "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:2;color:#333;max-width:680px;margin:0 auto;padding:16px;letter-spacing:0.5px;",
        "h1": "font-size:24px;font-weight:700;color:#1a1a1a;margin:32px 0 16px;padding-bottom:12px;border-bottom:2px solid #2563eb;",
        "h2": "font-size:20px;font-weight:700;color:#1a1a1a;margin:28px 0 12px;padding:8px 0 8px 12px;border-left:4px solid #2563eb;",
        "h3": "font-size:17px;font-weight:700;color:#333;margin:20px 0 8px;",
        "p": "margin:12px 0;line-height:2;color:#333;",
        "strong": "color:#1a1a1a;",
        "code": "background:#f1f5f9;color:#c7254e;padding:2px 6px;border-radius:4px;font-size:13px;font-family:Menlo,Monaco,Consolas,monospace;",
        "pre": "background:#1e293b;color:#e2e8f0;padding:16px;border-radius:8px;margin:16px 0;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;overflow-x:auto;font-family:Menlo,Monaco,Consolas,monospace;",
        "blockquote": "border-left:4px solid #2563eb;padding:12px 16px;margin:16px 0;color:#555;background:#eff6ff;border-radius:0 8px 8px 0;",
        "hr": "border:none;border-top:1px solid #e0e0e0;margin:32px 0;",
        "li": "margin:4px 0;line-height:1.8;color:#333;",
        "table": "border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;",
        "th": "border:1px solid #d1d5db;padding:10px 14px;background:#2563eb;color:#fff;text-align:left;font-weight:600;",
        "td": "border:1px solid #d1d5db;padding:10px 14px;",
        "img": "max-width:100%;height:auto;display:block;margin:20px auto;border-radius:8px;",
        "a_color": "#2563eb",
        "footnote_bg": "#f8fafc",
    },
    "minimal": {
        "body": "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:2;color:#444;max-width:680px;margin:0 auto;padding:16px;",
        "h1": "font-size:22px;font-weight:600;color:#222;margin:28px 0 14px;",
        "h2": "font-size:18px;font-weight:600;color:#222;margin:24px 0 10px;padding-bottom:8px;border-bottom:1px solid #eee;",
        "h3": "font-size:16px;font-weight:600;color:#333;margin:18px 0 8px;",
        "p": "margin:10px 0;line-height:2;color:#444;",
        "strong": "color:#222;",
        "code": "background:#f5f5f5;color:#d63384;padding:2px 5px;border-radius:3px;font-size:13px;font-family:Menlo,Monaco,monospace;",
        "pre": "background:#fafafa;color:#333;padding:16px;border-radius:6px;border:1px solid #eee;margin:14px 0;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;font-family:Menlo,Monaco,monospace;",
        "blockquote": "border-left:3px solid #ddd;padding:10px 16px;margin:14px 0;color:#666;background:#fafafa;",
        "hr": "border:none;border-top:1px solid #eee;margin:28px 0;",
        "li": "margin:4px 0;line-height:1.8;color:#444;",
        "table": "border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;",
        "th": "border:1px solid #ddd;padding:8px 12px;background:#f5f5f5;text-align:left;font-weight:600;color:#333;",
        "td": "border:1px solid #ddd;padding:8px 12px;",
        "img": "max-width:100%;height:auto;display:block;margin:16px auto;",
        "a_color": "#0366d6",
        "footnote_bg": "#fafafa",
    },
    "sage": {
        "body": "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:2;color:#2C3025;max-width:680px;margin:0 auto;padding:16px;letter-spacing:0.3px;",
        "h1": "font-size:24px;font-weight:700;color:#2C3025;margin:32px 0 16px;padding-bottom:10px;border-bottom:2px solid #6B7F5E;",
        "h2": "font-size:20px;font-weight:700;color:#2C3025;margin:28px 0 12px;padding:8px 0 8px 12px;border-left:4px solid #6B7F5E;",
        "h3": "font-size:17px;font-weight:700;color:#3a4233;margin:20px 0 8px;",
        "p": "margin:12px 0;line-height:2;color:#2C3025;",
        "strong": "color:#1a1d17;",
        "code": "background:#E2E3DC;color:#6B7F5E;padding:2px 6px;border-radius:4px;font-size:13px;font-family:Menlo,Monaco,Consolas,monospace;",
        "pre": "background:#1A1D17;color:#E3E4DB;padding:16px;border-radius:10px;margin:16px 0;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;font-family:Menlo,Monaco,Consolas,monospace;",
        "blockquote": "border-left:4px solid #6B7F5E;padding:12px 16px;margin:16px 0;color:#555;background:#FAFAF7;border-radius:0 8px 8px 0;",
        "hr": "border:none;border-top:1px solid #E2E3DC;margin:32px 0;",
        "li": "margin:4px 0;line-height:1.8;color:#2C3025;",
        "table": "border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;",
        "th": "border:1px solid #E2E3DC;padding:10px 14px;background:#6B7F5E;color:#FAFAF7;text-align:left;font-weight:600;",
        "td": "border:1px solid #E2E3DC;padding:10px 14px;",
        "img": "max-width:100%;height:auto;display:block;margin:20px auto;border-radius:10px;",
        "a_color": "#6B7F5E",
        "footnote_bg": "#FAFAF7",
    },
}

# ── CJK spacing ─────────────────────────────────────────────────────────

CJK = r"[\u4e00-\u9fff\u3400-\u4dbf]"
LATIN = r"[A-Za-z0-9]"


def add_cjk_spacing(text: str) -> str:
    """Insert thin space between CJK and Latin characters."""
    text = re.sub(f"({CJK})({LATIN})", r"\1 \2", text)
    text = re.sub(f"({LATIN})({CJK})", r"\1 \2", text)
    return text


# ── Converter ───────────────────────────────────────────────────────────


def inline_format(text: str, theme: dict) -> str:
    """Convert inline markdown to styled HTML."""
    # Bold
    text = re.sub(
        r"\*\*(.+?)\*\*", rf'<strong style="{theme["strong"]}">\1</strong>', text
    )
    # Inline code
    text = re.sub(r"`([^`]+)`", rf'<code style="{theme["code"]}">\1</code>', text)
    # Images
    text = re.sub(
        r"!\[([^\]]*)\]\(([^)]+)\)",
        rf'<img src="\2" alt="\1" style="{theme["img"]}"/>',
        text,
    )
    # CJK spacing
    text = add_cjk_spacing(text)
    return text


def collect_links(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Extract [text](url) links, replace with footnote markers. Returns (text, links)."""
    links = []

    def replacer(m):
        title, url = m.group(1), m.group(2)
        # Skip anchor links and image links
        if url.startswith("#") or url.startswith("data:"):
            return m.group(0)
        links.append((title, url))
        return f'{title}<sup style="color:{THEMES.get("tech-modern", {}).get("a_color", "#2563eb")};font-size:12px;">[{len(links)}]</sup>'

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", replacer, text)
    return text, links


def md_to_wx_html(md_text: str, theme_name: str = "tech-modern") -> str:
    """Convert markdown to WeChat-compatible inline-styled HTML."""
    theme = THEMES.get(theme_name, THEMES["tech-modern"])

    # Collect all links for footnotes
    md_text, all_links = collect_links(md_text)

    lines = md_text.split("\n")
    html_parts = []
    in_code = False
    code_content = []
    in_table = False
    table_rows = []
    in_list = False
    list_items = []
    list_ordered = False

    def flush_list():
        nonlocal in_list, list_items, list_ordered
        if not list_items:
            return
        for idx, item in enumerate(list_items):
            marker = f"{idx + 1}." if list_ordered else "•"
            html_parts.append(
                f'<section style="display:flex;align-items:baseline;margin:4px 0 4px 8px;">'
                f'<span style="color:{theme.get("a_color", "#2563eb")};min-width:20px;font-weight:600;">{marker}</span>'
                f'<span style="{theme["li"]}">{inline_format(item, theme)}</span>'
                f"</section>"
            )
        list_items = []
        in_list = False

    def flush_table():
        nonlocal in_table, table_rows
        if not table_rows:
            return
        t = f'<table style="{theme["table"]}">'
        if table_rows:
            t += "<thead><tr>"
            for cell in table_rows[0]:
                t += f'<th style="{theme["th"]}">{inline_format(cell, theme)}</th>'
            t += "</tr></thead>"
            if len(table_rows) > 1:
                t += "<tbody>"
                for row in table_rows[1:]:
                    t += "<tr>"
                    for cell in row:
                        t += f'<td style="{theme["td"]}">{inline_format(cell, theme)}</td>'
                    t += "</tr>"
                t += "</tbody>"
        t += "</table>"
        html_parts.append(t)
        table_rows = []
        in_table = False

    for line in lines:
        # Code blocks
        if line.startswith("```"):
            if in_code:
                escaped = (
                    "\n".join(code_content)
                    .replace("&", "&amp;")
                    .replace("<", "&lt;")
                    .replace(">", "&gt;")
                )
                html_parts.append(f'<pre style="{theme["pre"]}">{escaped}</pre>')
                code_content = []
                in_code = False
            else:
                flush_list()
                flush_table()
                in_code = True
            continue
        if in_code:
            code_content.append(line)
            continue

        # Table rows
        if "|" in line and line.strip().startswith("|"):
            if not in_table:
                flush_list()
                in_table = True
                table_rows = []
            cells = [c.strip() for c in line.split("|") if c.strip()]
            # Skip separator row (---|---|---)
            if all(re.match(r"^[-:]+$", c) for c in cells):
                continue
            table_rows.append(cells)
            continue
        elif in_table:
            flush_table()

        # List items
        m_ul = re.match(r"^[-*]\s+(.*)", line)
        m_ol = re.match(r"^(\d+)\.\s+(.*)", line)
        if m_ul:
            if not in_list or list_ordered:
                flush_list()
                in_list = True
                list_ordered = False
            list_items.append(m_ul.group(1))
            continue
        elif m_ol:
            if not in_list or not list_ordered:
                flush_list()
                in_list = True
                list_ordered = True
            list_items.append(m_ol.group(2))
            continue
        elif in_list:
            flush_list()

        stripped = line.strip()
        if not stripped:
            continue

        # Horizontal rule
        if stripped == "---":
            html_parts.append(f'<hr style="{theme["hr"]}"/>')
            continue

        # Headers
        if line.startswith("# "):
            html_parts.append(
                f'<h1 style="{theme["h1"]}">{inline_format(line[2:], theme)}</h1>'
            )
            continue
        if line.startswith("## "):
            html_parts.append(
                f'<h2 style="{theme["h2"]}">{inline_format(line[3:], theme)}</h2>'
            )
            continue
        if line.startswith("### "):
            html_parts.append(
                f'<h3 style="{theme["h3"]}">{inline_format(line[4:], theme)}</h3>'
            )
            continue

        # Blockquote
        if line.startswith("> "):
            html_parts.append(
                f'<blockquote style="{theme["blockquote"]}">{inline_format(line[2:], theme)}</blockquote>'
            )
            continue

        # Regular paragraph
        html_parts.append(f'<p style="{theme["p"]}">{inline_format(line, theme)}</p>')

    # Flush remaining
    flush_list()
    flush_table()

    # Append footnotes if any links were collected
    if all_links:
        fn_bg = theme.get("footnote_bg", "#f8fafc")
        html_parts.append(
            f'<section style="margin-top:32px;padding:16px;background:{fn_bg};border-radius:8px;font-size:13px;color:#888;line-height:1.8;">'
        )
        html_parts.append(
            '<p style="font-weight:600;color:#666;margin:0 0 8px;">参考链接</p>'
        )
        for idx, (title, url) in enumerate(all_links, 1):
            html_parts.append(
                f'<p style="margin:2px 0;color:#999;word-break:break-all;">[{idx}] {title}: {url}</p>'
            )
        html_parts.append("</section>")

    body = "\n".join(html_parts)
    return f'<section style="{theme["body"]}">{body}</section>'


def main():
    parser = argparse.ArgumentParser(description="Markdown to WeChat HTML converter")
    parser.add_argument("input", help="Input markdown file")
    parser.add_argument(
        "--theme",
        default="tech-modern",
        choices=list(THEMES.keys()),
        help="Theme name (default: tech-modern)",
    )
    parser.add_argument("--out", help="Output HTML file (default: stdout)")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON with title/digest/content fields",
    )
    args = parser.parse_args()

    md_text = Path(args.input).read_text(encoding="utf-8")

    # Extract title from first H1
    title_match = re.search(r"^# (.+)$", md_text, re.MULTILINE)
    title = title_match.group(1) if title_match else Path(args.input).stem

    html = md_to_wx_html(md_text, args.theme)

    if args.json:
        # Extract first 100 chars of non-header text as digest
        plain_lines = [
            line
            for line in md_text.split("\n")
            if line.strip()
            and not line.startswith("#")
            and not line.startswith("```")
            and not line.startswith(">")
            and not line.startswith("|")
        ]
        digest = re.sub(
            r"\*\*|`|!\[.*?\]\(.*?\)|\[.*?\]\(.*?\)", "", " ".join(plain_lines)
        )[:120]
        result = {"title": title, "digest": digest, "content": html}
        output = json.dumps(result, ensure_ascii=False)
    else:
        output = html

    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"Written to {args.out} ({len(output)} chars)", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
