import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWiki } from "../sources/code/deepwiki.js";

const repo = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[a-z\d-]+\/(?!\.{1,2}\/?$)[\w.-]+\/?$/i,
    "Expected a GitHub repository root URL, not a file or branch.",
  );

export function registerCodeWiki(server: McpServer) {
  server.registerTool(
    "code_wiki",
    {
      description: "Read or ask about DeepWiki's index of a public GitHub repository.",
      inputSchema: z.strictObject({
        reference: z
          .union([repo, z.array(repo).min(1).max(10)])
          .describe("GitHub repo URL; questions can compare up to ten URLs."),
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Omit for the outline. Pass exactly `read` for the full wiki. Any other nonempty string asks a question.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ reference, query }, extra) => {
      const repos = [reference].flat().map((r) => new URL(r).pathname.replace(/^\/|\/$/g, ""));
      return queryWiki(repos, query, extra.signal);
    },
  );
}
