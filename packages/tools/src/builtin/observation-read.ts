import type { Tool, ToolExecutionContext, ToolResult } from "@agentclaw/types";

const MAX_RETURN_CHARS = 4000;
const PREVIEW_CHARS = 1000;

export const observationReadTool: Tool = {
  name: "observation_read",
  description:
    "Read a bounded slice of a stored observation by id. " +
    "Use query or offset/length to avoid returning large raw observations.",
  category: "builtin",
  pure: false,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Canonical observation id to read.",
      },
      query: {
        type: "string",
        description: "Optional text to find; returns nearby lines.",
      },
      offset: {
        type: "number",
        description: "Optional zero-based character offset.",
      },
      length: {
        type: "number",
        description: "Optional requested character length, capped at 4000.",
      },
    },
    required: ["id"],
  },

  async execute(
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!context?.getObservation || !context.recordObservationRead) {
      return fail("Observation read context is not available.");
    }

    const id = readRequiredString(input.id, "id");
    if (!id.ok) {
      return fail(id.message);
    }

    const query = readOptionalString(input.query, "query");
    if (!query.ok) {
      return fail(query.message);
    }

    const offset = readOptionalNumber(input.offset, "offset");
    if (!offset.ok) {
      return fail(offset.message);
    }

    const length = readOptionalNumber(input.length, "length");
    if (!length.ok) {
      return fail(length.message);
    }

    const observation = await context.getObservation(id.value);
    if (!observation) {
      return fail(`Observation "${id.value}" was not found.`);
    }

    const content = readBoundedContent(observation.raw, {
      query: query.value,
      offset: offset.value,
      length: length.value,
    });

    await context.recordObservationRead({
      id: id.value,
      returnedChars: content.length,
      query: query.value,
      offset: offset.value,
      length: length.value,
    });

    return { content, isError: false };
  },
};

function readBoundedContent(
  raw: string,
  input: { query?: string; offset?: number; length?: number },
): string {
  if (input.query) {
    return readQuerySnippet(raw, input.query);
  }

  if (input.offset !== undefined || input.length !== undefined) {
    const offset = input.offset ?? 0;
    const requestedLength = input.length ?? MAX_RETURN_CHARS;
    return raw.slice(offset, offset + Math.min(requestedLength, MAX_RETURN_CHARS));
  }

  return raw.slice(0, Math.min(PREVIEW_CHARS, raw.length));
}

function readQuerySnippet(raw: string, query: string): string {
  const lines = raw.split("\n");
  const preferredIndex = lines.findIndex((line) =>
    line.trimStart().startsWith(query),
  );
  const index =
    preferredIndex === -1
      ? lines.findIndex((line) => line.includes(query))
      : preferredIndex;
  if (index === -1) {
    return `No observation lines matched "${query}".`;
  }

  const before = index > 0 ? lines[index - 1] : undefined;
  const hit = lines[index];
  const after = index < lines.length - 1 ? lines[index + 1] : undefined;
  const sideBudget = Math.min(800, Math.floor(MAX_RETURN_CHARS * 0.2));
  const hitBudget = MAX_RETURN_CHARS - sideBudget * 2 - 2;

  const snippetLines = [
    before ? tail(before, sideBudget) : undefined,
    clipAroundQuery(hit, query, hitBudget),
    after ? head(after, sideBudget) : undefined,
  ].filter((line): line is string => line !== undefined);

  return snippetLines.join("\n").slice(0, MAX_RETURN_CHARS);
}

function head(line: string, budget: number): string {
  return line.length <= budget ? line : line.slice(0, budget);
}

function tail(line: string, budget: number): string {
  return line.length <= budget ? line : line.slice(line.length - budget);
}

function clipAroundQuery(line: string, query: string, budget: number): string {
  if (line.length <= budget) {
    return line;
  }

  const queryIndex = line.indexOf(query);
  const contextBudget = Math.max(0, budget - query.length);
  const before = Math.floor(contextBudget / 2);
  const start = Math.max(0, queryIndex - before);

  return line.slice(start, start + budget);
}

function readRequiredString(
  value: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${name} is required.` };
  }

  return { ok: true, value };
}

function readOptionalString(
  value: unknown,
  name: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${name} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function readOptionalNumber(
  value: unknown,
  name: string,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, message: `${name} must be a non-negative integer.` };
  }

  return { ok: true, value };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}
