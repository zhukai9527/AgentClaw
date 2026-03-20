/** Remove lone surrogates that break JSON serialization (e.g. from Playwright MCP) */
export function sanitizeString(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}
