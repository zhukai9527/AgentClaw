#!/usr/bin/env python3
"""
微信公众号封面图生成器
HTML模板 → Playwright截图 → 900×383 PNG

Usage:
  python cover.py "标题" "副标题"
  python cover.py "标题" "副标题" --scheme warm
  python cover.py "标题" "副标题" --out cover.png

Color schemes: dark (default), warm, green, purple, blue
"""

import sys
import os
import argparse
import tempfile

SCHEMES = {
    "dark": {
        "bg": "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
        "accent": "#e48625",
        "accent_rgba": "rgba(228, 134, 37, 0.08)",
        "accent_dot": "rgba(228, 134, 37, 0.3)",
    },
    "warm": {
        "bg": "linear-gradient(135deg, #2d1b0e 0%, #3d1f0f 50%, #5c2e0e 100%)",
        "accent": "#f0a050",
        "accent_rgba": "rgba(240, 160, 80, 0.08)",
        "accent_dot": "rgba(240, 160, 80, 0.3)",
    },
    "green": {
        "bg": "linear-gradient(135deg, #0a1a12 0%, #0f2a1a 50%, #143d26 100%)",
        "accent": "#4ade80",
        "accent_rgba": "rgba(74, 222, 128, 0.08)",
        "accent_dot": "rgba(74, 222, 128, 0.3)",
    },
    "purple": {
        "bg": "linear-gradient(135deg, #1a0a2e 0%, #2d1050 50%, #3b1570 100%)",
        "accent": "#a78bfa",
        "accent_rgba": "rgba(167, 139, 250, 0.08)",
        "accent_dot": "rgba(167, 139, 250, 0.3)",
    },
    "blue": {
        "bg": "linear-gradient(135deg, #0a1628 0%, #0f2440 50%, #163a5f 100%)",
        "accent": "#60a5fa",
        "accent_rgba": "rgba(96, 165, 250, 0.08)",
        "accent_dot": "rgba(96, 165, 250, 0.3)",
    },
}


def generate_html(title: str, subtitle: str, scheme: str = "dark") -> str:
    s = SCHEMES.get(scheme, SCHEMES["dark"])
    title_html = title.replace("\\n", "<br>").replace("|", "<br>")
    subtitle_html = subtitle.replace("\\n", "<br>").replace("|", "<br>") if subtitle else ""

    subtitle_block = ""
    if subtitle_html:
        subtitle_block = f'<div class="subtitle">{subtitle_html}</div>'

    return f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ width: 900px; height: 383px; overflow: hidden; }}
  .cover {{
    width: 900px; height: 383px;
    background: {s["bg"]};
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    position: relative; overflow: hidden;
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  }}
  .deco-1 {{ position: absolute; top: -60px; right: -60px; width: 200px; height: 200px; border-radius: 50%; background: {s["accent_rgba"]}; }}
  .deco-2 {{ position: absolute; bottom: -40px; left: -40px; width: 160px; height: 160px; border-radius: 50%; background: rgba(255, 255, 255, 0.03); }}
  .deco-3 {{ position: absolute; top: 50%; left: 60px; width: 6px; height: 6px; border-radius: 50%; background: {s["accent_dot"]}; }}
  .title-area {{ text-align: center; z-index: 1; padding: 0 80px; }}
  .title {{
    font-size: 42px; font-weight: 700; color: #ffffff;
    line-height: 1.35; letter-spacing: 1px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.3);
  }}
  .subtitle {{
    margin-top: 18px; font-size: 17px; color: rgba(255,255,255,0.55);
    letter-spacing: 4px; font-weight: 300;
  }}
  .bottom-line {{
    position: absolute; bottom: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, transparent, {s["accent"]}, transparent);
  }}
</style>
</head>
<body>
<div class="cover">
  <div class="deco-1"></div>
  <div class="deco-2"></div>
  <div class="deco-3"></div>
  <div class="title-area">
    <div class="title">{title_html}</div>
    {subtitle_block}
  </div>
  <div class="bottom-line"></div>
</div>
</body>
</html>'''


def main():
    parser = argparse.ArgumentParser(description="微信公众号封面图生成")
    parser.add_argument("title", help="封面标题（用 | 或 \\n 换行）")
    parser.add_argument("subtitle", nargs="?", default="", help="副标题（可选）")
    parser.add_argument("--scheme", default="dark", choices=SCHEMES.keys(), help="配色方案")
    parser.add_argument("--out", default=None, help="输出文件路径")
    args = parser.parse_args()

    html_content = generate_html(args.title, args.subtitle, args.scheme)

    # 写临时 HTML
    tmp_html = tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8")
    tmp_html.write(html_content)
    tmp_html.close()

    # 输出路径
    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "cover.png")

    # 用 Python Playwright 截图
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 900, "height": 383})
        page.goto(f"file:///{tmp_html.name.replace(os.sep, '/')}")
        page.wait_for_timeout(500)
        page.screenshot(path=out_path, clip={"x": 0, "y": 0, "width": 900, "height": 383})
        browser.close()

    print(f"Saved: {out_path}")

    # 清理临时文件
    os.unlink(tmp_html.name)


if __name__ == "__main__":
    main()
