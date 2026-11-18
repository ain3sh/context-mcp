import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paper, searchPapers, source } from "../sources/papers/search.js";

export function registerPaperSearch(server: McpServer) {
  server.registerTool(
    "paper_search",
    {
      description: "Find research papers. Pass a result's reference directly to paper_read.",
      inputSchema: z.strictObject({
        query: z.string().trim().min(1).max(2000),
        source: source.optional()
          .describe("Restrict search to one index; default: arXiv and Crossref."),
        year: z.string().regex(/^\d{4}(?:-(?:\d{4})?)?$/)
          .refine((y) => !y.slice(5) || y.slice(5) >= y.slice(0, 4), "End year must not precede start year")
          .optional().describe("YYYY, YYYY-YYYY, or YYYY- (inclusive)."),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      outputSchema: z.object({
        papers: z.array(paper),
        failures: z.array(z.object({ source, message: z.string() })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, { signal }) => {
      const result = await searchPapers(input, signal);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
