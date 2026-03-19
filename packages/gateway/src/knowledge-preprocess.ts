/**
 * Knowledge source content extraction & preprocessing.
 *
 * Handles different file types:
 * - PDF: extract text via pdf-parse, detect scan-only PDFs
 * - HTML: Readability + Turndown → clean Markdown (same as web_fetch)
 * - Plain text (.txt, .md, .csv, .json, .xml, .yaml, etc.): read as-is
 */
import { readFileSync } from "node:fs";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** Minimum chars threshold to consider a PDF as having a text layer */
const PDF_TEXT_THRESHOLD = 50;

/**
 * Extract and preprocess file content for RAG chunking.
 * Returns { content, error }. If error is set, content is empty.
 */
export async function extractFileContent(
  filePath: string,
  ext: string,
): Promise<{ content: string; error?: string }> {
  const lowerExt = ext.toLowerCase();

  // ─── PDF ───────────────────────────────────────────
  if (lowerExt === ".pdf") {
    return extractPdfContent(filePath);
  }

  // ─── HTML ──────────────────────────────────────────
  if (lowerExt === ".html" || lowerExt === ".htm") {
    return { content: extractHtmlContent(filePath) };
  }

  // ─── Plain text (all other types) ──────────────────
  try {
    const raw = readFileSync(filePath, "utf-8");
    return { content: raw };
  } catch {
    return { content: "", error: "Failed to read file as UTF-8 text" };
  }
}

/**
 * Extract text from PDF using pdf-parse.
 * If the extracted text is too short, it's likely a scanned document.
 */
async function extractPdfContent(
  filePath: string,
): Promise<{ content: string; error?: string }> {
  try {
    // Dynamic import — pdf-parse v1 is CJS, handle both default and module export
    const mod = await import("pdf-parse");
    const pdfParse = typeof mod.default === "function" ? mod.default : mod;
    const buffer = readFileSync(filePath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await (pdfParse as any)(buffer);

    const text = data.text?.trim() || "";

    if (text.length < PDF_TEXT_THRESHOLD) {
      return {
        content: "",
        error:
          "This PDF appears to be a scanned document (image-only). Text extraction requires OCR which is not yet supported. Please upload a PDF with a text layer, or convert to text first.",
      };
    }

    return { content: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: "", error: `PDF parsing failed: ${msg}` };
  }
}

/**
 * Extract clean text from HTML using Readability + Turndown.
 * Same pipeline as the web_fetch tool — removes scripts, styles, nav,
 * then extracts main article content.
 */
function extractHtmlContent(filePath: string): string {
  let html = readFileSync(filePath, "utf-8");

  // Try Readability first for article extraction
  try {
    const { document } = parseHTML(html);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();
    if (article?.content && (article.textContent?.length ?? 0) > 200) {
      const title = article.title ? `# ${article.title}\n\n` : "";
      const md = turndown.turndown(article.content);
      return cleanMarkdown(title + md);
    }
  } catch {
    // Readability failed, fall through
  }

  // Fallback: remove noise tags and convert
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  html = html.replace(/<header[\s\S]*?<\/header>/gi, "");
  html = html.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  const md = turndown.turndown(html);
  return cleanMarkdown(md);
}

/** Clean up markdown: collapse blank lines */
function cleanMarkdown(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n").trim();
}
