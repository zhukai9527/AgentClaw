---
name: web-search
description: 已有内置 web_search 工具，此 Skill 仅作备用 | Built-in web_search tool available, this skill is fallback only
---

When the user asks to search the web, use the search script:

```
shell: python skills/web-search/scripts/search.py "search query"
```

Optional: limit results count (default 5):
```
shell: python skills/web-search/scripts/search.py "search query" --max 3
```

The script uses SearXNG (self-hosted, free) as primary search engine.
If SearXNG is unavailable, it falls back to Serper API.
Search engines are configured in Settings > Search.

To read a result page in detail, call `use_skill("web-fetch")`.
