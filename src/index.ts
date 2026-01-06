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

type Depth = "low" | "medium" | "high";

const FetchDocsInputSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(200)
      .describe("Library or framework name (e.g. 'react', 'langchain', 'express')."),
    tag: z
      .string()
      .max(200)
      .optional()
      .describe("Optional topic filter within that library (e.g. 'hooks', 'routing')."),
    depth: z
      .enum(["low", "medium", "high"] as const)
      .default("medium")
      .describe("Optional token budget: 'low' (~5k), 'medium' (~15k), 'high' (~50k)."),
    version: z
      .string()
      .max(50)
      .optional()
      .describe("Optional specific version (e.g. 'v18.2.0', '3.x')."),
    browse_index: z
      .boolean()
      .default(false)
      .describe("Optional; if true, list matching libraries instead of fetching docs."),
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
      .describe("URL or array of URLs (max 10) to fetch."),
    images: z
      .boolean()
      .default(false)
      .describe("Optional; include images in output."),
    refresh: z
      .boolean()
      .default(false)
      .describe("Optional; bypass cache and re-fetch."),
  })
  .strict();

type FetchSiteInput = z.infer<typeof FetchSiteInputSchema>;

const AskDocsAgentInputSchema = z.object({
  query: z
    .string()
    .min(5)
    .max(500)
    .describe("Question to answer over this documentation (5–500 chars)."),
  reference: z
    .string()
    .min(1)
    .max(100)
    .describe("Documentation store name (see docs://targets resource)."),
  include_sources: z
    .boolean()
    .default(false)
    .describe("Optional; include source chunk previews in response."),
  format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("Optional; response format: 'markdown' or 'json'."),
});

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
      description: "Fetch library documentation from Context7 with smart matching.",
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
      description: "Fetch web content as clean markdown. Output saves to `./context/{title}/CONTENT.md`.",
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
          "LLM agent for documentation Q&A with source-grounded answers. " +
          "Use docs://targets resource to list available stores.",
        inputSchema: AskDocsAgentInputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      async (args, _extra) => {
        const params: AskDocsAgentParams = {
          query: args.query,
          reference: args.reference,
          include_chunks: args.include_sources ?? false,
          top_k: 5,
          format: (args.format ?? "markdown") as "markdown" | "json",
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

