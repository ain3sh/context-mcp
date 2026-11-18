import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import axios from "axios";
import { z } from "zod";
import {
  depthTokens, getDocumentation, matchLibrary, searchLibraries, type Candidate, type Library,
} from "../sources/docs/context7.js";

const fetchDocsInput = z.strictObject({
  target: z.string().min(1).max(200)
    .describe("Library or framework name (e.g. 'react', 'langchain', 'express')."),
  tag: z.string().max(200).optional()
    .describe("Optional topic filter within that library (e.g. 'hooks', 'routing')."),
  depth: z.enum(["low", "medium", "high"]).default("medium")
    .describe("Optional token budget: 'low' (~5k), 'medium' (~15k), 'high' (~50k)."),
  version: z.string().max(50).optional()
    .describe("Optional specific version (e.g. 'v18.2.0', '3.x')."),
  browse_index: z.boolean().default(false)
    .describe("Optional; if true, list matching libraries instead of fetching docs."),
});

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatIndex(libraries: Library[], query: string) {
  const out = [
    "# Library Search Results\n\n", `**Query:** "${query}"\n\n`,
    `Found ${libraries.length} matching libraries:\n\n`,
    "| Library | Stars | Quality | Tokens | Description |\n",
    "|---------|-------|---------|--------|-------------|\n",
  ];
  for (const lib of libraries.slice(0, 15)) {
    const quality = lib.benchmarkScore ? lib.benchmarkScore.toFixed(1) : "N/A";
    const desc = lib.description.length > 50 ? `${lib.description.slice(0, 50)}...` : lib.description;
    out.push(`| ${lib.id} | ${formatNumber(lib.stars)} | ${quality} | ${formatNumber(lib.totalTokens)} | ${desc} |\n`);
  }
  if (libraries.length > 15) out.push(`\n*...and ${libraries.length - 15} more results*\n`);
  out.push(`\n**To fetch:** Use \`fetch_docs(target="${libraries[0].id}")\`\n`);
  return out.join("");
}

function formatNoMatch(target: string, candidates: Candidate[]) {
  return [
    "# No Match Found\n\n", `**Target:** "${target}"\n\n`,
    "No library found with sufficient confidence.\n\n", "**Did you mean?**\n",
    ...candidates.slice(0, 5).map(({ lib, score }) => `  - ${lib.id} (score: ${score.toFixed(1)})\n`),
    `\n**Tip:** Try \`fetch_docs(target="${target}", browse_index=true)\` to see all search results.\n`,
  ].join("");
}

function truncateDocs(text: string) {
  const limit = 25_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[TRUNCATED - Response exceeds ${
    limit.toLocaleString()} characters. Try using a lower depth or adding a topic filter.]`;
}

function formatError(error: unknown) {
  if (!axios.isAxiosError<{ message?: string; error?: string }>(error)) {
    return `Error in fetch_docs: ${error instanceof Error ? error.message : String(error)}`;
  }
  const status = error.response?.status ?? 500;
  const data = error.response?.data;
  const suggestions: Record<number, string[]> = {
    401: ["Check your CONTEXT7_API_KEY if using authentication"],
    404: ["The library may not exist in Context7's index", "Try searching with browse_index=true to see available libraries"],
    429: ["You've hit the rate limit - wait a moment and try again", "Set CONTEXT7_API_KEY for higher rate limits"],
  };
  return [
    "# API Error", "", `**Status:** ${status}`, `**Message:** ${data?.message || data?.error || error.message}`,
    "", "**Suggestions:**", ...(suggestions[status] ?? ["Try again later"]).map((s) => `- ${s}`), "",
  ].join("\n");
}

async function fetchDocs({ target, browse_index, tag, version, depth }: z.infer<typeof fetchDocsInput>, signal: AbortSignal) {
  const libraries = await searchLibraries(target, signal);
  if (!libraries.length) return [
    "# No Results Found", "", `**Target:** "${target}"`, "", "No libraries found matching this search term.", "",
    "**Suggestions:**", "- Check the spelling of the library name",
    '- Try the official name (e.g., "Next.js" instead of "nextjs")', "",
  ].join("\n");
  if (browse_index) return formatIndex(libraries, target);
  const match = matchLibrary(libraries, target);
  if (Array.isArray(match)) return formatNoMatch(target, match);
  const text = await getDocumentation(match.id, tag, version, depthTokens[depth], signal);
  const library = version ? `${match.id} (${version})` : match.id;
  return truncateDocs(`**Library:** ${library}\n\n${text}`);
}

export function registerFetchDocs(server: McpServer) {
  server.registerTool("fetch_docs", {
    title: "Fetch Library Documentation",
    description: "Fetch library documentation from Context7 with smart matching.",
    inputSchema: fetchDocsInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (params, { signal }) => {
    try {
      const text = await fetchDocs(params, signal);
      return { content: [{ type: "text", text }], isError: false };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }], isError: true };
    }
  });
}
