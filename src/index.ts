#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { fetchDocs as fetchDocsTool } from "./tools/fetchDocs.js";
import { fetchSite as fetchSiteTool } from "./tools/fetchSite.js";
import { askDocsAgent as askDocsAgentTool, AskDocsAgentParams, getAvailableStores, StoreInfo } from "./tools/askDocsAgent.js";

// ---------------------------------------------------------------------------
// Types & Schemas
// ---------------------------------------------------------------------------

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

type Depth = "low" | "medium" | "high";

const FetchDocsInputSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(200)
      .describe("Library or framework name guess (1–200 chars)."),
    tag: z
      .string()
      .max(200)
      .optional()
      .describe("Optional topic filter within that library (≤200 chars)."),
    depth: z
      .enum(["low", "medium", "high"] as const)
      .default("medium")
      .describe("Doc length preset: 'low'/'medium'/'high' (~5k/15k/50k tokens)."),
    version: z
      .string()
      .max(50)
      .optional()
      .describe("Optional version tag string (≤50 chars)."),
    browse_index: z
      .boolean()
      .default(false)
      .describe("If true, return matching libraries instead of docs."),
  })
  .strict();

type FetchDocsInput = z.infer<typeof FetchDocsInputSchema>;

const FetchSiteInputSchema = z
  .object({
    url: z
      .union([
        z.string().url(),
        z.array(z.string().url()).min(1).max(10),
      ])
      .describe("Single URL string or list of 1–10 URLs to fetch."),
    images: z
      .boolean()
      .default(false)
      .describe("If true, fetch and store images alongside markdown."),
    refresh: z
      .boolean()
      .default(false)
      .describe("If true, bypass cache and re-fetch from origin."),
  })
  .strict();

type FetchSiteInput = z.infer<typeof FetchSiteInputSchema>;

const AskDocsAgentInputSchema = z
  .object({
    query: z
      .string()
      .min(5, "Query must be at least 5 characters")
      .max(500, "Query must not exceed 500 characters")
      .describe("Question to answer over this documentation (5–500 chars)."),
    reference: z
      .string()
      .min(1)
      .max(100, "Reference must not exceed 100 characters")
      .optional()
      .describe("Documentation reference to search (e.g. 'modelcontextprotocol/python-sdk')."),
    target: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Alias for 'reference'."),
    top_k: z
      .number()
      .int("top_k must be an integer")
      .min(1, "top_k must be at least 1")
      .max(20, "top_k cannot exceed 20")
      .default(3)
      .describe("Number of relevant chunks to retrieve (1–20)."),
    include_chunks: z
      .boolean()
      .default(false)
      .describe(
        "If true, include chunk previews; false returns answer + sources only.",
      ),
    format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Response format; defaults to 'markdown'. Use 'json' only when you need structured parsing.",
      ),
    metadata_filter: z
      .string()
      .optional()
      .describe(
        "Optional List Filter string to limit which files are searched; leave empty unless you know the store's metadata schema.",
      ),
  })
  .strict()
  .refine((v) => Boolean(v.reference ?? v.target), {
    message: "Missing required field 'reference'.",
    path: ["reference"],
  });

type AskDocsAgentInput = z.infer<typeof AskDocsAgentInputSchema>;

// ---------------------------------------------------------------------------
// Main MCP Server Setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  let geminiClient: GoogleGenAI | null = null;
  if (geminiApiKey) {
    geminiClient = new GoogleGenAI({ apiKey: geminiApiKey });
  }

  const server = new McpServer({
    name: "context-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "fetch_docs",
    {
      title: "Fetch Library Documentation",
      description:
        "Fetch library documentation from Context7 with smart matching.\n\n" +
        "**When to use:** You need API docs, code examples, or guides for a library/framework.\n\n" +
        "**Parameters:**\n" +
        "- target: Library name (required) - e.g., \"react\", \"next.js\", \"pytorch\"\n" +
        "- tag: Topic filter - e.g., \"routing\", \"hooks\"\n" +
        "- depth: Token budget - \"low\" (5k), \"medium\" (15k), \"high\" (50k)\n" +
        "- version: Specific version - e.g., \"v15.1.8\"\n" +
        "- browse_index: Set true to list matching libraries\n\n" +
        "**Examples:**\n" +
        "| Use Case | Call |\n" +
        "|----------|------|\n" +
        "| Basic | { \"target\": \"react\" } |\n" +
        "| With topic | { \"target\": \"next.js\", \"tag\": \"routing\" } |\n" +
        "| Deep dive | { \"target\": \"pytorch\", \"depth\": \"high\" } |\n" +
        "| Browse | { \"target\": \"mongo\", \"browse_index\": true } |",
      inputSchema: FetchDocsInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args, _extra) => {
      const params: FetchDocsInput = {
        target: args.target,
        tag: args.tag,
        depth: (args.depth ?? "medium") as Depth,
        version: args.version,
        browse_index: args.browse_index ?? false,
      };
      const result = await fetchDocsTool(params);
      const isError = result.startsWith("# API Error") || result.startsWith("Error ");
      return { content: [{ type: "text", text: result }], isError };
    },
  );

  server.registerTool(
    "fetch_site",
    {
      title: "Fetch Website Content",
      description:
        "Fetch web content and convert to clean, readable markdown.\n\n" +
        "**When to use:** You need clean content from any website - blog posts, articles, documentation.\n\n" +
        "**Parameters:**\n" +
        "- url: URL(s) to fetch - single string or array up to 10\n" +
        "- images: Enable image processing (default: false)\n" +
        "- refresh: Bypass cache (default: false)\n\n" +
        "**Examples:**\n" +
        "| Use Case | Call |\n" +
        "|----------|------|\n" +
        "| Basic | { \"url\": \"https://react.dev/learn\" } |\n" +
        "| With images | { \"url\": \"https://example.com\", \"images\": true } |\n" +
        "| Batch | { \"url\": [\"https://a.com\", \"https://b.com\"] } |\n" +
        "| Refresh | { \"url\": \"https://example.com\", \"refresh\": true } |\n\n" +
        "**Output:** Content saves to `./context/{title}/CONTENT.md` with YAML frontmatter.\n\n" +
        "**Note:** Respects robots.txt. Some sites may block automated fetching.",
      inputSchema: FetchSiteInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args, _extra) => {
      const params: FetchSiteInput = {
        url: args.url,
        images: args.images ?? false,
        refresh: args.refresh ?? false,
      };
      const result = await fetchSiteTool(params);
      const isError = result.startsWith("Error ") || result.includes("Error fetching");
      return { content: [{ type: "text", text: result }], isError };
    },
  );

  if (geminiClient) {
    server.registerTool(
      "ask_docs_agent",
      {
        title: "Ask Documentation Agent",
        description:
          "Semantic Q&A over documentation using Gemini File Search.\n\n" +
          "Uses pre-built stores of documentation and returns grounded answers with sources.",
        inputSchema: AskDocsAgentInputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      async (args, _extra) => {
        const reference = args.reference ?? args.target;
        if (!reference) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Missing required field 'reference'.",
              },
            ],
            isError: true,
          };
        }
        const params: AskDocsAgentParams = {
          query: args.query,
          reference,
          include_chunks: args.include_chunks ?? false,
          top_k: args.top_k ?? 3,
          format: (args.format ?? ResponseFormat.MARKDOWN) as "markdown" | "json",
          metadata_filter: args.metadata_filter,
        };
        const result = await askDocsAgentTool(geminiClient!, params);
        const isError = result.includes("Error:") || result.startsWith("Error ");
        return { content: [{ type: "text", text: result }], isError };
      },
    );

    // Register MCP resources for discovering available documentation targets
    
    // Static resource: List all available documentation targets
    server.registerResource(
      "docs-targets-list",
      "docs://targets",
      {
        title: "Available Documentation Targets",
        description: "List of all available documentation references that can be queried with ask_docs_agent.",
        mimeType: "application/json",
      },
      async (uri) => {
        try {
          const stores = await getAvailableStores(geminiClient!);
          const targetList = stores.map((store: StoreInfo) => ({
            reference: store.displayName,
            id: store.name,
            createTime: store.createTime,
            updateTime: store.updateTime,
          }));
          
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  description: "Available documentation references for ask_docs_agent tool",
                  usage: "Use the 'reference' field value as the 'reference' parameter in ask_docs_agent",
                  references: targetList,
                  total: targetList.length,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "Failed to fetch documentation targets",
                  message: errorMessage,
                  suggestion: "Ensure GEMINI_API_KEY is set and valid",
                }, null, 2),
              },
            ],
          };
        }
      },
    );

    // Dynamic resource template: Get details about a specific target
    server.registerResource(
      "docs-target-details",
      new ResourceTemplate("docs://targets/{target}", { list: undefined }),
      {
        title: "Documentation Target Details",
        description: "Get details about a specific documentation target by name",
        mimeType: "application/json",
      },
      async (uri, { target }) => {
        try {
          const stores = await getAvailableStores(geminiClient!);
          const store = stores.find((s: StoreInfo) => s.displayName === target);
          
          if (!store) {
            const available = stores.map((s: StoreInfo) => s.displayName).sort();
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    error: `Target '${target}' not found`,
                    availableReferences: available,
                    suggestion: "Use one of the available target names listed above",
                  }, null, 2),
                },
              ],
            };
          }
          
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  target: store.displayName,
                  reference: store.displayName,
                  id: store.name,
                  createTime: store.createTime,
                  updateTime: store.updateTime,
                  usage: {
                    tool: "ask_docs_agent",
                    example: {
                      query: "How do I get started?",
                      reference: store.displayName,
                    },
                  },
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "Failed to fetch target details",
                  message: errorMessage,
                }, null, 2),
              },
            ],
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("context-mcp server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

