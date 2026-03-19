/**
 * Dynamic Tool generator for static file knowledge sources (RAG).
 *
 * Converts a file-type KnowledgeSource into a search tool that performs
 * vector similarity search over pre-chunked document content.
 *
 * Note: This module does NOT import @agentclaw/memory directly (tools → memory
 * would create a coupling concern). Instead, it receives store/embed via params.
 */
import type {
  Tool,
  ToolResult,
  KnowledgeSource,
  FileSourceConfig,
} from "@agentclaw/types";

/** Minimal interface for the chunk store — avoids direct memory import */
export interface KnowledgeChunkStore {
  addKnowledgeChunks(
    chunks: Array<{
      id: string;
      agentId: string;
      sourceId: string;
      chunkIndex: number;
      content: string;
      embedding?: number[];
    }>,
  ): Promise<void>;
  searchKnowledgeChunks(
    agentId: string,
    sourceIds: string[],
    queryEmbedding: number[],
    topK?: number,
  ): Promise<
    Array<{
      content: string;
      score: number;
      sourceId: string;
      chunkIndex: number;
    }>
  >;
  deleteKnowledgeChunks(agentId: string, sourceId: string): void;
}

/** Embedding function type */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Simple fallback embedder (bag of words, 512-dim) */
class FallbackEmbedder {
  private vocab = new Map<string, number>();
  private maxDim = 512;

  private tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    const matches = lower.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]{2,}/gu,
    );
    return matches ?? [];
  }

  embed(text: string): number[] {
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      if (!this.vocab.has(token) && this.vocab.size < this.maxDim) {
        this.vocab.set(token, this.vocab.size);
      }
    }
    const dim = Math.max(this.vocab.size, 1);
    const vec = new Array<number>(dim).fill(0);
    for (const token of tokens) {
      const idx = this.vocab.get(token);
      if (idx !== undefined) vec[idx] += 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  embedBatch(texts: string[]): number[][] {
    return texts.map((t) => this.embed(t));
  }
}

/**
 * Split text into overlapping chunks for RAG indexing.
 * Uses paragraph boundaries when possible, falls back to sentence/char splitting.
 */
export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 100,
): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);

    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize * 0.3) {
        end = paragraphBreak + 2;
      } else {
        const sentenceBreak = cleaned.lastIndexOf(". ", end);
        if (sentenceBreak > start + chunkSize * 0.3) {
          end = sentenceBreak + 2;
        }
      }
    }

    chunks.push(cleaned.slice(start, end).trim());
    start = end - overlap;
    if (start >= cleaned.length) break;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Process a file: read → chunk → embed → store in knowledge_chunks table.
 * Returns the number of chunks created.
 */
export async function ingestFile(
  agentId: string,
  sourceId: string,
  content: string,
  store: KnowledgeChunkStore,
  embedFn?: EmbedFn,
  chunkSize = 500,
): Promise<number> {
  store.deleteKnowledgeChunks(agentId, sourceId);

  const textChunks = chunkText(content, chunkSize);
  if (textChunks.length === 0) return 0;

  const fallback = embedFn ? null : new FallbackEmbedder();
  const BATCH = 10;

  for (let i = 0; i < textChunks.length; i += BATCH) {
    const batch = textChunks.slice(i, i + BATCH);
    const embeddings = embedFn
      ? await embedFn(batch)
      : fallback!.embedBatch(batch);

    const chunks = batch.map((text, j) => ({
      id: `${sourceId}_chunk_${i + j}`,
      agentId,
      sourceId,
      chunkIndex: i + j,
      content: text,
      embedding: embeddings[j],
    }));

    await store.addKnowledgeChunks(chunks);
  }

  return textChunks.length;
}

/**
 * Create a RAG search tool for a file-type knowledge source.
 */
export function createFileRagTool(
  source: KnowledgeSource,
  agentId: string,
  store: KnowledgeChunkStore,
  embedFn?: EmbedFn,
): Tool {
  const config = source.config as FileSourceConfig;
  const topK = config.topK ?? 5;
  const fallback = new FallbackEmbedder();

  return {
    name: `ks_${source.name}`,
    description: source.description,
    category: "builtin",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find relevant information",
        },
      },
      required: ["query"],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        const query = String(input.query || "");
        if (!query) {
          return { content: "Query is required", isError: true };
        }

        let queryEmbedding: number[];
        if (embedFn) {
          const [emb] = await embedFn([query]);
          queryEmbedding = emb;
        } else {
          queryEmbedding = fallback.embed(query);
        }

        const results = await store.searchKnowledgeChunks(
          agentId,
          [source.id],
          queryEmbedding,
          topK,
        );

        if (results.length === 0) {
          return {
            content: `No relevant information found in "${config.filename}" for this query.`,
            isError: false,
          };
        }

        const formatted = results
          .map(
            (r, i) => `[${i + 1}] (score: ${r.score.toFixed(3)})\n${r.content}`,
          )
          .join("\n\n---\n\n");

        return {
          content:
            `Found ${results.length} relevant passages from "${config.filename}":\n\n${formatted}`.slice(
              0,
              6000,
            ),
          isError: false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `RAG search failed: ${message}`, isError: true };
      }
    },
  };
}

/**
 * Create RAG Tool instances from all enabled file knowledge sources.
 */
export function createFileRagTools(
  sources: KnowledgeSource[],
  agentId: string,
  store: KnowledgeChunkStore,
  embedFn?: EmbedFn,
): Tool[] {
  return sources
    .filter((s) => s.enabled && s.type === "file")
    .map((s) => createFileRagTool(s, agentId, store, embedFn));
}
