import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@agentclaw/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webFetchTool } from "../builtin/web-fetch.js";

function response(
  body: string,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

async function makeContext(): Promise<{
  workDir: string;
  sendFile: ReturnType<typeof vi.fn>;
  context: ToolExecutionContext;
}> {
  const workDir = await mkdtemp(join(tmpdir(), "agentclaw-web-fetch-"));
  const sendFile = vi.fn().mockResolvedValue(undefined);
  return { workDir, sendFile, context: { workDir, sendFile } };
}

describe("web_fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("抓取微信公众号文章时应跳过 Jina 并保存本机直连提取的正文", async () => {
    const url = "https://mp.weixin.qq.com/s/UlXwNASDL2NU7Mjz-yy9lg";
    const nativeHtml = `
      <!doctype html>
      <html>
        <head><title>Weixin</title></head>
        <body>
          <h1 id="activity-name">测试公众号文章标题</h1>
          <div id="js_content">
            <p>这是微信正文第一段，用来验证工具保存的是原文内容。</p>
            <p>这是微信正文第二段，证明没有误用 Jina 的验证页。</p>
          </div>
        </body>
      </html>
    `;
    const jinaCaptcha = `
      Title: Weixin Official Accounts Platform
      Warning: This page maybe requiring CAPTCHA.

      ## 环境异常
      当前环境异常，完成验证后即可继续访问。
      [去验证](https://mp.weixin.qq.com/s/UlXwNASDL2NU7Mjz-yy9lg)
    `.repeat(4);
    const fetchMock = vi.fn(async (fetchUrl: string | URL | Request) => {
      const requested = String(fetchUrl);
      if (requested.startsWith("https://r.jina.ai/")) {
        return response(jinaCaptcha, "text/markdown; charset=utf-8");
      }
      return response(nativeHtml);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { workDir, sendFile, context } = await makeContext();
    const result = await webFetchTool.execute(
      { url, save_as: "article.md", auto_send: true, max_chars: 100_000 },
      context,
    );

    expect(result.isError).toBe(false);
    expect(
      fetchMock.mock.calls.some(([requested]) =>
        String(requested).startsWith("https://r.jina.ai/"),
      ),
    ).toBe(false);
    expect(result.metadata?.strategy).toBe("native");
    expect(sendFile).toHaveBeenCalledWith(join(workDir, "article.md"), "article.md");

    const saved = await readFile(join(workDir, "article.md"), "utf-8");
    expect(saved).toContain("测试公众号文章标题");
    expect(saved).toContain("这是微信正文第一段");
    expect(saved).toContain("这是微信正文第二段");
    expect(saved).not.toContain("环境异常");
  });

  it("最终内容是验证码或环境异常页时不应保存或自动发送文件", async () => {
    const url = "https://example.com/article";
    const verificationHtml = `
      <html>
        <body>
          <h1>环境异常</h1>
          <p>当前环境异常，完成验证后即可继续访问。</p>
          <a href="https://example.com/article">去验证</a>
        </body>
      </html>
    `;
    const fetchMock = vi.fn(async (fetchUrl: string | URL | Request) => {
      const requested = String(fetchUrl);
      if (requested.startsWith("https://r.jina.ai/")) {
        return response("too short", "text/markdown; charset=utf-8");
      }
      return response(verificationHtml);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { workDir, sendFile, context } = await makeContext();
    const result = await webFetchTool.execute(
      { url, save_as: "blocked.md", auto_send: true },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("需要验证");
    expect(sendFile).not.toHaveBeenCalled();
    await expect(readFile(join(workDir, "blocked.md"), "utf-8")).rejects.toThrow();
  });

  it("Jina 返回验证页但本机直连正常时应回退保存本机正文", async () => {
    const url = "https://example.com/article";
    const nativeHtml = `
      <html>
        <body>
          <article>
            <h1>正常文章标题</h1>
            <p>这是一段来自本机直连 HTML 的有效正文。</p>
            <p>当 Jina 返回验证页时，工具应该使用这份正文。</p>
          </article>
        </body>
      </html>
    `;
    const verificationMarkdown = `
      Title: Weixin Official Accounts Platform
      Warning: This page maybe requiring CAPTCHA.

      ## 环境异常
      当前环境异常，完成验证后即可继续访问。
      [去验证](https://example.com/article)
    `.repeat(4);
    const fetchMock = vi.fn(async (fetchUrl: string | URL | Request) => {
      const requested = String(fetchUrl);
      if (requested.startsWith("https://r.jina.ai/")) {
        return response(verificationMarkdown, "text/markdown; charset=utf-8");
      }
      return response(nativeHtml);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { workDir, sendFile, context } = await makeContext();
    const result = await webFetchTool.execute(
      { url, save_as: "article.md", auto_send: true },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.metadata?.strategy).toBe("native");
    expect(sendFile).toHaveBeenCalledWith(join(workDir, "article.md"), "article.md");

    const saved = await readFile(join(workDir, "article.md"), "utf-8");
    expect(saved).toContain("正常文章标题");
    expect(saved).toContain("本机直连 HTML 的有效正文");
    expect(saved).not.toContain("当前环境异常");
  });
});
