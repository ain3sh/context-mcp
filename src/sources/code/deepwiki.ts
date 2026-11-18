import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export async function queryWiki(repos: string[], query: string | undefined, caller: AbortSignal) {
  const asking = query !== undefined && query !== "read";
  if (!asking && repos.length !== 1) throw new Error("Browse one wiki at a time.");
  const request = {
    name: asking ? "ask_wiki_question" : query ? "read_wiki_contents" : "read_wiki_structure",
    arguments: { repoName: repos.length === 1 ? repos[0] : repos, ...(asking && { question: query }) },
  };
  const timeout = 120_000;
  const signal = AbortSignal.any([caller, AbortSignal.timeout(timeout)]);
  const client = new Client({ name: "context-mcp", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.deepwiki.com/mcp")), { signal });
    const result = await client.callTool(request, undefined, { signal, timeout });
    return CallToolResultSchema.parse(result);
  } finally {
    await client.close();
  }
}
