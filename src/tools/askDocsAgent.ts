import { GoogleGenAI } from "@google/genai";

const CHARACTER_LIMIT = 25_000;
const GEMINI_MODEL = "gemini-2.5-flash";
const STORE_CACHE_TTL = 300_000;

export interface AskDocsAgentParams {
  query: string;
  target: string;
  top_k: number;
  include_chunks: boolean;
  format: "markdown" | "json";
  metadata_filter?: string;
}

export interface StoreInfo {
  name: string;
  displayName: string;
  createTime?: string;
  updateTime?: string;
}

interface StoreCache {
  stores: Map<string, string>;
  storeList: StoreInfo[];
  timestamp: number;
}

let storeCache: StoreCache | null = null;

async function fetchStores(client: GoogleGenAI): Promise<StoreCache> {
  const pager = await client.fileSearchStores.list({ config: { pageSize: 20 } });
  const stores: any[] = [];
  let page = pager.page;
  while (true) {
    stores.push(...Array.from(page));
    if (!pager.hasNextPage()) break;
    page = await pager.nextPage();
  }

  const storeMap = new Map<string, string>();
  const storeList: StoreInfo[] = [];

  for (const store of stores) {
    if (store.displayName && store.name) {
      storeMap.set(store.displayName, store.name);
      storeList.push({
        name: store.name,
        displayName: store.displayName,
        createTime: store.createTime,
        updateTime: store.updateTime,
      });
    }
  }

  return {
    stores: storeMap,
    storeList,
    timestamp: Date.now(),
  };
}

async function getStores(
  client: GoogleGenAI,
  forceRefresh: boolean = false,
): Promise<StoreCache> {
  const now = Date.now();
  if (!forceRefresh && storeCache && now - storeCache.timestamp < STORE_CACHE_TTL) {
    return storeCache;
  }
  storeCache = await fetchStores(client);
  return storeCache;
}

/**
 * Get available documentation stores for MCP resources.
 * Returns a list of store info objects with display names and metadata.
 */
export async function getAvailableStores(
  client: GoogleGenAI,
): Promise<StoreInfo[]> {
  const cache = await getStores(client);
  return cache.storeList;
}

function formatAskMarkdown(
  params: AskDocsAgentParams,
  mainResponse: string,
  grounding: any,
): string {
  const CHUNK_CHAR_LIMIT = 500;
  const output: string[] = [];
  output.push(`# Search Results: ${params.target}\n\n`);
  output.push(`**Query**: ${params.query}\n\n`);
  output.push(`**Response**:\n${mainResponse}\n\n`);

  const chunks = grounding.groundingChunks || [];
  const sources = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.retrievedContext?.title) {
      sources.add(chunk.retrievedContext.title);
    }
  }

  output.push("---\n\n");
  output.push(`**Sources** (${sources.size} files):\n`);
  for (const source of Array.from(sources).sort()) {
    output.push(`  - ${source}\n`);
  }

  if (params.include_chunks) {
    output.push("\n---\n\n");
    output.push("## Retrieved Context Chunks\n\n");
    for (let i = 0; i < Math.min(params.top_k, chunks.length); i++) {
      const chunk = chunks[i];
      if (chunk.retrievedContext) {
        const ctx = chunk.retrievedContext;
        const text: string = ctx.text ?? "";
        const preview =
          text.length > CHUNK_CHAR_LIMIT
            ? `${text.slice(0, CHUNK_CHAR_LIMIT)}... [truncated, ${text.length - CHUNK_CHAR_LIMIT} chars omitted]`
            : text;
        output.push(`### [${i + 1}] ${ctx.title}\n\n`);
        output.push(`${preview}\n\n`);
        output.push("---\n\n");
      }
    }
  }

  let result = output.join("");
  if (result.length > CHARACTER_LIMIT) {
    const truncated = result.slice(0, CHARACTER_LIMIT);
    result =
      truncated +
      `\n\n[TRUNCATED - Response exceeds ${CHARACTER_LIMIT} characters. Original length: ${result.length}. Try reducing top_k or disabling include_chunks.]`;
  }
  return result;
}

function formatAskJson(
  params: AskDocsAgentParams,
  mainResponse: string,
  grounding: any,
): string {
  const CHUNK_CHAR_LIMIT = 500;
  const chunks = grounding.groundingChunks || [];
  const sources = new Set<string>();
  const chunkData: any[] = [];

  for (const chunk of chunks) {
    if (chunk.retrievedContext?.title) {
      sources.add(chunk.retrievedContext.title);
    }
  }

  if (params.include_chunks) {
    for (let i = 0; i < Math.min(params.top_k, chunks.length); i++) {
      const chunk = chunks[i];
      if (chunk.retrievedContext) {
        const text: string = chunk.retrievedContext.text ?? "";
        const truncatedText =
          text.length > CHUNK_CHAR_LIMIT ? text.slice(0, CHUNK_CHAR_LIMIT) : text;
        chunkData.push({
          title: chunk.retrievedContext.title,
          text: truncatedText,
          truncated: text.length > CHUNK_CHAR_LIMIT,
          original_length: text.length,
        });
      }
    }
  }

  const result = {
    query: params.query,
    target: params.target,
    response: mainResponse,
    sources: Array.from(sources).sort(),
    ...(params.include_chunks && { chunks: chunkData }),
  };

  return JSON.stringify(result, null, 2);
}

function handleAskError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;

    if (message.includes("API key") || message.includes("UNAUTHENTICATED")) {
      return (
        "❌ Error: Invalid or missing GEMINI_API_KEY.\n\n" +
        "**Troubleshooting Steps:**\n" +
        "1. Verify environment variable is set:\n" +
        "   ```bash\n" +
        "   echo $GEMINI_API_KEY\n" +
        "   ```\n" +
        "2. Get a new API key: https://aistudio.google.com/apikey\n" +
        "3. Ensure key has File Search API access enabled\n" +
        "4. Check key isn't expired or revoked\n\n" +
        "**For Claude Desktop**: Update `claude_desktop_config.json`:\n" +
        "```json\n" +
        "{\n" +
        "  \"mcpServers\": {\n" +
        "    \"context\": {\n" +
        "      \"env\": { \"GEMINI_API_KEY\": \"your-key-here\" }\n" +
        "    }\n" +
        "  }\n" +
        "}\n" +
        "```"
      );
    }

    if (message.includes("404") || message.includes("NOT_FOUND")) {
      return (
        "❌ Error: Documentation reference not found.\n\n" +
        "**Next Steps:**\n" +
        "1. Check MCP Resources (resources/list) to see all available references\n" +
        "2. Verify the sync workflow ran successfully in your docs repo\n" +
        "3. Check if directory exists in repository\n" +
        "4. Re-run the sync workflow if needed"
      );
    }

    if (message.includes("429") || message.includes("RESOURCE_EXHAUSTED")) {
      return (
        "❌ Error: Gemini API rate limit exceeded.\n\n" +
        "**Rate Limit Info:**\n" +
        "- Free tier: 15 RPM (requests per minute)\n" +
        "\n**Immediate Solutions:**\n" +
        "1. Wait 60 seconds before retrying\n" +
        "2. Reduce query frequency\n" +
        "3. Consider upgrading to paid tier for higher limits"
      );
    }

    if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      return (
        "❌ Error: Permission denied.\n\n" +
        "**Common Causes:**\n" +
        "1. API key doesn't have File Search API enabled\n" +
        "2. Free tier quota exceeded\n" +
        "3. Geographic restrictions (File Search not available in all regions)\n\n" +
        "**Solutions:**\n" +
        "- Enable File Search API in Google AI Studio\n" +
        "- Check billing status in Google Cloud Console\n" +
        "- Verify service availability in your region"
      );
    }

    if (message.includes("DEADLINE_EXCEEDED") || message.includes("timeout")) {
      return (
        "❌ Error: Request timed out.\n\n" +
        "**Possible Causes:**\n" +
        "1. Large documentation reference causing slow retrieval\n" +
        "2. Network connectivity issues\n" +
        "3. API service degradation\n\n" +
        "**Try:**\n" +
        "- Reduce top_k parameter\n" +
        "- Use a more specific question to narrow search scope\n" +
        "- Retry in a few minutes"
      );
    }

    return `❌ Error: ${message}`;
  }

  return `❌ Unexpected error: ${String(error)}`;
}

export async function askDocsAgent(
  client: GoogleGenAI,
  params: AskDocsAgentParams,
): Promise<string> {
  try {
    const cache = await getStores(client);
    if (!cache.stores.has(params.target)) {
      const available = Array.from(cache.stores.keys()).sort();
      return (
        `Error: Documentation reference '${params.target}' not found.\n\n` +
        `Available references:\n` +
        available.map((s) => `  - ${s}`).join("\n") +
        "\n\nNote: References are automatically synced from repository directories. " +
        "If this directory exists but isn't listed, it may not have been indexed yet. " +
        "Check your sync workflow status."
      );
    }

    const storeName = cache.stores.get(params.target)!;
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: params.query,
      config: {
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeName],
              ...(params.metadata_filter && {
                metadataFilter: params.metadata_filter,
              }),
            },
          },
        ],
        temperature: 0.0,
      },
    });

    if (!response.candidates || !response.candidates[0]?.groundingMetadata) {
      if (params.format === "json") {
        return JSON.stringify(
          {
            query: params.query,
            target: params.target,
            response: "No results found",
            sources: [],
            suggestion:
              "The query may not match content in this store. Try rephrasing or use a different store.",
          },
          null,
          2,
        );
      }

      return (
        `No results found in reference '${params.target}' for query: ${params.query}\n\n` +
        "**Why this happened:** The query may not match any content in this documentation reference.\n\n" +
        "**Try:**\n" +
        "  - Rephrasing your question with different keywords\n" +
        "  - Being more specific or more general\n" +
        "  - Searching a different documentation reference"
      );
    }

    const grounding = response.candidates[0].groundingMetadata;
    // Extract text from the response content parts
    const parts = response.candidates[0].content?.parts;
    const mainResponse = parts?.map(part => part.text ?? "").join("") || "No response generated";

    if (params.format === "json") {
      return formatAskJson(params, mainResponse, grounding);
    }
    return formatAskMarkdown(params, mainResponse, grounding);
  } catch (error) {
    return handleAskError(error);
  }
}
