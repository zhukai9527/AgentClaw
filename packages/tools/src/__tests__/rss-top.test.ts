import { afterEach, describe, expect, it, vi } from "vitest";
import { rssTopTool } from "../builtin/rss-top.js";

const atom = `<?xml version="1.0"?>
<feed>
  <entry>
    <title>First &amp; best</title>
    <link href="https://reddit.com/r/test/comments/1/first"/>
    <updated>2026-05-03T01:00:00Z</updated>
  </entry>
  <entry>
    <title>Second</title>
    <link href="https://reddit.com/r/test/comments/2/second"/>
    <updated>2026-05-03T02:00:00Z</updated>
  </entry>
</feed>`;

describe("rss_top", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("一次读取多个 subreddit 并返回紧凑条目", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => atom,
      headers: new Headers({ "content-type": "application/atom+xml" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await rssTopTool.execute({
      feeds: ["technology", "r/LocalLLaMA"],
      topN: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("## r/technology");
    expect(result.content).toContain("## r/LocalLLaMA");
    expect(result.content).toContain("First & best");
    expect(result.content).not.toContain("Second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://www.reddit.com/r/technology/.rss",
    );
  });

  it("拒绝空 feeds，避免静默兜底", async () => {
    const result = await rssTopTool.execute({ feeds: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("feeds must include");
  });
});
