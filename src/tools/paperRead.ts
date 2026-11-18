import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readPaper, type Document } from "../sources/papers/read.js";
import { paperReference } from "../sources/papers/references.js";

type Snapshot = Extract<Document, { access: "full_text" | "abstract_only" }> & { reference: string };

function size(snapshot: Snapshot) {
  return (
    snapshot.reference.length +
    snapshot.title.length +
    snapshot.source_url.length +
    snapshot.markdown.length
  );
}

/** One immutable copy per paged read; bookmarks move, snapshots do not. */
export class PaperReader {
  private readonly snapshots = new Map<string, Snapshot>();
  private used = 0;
  constructor(
    private readonly load = readPaper,
    private readonly chunkSize = 16_000,
    private readonly capacity = 8_000_000,
  ) {} // capacity in UTF-16 code units

  async read(input: { reference: string; cursor?: string }, signal: AbortSignal) {
    const reference = paperReference(input.reference);
    let id: string, offset: number, snapshot: Snapshot;
    if (input.cursor !== undefined) {
      const [, key, position] = /^([0-9a-f-]{36}):(\d{1,9})$/.exec(input.cursor) ?? [];
      const saved = this.snapshots.get(key);
      offset = Number(position);
      if (!saved || saved.reference !== reference || !(offset > 0 && offset < saved.markdown.length)) {
        throw new Error("Invalid or expired cursor for this paper. Start again without cursor.");
      }
      id = key;
      snapshot = saved;
    } else {
      const doc = await this.load(reference, signal);
      signal.throwIfAborted();
      if (doc.access !== "full_text" || doc.markdown.length <= this.chunkSize)
        return { reference, ...doc };
      snapshot = { reference, ...doc };
      const weight = size(snapshot);
      if (weight > this.capacity) throw new Error("Full text exceeds the paper snapshot capacity.");
      while (this.used + weight > this.capacity) {
        const oldest = this.snapshots.keys().next().value!;
        this.used -= size(this.snapshots.get(oldest)!);
        this.snapshots.delete(oldest);
      }
      id = randomUUID();
      this.snapshots.set(id, snapshot);
      this.used += weight;
      offset = 0;
    }
    let end = Math.min(offset + this.chunkSize, snapshot.markdown.length);
    if (end < snapshot.markdown.length && /[\uD800-\uDBFF]/.test(snapshot.markdown[end - 1])) end--;
    return {
      ...snapshot,
      markdown: snapshot.markdown.slice(offset, end),
      ...(end < snapshot.markdown.length && { next_cursor: `${id}:${end}` }),
    };
  }
}

export function registerPaperRead(server: McpServer) {
  const reader = new PaperReader();
  server.registerTool(
    "paper_read",
    {
      description:
        "Read paper text, not a generated summary. Reports whether full text, only an abstract, or only metadata is available.",
      inputSchema: z.strictObject({
        reference: z.string().trim().min(1).max(4096),
        cursor: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Opaque bookmark from this paper's previous result. Omit to start reading."),
      }),
      outputSchema: z.object({
        reference: z.string(),
        title: z.string(),
        source_url: z.string(),
        access: z.enum(["full_text", "abstract_only", "metadata_only"]),
        markdown: z.string().optional(),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, { signal }) => {
      const result = await reader.read(input, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      const { markdown: text, ...header } = { markdown: "", ...result };
      return {
        structuredContent: result,
        content: [{ type: "text", text: `${JSON.stringify(header)}\n\n${text}`.trimEnd() }],
      };
    },
  );
}
