import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isPdfExtractionTask(inputText: string): boolean {
  return /pdf/i.test(inputText) && /读取|下载|提取|摘要|前\s*\d+\s*页|pages?/i.test(inputText);
}

export function requestedPdfPageLimit(inputText: string): number {
  const match = inputText.match(/前\s*(\d+)\s*页|first\s+(\d+)\s+pages?/i);
  const parsed = Number(match?.[1] ?? match?.[2] ?? 2);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
}

export function hardenPdfBashInput(
  input: Record<string, unknown>,
  sessionTmpDir: string,
  inputText: string,
): Record<string, unknown> {
  if (!isPdfExtractionTask(inputText) || typeof input.command !== "string") {
    return input;
  }
  let command = input.command.replace(/\\/g, "/");
  command = command.replace(
    /\b(curl|wget)\b([\s\S]*?)\s-o\s+((?!["']?[A-Za-z]:\/|["']?\/)[^\s;"'&|]+\.pdf)\b/i,
    (_m, bin, middle, out) => `${bin}${middle} -o "${sessionTmpDir}/${basename(out)}"`,
  );
  command = command.replace(
    /\b(curl|wget)\b([\s\S]*?)\s--output\s+((?!["']?[A-Za-z]:\/|["']?\/)[^\s;"'&|]+\.pdf)\b/i,
    (_m, bin, middle, out) =>
      `${bin}${middle} --output "${sessionTmpDir}/${basename(out)}"`,
  );
  return { ...input, command };
}

export async function recoverPdfTextFromSessionPdf(
  sessionTmpDir: string,
  inputText: string,
): Promise<string | null> {
  if (!isPdfExtractionTask(inputText) || !existsSync(sessionTmpDir)) return null;
  const pdf = readdirSync(sessionTmpDir)
    .filter((name) => /\.pdf$/i.test(name))
    .map((name) => join(sessionTmpDir, name))
    .find((path) => existsSync(path));
  if (!pdf) return null;
  const outputPath = join(sessionTmpDir, "pdf-autorecover.txt");
  const ok = await execPdfToText(pdf, outputPath, requestedPdfPageLimit(inputText));
  if (!ok || !existsSync(outputPath)) return null;
  const text = readFileSync(outputPath, "utf-8").trim();
  if (!text) return null;
  return `\n\n[pdf_text_autorecovered]\n${text.slice(0, 12000)}`;
}

async function execPdfToText(
  pdfPath: string,
  outputPath: string,
  pageLimit: number,
): Promise<boolean> {
  const args = ["-f", "1", "-l", String(pageLimit), pdfPath, outputPath];
  const candidates =
    process.platform === "win32"
      ? ["C:/Program Files/Git/mingw64/bin/pdftotext.exe", "pdftotext"]
      : ["pdftotext"];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, args, { timeout: 30000 });
      return existsSync(outputPath);
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}
