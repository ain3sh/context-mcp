#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCodeSearch } from "./tools/codeSearch.js";
import { registerCodeWiki } from "./tools/codeWiki.js";
import { registerPaperSearch } from "./tools/paperSearch.js";
import { registerPaperRead } from "./tools/paperRead.js";
import { registerFetchDocs } from "./tools/fetchDocs.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "context-mcp",
    version: "1.0.0",
  });

  registerCodeSearch(server);
  registerCodeWiki(server);
  registerPaperSearch(server);
  registerPaperRead(server);
  registerFetchDocs(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("context-mcp server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

