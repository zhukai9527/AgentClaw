import { describe, expect, it } from "vitest";
import {
  hardenPdfBashInput,
  isPdfExtractionTask,
  requestedPdfPageLimit,
} from "../ability/pdf-guard.js";

describe("ability pdf guard", () => {
  it("识别 PDF 提取任务并限制页数", () => {
    expect(isPdfExtractionTask("读取这个 PDF 前 20 页并摘要")).toBe(true);
    expect(requestedPdfPageLimit("读取这个 PDF 前 20 页并摘要")).toBe(10);
    expect(requestedPdfPageLimit("read first 3 pages from this pdf")).toBe(3);
  });

  it("把相对 PDF 下载输出改写到会话目录", () => {
    const hardened = hardenPdfBashInput(
      {
        command:
          "curl -L https://example.com/a.pdf -o source.pdf && pdftotext source.pdf out.txt",
      },
      "D:/mycode/agentclaw/data/tmp/session-1",
      "读取 PDF 前 2 页",
    );

    expect(String(hardened.command)).toContain(
      '-o "D:/mycode/agentclaw/data/tmp/session-1/source.pdf"',
    );
  });
});
