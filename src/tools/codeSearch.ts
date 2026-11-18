import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { codeSearch, searchContent } from "../sources/code/morph.js";

export function registerCodeSearch(server: McpServer) {
  const cwd = process.cwd();
  server.registerTool("code_search", {
    title: "Search Code",
    description: "Find code that answers a natural-language question. Returns paths, line ranges and excerpts.",
    inputSchema: z.strictObject({
      query: z.string().trim().min(1).max(8000).describe("What do you want to find in the code?"),
      reference: z.string().trim().min(1).optional().describe(
        `Local directory or GitHub repo URL (optionally /tree/<exact branch>). Omit to search ${cwd}. Relative paths resolve there.`,
      ),
    }),
    outputSchema: z.object({ reference: z.string(), ...searchContent.shape }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, reference = "." }, { signal }) => {
    const result = await codeSearch(query, reference, cwd, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
    const text = [
      result.reference, result.summary,
      ...result.contexts.map(c => `${c.file}${c.lines && c.lines !== "*" ? `:${c.lines}` : ""}\n${c.content}`),
    ].filter(Boolean).join("\n\n");
    return { structuredContent: result, content: [{ type: "text", text }] };
  });
}
