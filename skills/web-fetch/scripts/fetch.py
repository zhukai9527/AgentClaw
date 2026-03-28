#!/usr/bin/env python3
"""Playwright-based web page fetcher with JS rendering support."""

import argparse
import json
import sys
import io
import os
from urllib.parse import urlparse

# Force UTF-8 stdout on Windows (avoid GBK encoding errors)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ── Load site config from sites.json ──
SITE_CLEANUP_JS: dict[str, str] = {}
SITE_SELECTORS: dict[str, str] = {}


def _load_site_config():
    """Load site-specific selectors and cleanup JS from sites.json."""
    config_path = os.path.join(os.path.dirname(__file__), "..", "sites.json")
    if not os.path.exists(config_path):
        return
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception:
        return

    sites = config.get("sites", {})
    # Resolve $ref aliases
    for domain, cfg in sites.items():
        ref = cfg.get("$ref")
        if ref and ref in sites:
            cfg = sites[ref]
        if cfg.get("selector"):
            SITE_SELECTORS[domain] = cfg["selector"]
        if cfg.get("cleanupJs"):
            SITE_CLEANUP_JS[domain] = cfg["cleanupJs"]


_load_site_config()

# ── Generic noise removal JS — works on all sites ──
GENERIC_CLEANUP_JS = """
() => {
    // Remove semantic noise elements
    const selectors = [
        'nav', 'header', 'footer', 'aside', 'dialog',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
        '[role="dialog"]', '[role="alertdialog"]',
        '[aria-label="cookie"]', '[class*="cookie"]', '[id*="cookie"]',
        '[class*="sidebar"]', '[class*="Sidebar"]',
        '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
        '[class*="ad-"]', '[class*="ads-"]', '[class*="advert"]',
        '[class*="banner"]', '[id*="banner"]',
        '[class*="signup"]', '[class*="SignUp"]',
        '[class*="login"]', '[class*="Login"]',
        '[data-testid="loginButton"]', '[data-testid="signupButton"]',
    ];
    for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
    }
    // Remove hidden elements
    document.querySelectorAll('[aria-hidden="true"], [hidden]').forEach(el => el.remove());
}
"""


def fetch(url: str, scroll: bool = False, raw: bool = False) -> str:
    from playwright.sync_api import sync_playwright

    hostname = urlparse(url).hostname or ""

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        # Hide webdriver flag
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = context.new_page()

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            # Wait for body to be available
            page.wait_for_selector("body", timeout=10000)
        except Exception as e:
            browser.close()
            return f"Error loading page: {e}"

        if scroll:
            # Scroll down to trigger lazy loading
            for _ in range(5):
                page.evaluate("window.scrollBy(0, window.innerHeight)")
                page.wait_for_timeout(800)
            # Scroll back to top
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(500)

        if raw:
            content = page.content()
        else:
            # Layer 1: Generic cleanup (all sites)
            page.evaluate(GENERIC_CLEANUP_JS)

            # Layer 1.5: Site-specific cleanup (remove interactive noise)
            site_cleanup = SITE_CLEANUP_JS.get(hostname)
            if site_cleanup:
                page.evaluate(site_cleanup)

            # Layer 2: Precise selector extraction (known sites)
            site_selector = SITE_SELECTORS.get(hostname)
            if site_selector:
                extracted = page.evaluate(
                    """(selector) => {
                    const els = document.querySelectorAll(selector);
                    if (els.length === 0) return null;
                    return Array.from(els).map(el => el.innerHTML).join('<hr>');
                }""",
                    site_selector,
                )
                if extracted:
                    # Get page title for context
                    title = page.title() or ""
                    html = f"<h1>{title}</h1>{extracted}" if title else extracted
                    content = html_to_markdown(html)
                else:
                    # Selector didn't match — fall back to full page
                    content = html_to_markdown(page.content())
            else:
                content = html_to_markdown(page.content())

        browser.close()

    return content


def html_to_markdown(html: str) -> str:
    from markdownify import markdownify
    import re

    # Remove script/style/noscript/svg (may remain after DOM cleanup)
    for tag in ("script", "style", "noscript", "svg"):
        html = re.sub(rf"<{tag}[\s\S]*?</{tag}>", "", html, flags=re.IGNORECASE)

    # Remove interactive/noise elements before conversion
    for pattern in [
        r'<[^>]* role="group"[^>]*>[\s\S]*?</[^>]+>',
        r'<[^>]* data-testid="(?:like|unlike|retweet|reply|bookmark|share)"[^>]*/?>',
    ]:
        html = re.sub(pattern, "", html, flags=re.IGNORECASE)

    md = markdownify(
        html, heading_style="ATX", strip=["img", "input", "button", "form", "svg"]
    )

    # Collapse excessive blank lines
    md = re.sub(r"\n{3,}", "\n\n", md)
    # Strip leading/trailing whitespace per line
    lines = [line.strip() for line in md.split("\n")]
    # Remove empty lines at start/end
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Fetch web page with JS rendering")
    parser.add_argument("--url", required=True, help="URL to fetch")
    parser.add_argument(
        "--scroll", action="store_true", help="Scroll page to trigger lazy loading"
    )
    parser.add_argument(
        "--raw", action="store_true", help="Output raw HTML instead of markdown"
    )
    args = parser.parse_args()

    result = fetch(args.url, scroll=args.scroll, raw=args.raw)
    print(result)


if __name__ == "__main__":
    main()
