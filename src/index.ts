#!/usr/bin/env node
/**
 * Context Tools MCP Server
 *
 * An MCP server providing intelligent documentation management and search tools.
 * Enables AI agents to fetch, curate, navigate, and semantically search documentation.
 *
 * Tools:
 * - fetch_docs: Fetch library documentation from Context7 with smart matching
 * - ask_docs_agent: Semantic search over documentation using Gemini File Search
 * - curate: Manage documentation collections (placeholder)
 * - climb: Navigate documentation hierarchy (placeholder)
 */

import { GoogleGenAI } from '@google/genai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as stringSimilarity from 'string-similarity';
import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

const CHARACTER_LIMIT = 25000;
const CHUNK_CHAR_LIMIT = 500;
const GEMINI_MODEL = 'gemini-2.5-flash';
const STORE_CACHE_TTL = 300000; // 5 minutes in ms

// Context7 API
const CONTEXT7_BASE_URL = 'https://context7.com/api/v1';
const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Environment-driven token budgets
const DEPTH_TOKENS = {
  low: parseInt(process.env.FETCH_DOCS_LOW_TOKENS || '5000', 10),
  medium: parseInt(process.env.FETCH_DOCS_MEDIUM_TOKENS || '15000', 10),
  high: parseInt(process.env.FETCH_DOCS_HIGH_TOKENS || '50000', 10),
};

// Matching thresholds
const SEMANTIC_FLOOR = parseInt(process.env.FETCH_DOCS_SEMANTIC_FLOOR || '60', 10);

// Logging
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ============================================================================
// Logging
// ============================================================================

function log(level: 'debug' | 'info' | 'error', message: string, data?: unknown): void {
  const levels = { debug: 0, info: 1, error: 2 };
  if (levels[level] >= levels[LOG_LEVEL as keyof typeof levels]) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  }
}

// ============================================================================
// Types & Interfaces
// ============================================================================

interface LibraryInfo {
  id: string;
  title: string;
  description: string;
  stars: number;
  totalTokens: number;
  trustScore: number;
  benchmarkScore: number;
  versions: string[];
  branch: string;
  state: string;
}

interface DocumentChunk {
  title: string;
  content: string;
  source: string;
  url: string;
}

interface DocumentationResult {
  libraryId: string;
  version: string;
  topic: string | null;
  tokens: number;
  chunks: DocumentChunk[];
}

interface MatchResult {
  library: LibraryInfo | null;
  score: number;
  tier: string;
  candidates: Array<[LibraryInfo, number]>;
}

interface StoreCache {
  stores: Map<string, string>;
  storeList: Array<{
    name: string;
    displayName: string;
    createTime?: string;
    updateTime?: string;
  }>;
  timestamp: number;
}

interface ChunkData {
  title: string;
  text: string;
  truncated: boolean;
  originalLength: number;
}

interface SearchResult {
  responseText: string;
  sources: string[];
  chunks: ChunkData[];
}

// ============================================================================
// Zod Input Schemas
// ============================================================================

const FetchDocsInputSchema = z.object({
  target: z.string()
    .min(1, 'Library name is required')
    .max(200, 'Library name must not exceed 200 characters')
    .describe("Library name to search for. Examples: 'react', 'next.js', 'pytorch', 'fastapi'"),
  tag: z.string()
    .max(200)
    .optional()
    .describe("Tag to filter/rerank results within the library. Examples: 'routing', 'hooks', 'authentication'"),
  depth: z.enum(['low', 'medium', 'high'])
    .default('medium')
    .describe("Token amount: 'low' (~5k tokens), 'medium' (~15k), 'high' (~50k for deep dives)"),
  version: z.string()
    .max(50)
    .optional()
    .describe("Specific version tag. Examples: 'v15.1.8', 'v14.3.0-canary.87'"),
  browse_index: z.boolean()
    .default(false)
    .describe('If true, returns list of matching libraries instead of fetching docs'),
}).strict();

const AskDocsInputSchema = z.object({
  query: z.string()
    .min(5, 'Query must be at least 5 characters')
    .max(500, 'Query must not exceed 500 characters')
    .describe("Natural language search query. Examples: 'How does async/await work?', 'React hooks best practices'"),
  target: z.string()
    .min(1, 'Documentation target is required')
    .max(100, 'Target must not exceed 100 characters')
    .describe("Documentation target to search. Examples: 'unstructured', 'modelcontextprotocol', 'openai'"),
  top_k: z.number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe('Number of relevant results to return (1-20)'),
  include_chunks: z.boolean()
    .default(false)
    .describe('Include document excerpts in response'),
  format: z.enum(['markdown', 'json'])
    .default('markdown')
    .describe("Response format: 'markdown' for human-readable or 'json' for structured data"),
  metadata_filter: z.string()
    .max(500)
    .optional()
    .describe('Optional metadata filter using List Filter syntax (google.aip.dev/160)'),
}).strict();

const CurateInputSchema = z.object({
  action: z.enum(['list', 'add', 'remove', 'organize'])
    .describe("Action to perform: 'list' collections, 'add' new source, 'remove' source, 'organize' structure"),
  collection_name: z.string()
    .max(100)
    .optional()
    .describe("Name of the documentation collection. Examples: 'python-stdlib', 'react-docs'"),
  source: z.string()
    .max(2000)
    .optional()
    .describe('Source URL or path to add to collection'),
  format: z.enum(['markdown', 'json'])
    .default('markdown')
    .describe("Response format: 'markdown' for human-readable or 'json' for structured data"),
}).strict();

const ClimbInputSchema = z.object({
  collection: z.string()
    .min(1)
    .max(100)
    .describe("Name of the documentation collection to navigate. Examples: 'python-stdlib', 'react-docs'"),
  path: z.string()
    .max(500)
    .default('/')
    .describe("Path within documentation hierarchy. Examples: '/', '/api/reference', '/guides/getting-started'"),
  action: z.enum(['list', 'info', 'navigate'])
    .default('list')
    .describe("Action: 'list' entries at path, 'info' about path, 'navigate' to related content"),
  format: z.enum(['markdown', 'json'])
    .default('markdown')
    .describe("Response format: 'markdown' for human-readable or 'json' for structured data"),
}).strict();

type FetchDocsInput = z.infer<typeof FetchDocsInputSchema>;
type AskDocsInput = z.infer<typeof AskDocsInputSchema>;
type CurateInput = z.infer<typeof CurateInputSchema>;
type ClimbInput = z.infer<typeof ClimbInputSchema>;

// ============================================================================
// Utility Functions
// ============================================================================

function truncateResponse(content: string, limit: number = CHARACTER_LIMIT): string {
  if (content.length <= limit) {
    return content;
  }
  const truncated = content.slice(0, limit);
  return `${truncated}\n\n[... Content truncated at ${limit} characters. Use more specific queries or pagination to see more ...]`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  } else if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

// ============================================================================
// Library Matching (3-tier cascade)
// ============================================================================

class LibraryMatcher {
  private libraries: LibraryInfo[];
  private titleToLib: Map<string, LibraryInfo>;
  private repoToLib: Map<string, LibraryInfo>;

  constructor(libraries: LibraryInfo[]) {
    this.libraries = libraries;
    this.titleToLib = new Map();
    this.repoToLib = new Map();

    // Pre-compute lowercase versions for fast exact matching
    for (const lib of libraries) {
      this.titleToLib.set(lib.title.toLowerCase(), lib);

      // Also index by repo name (last part of ID)
      const repoName = lib.id.includes('/')
        ? lib.id.split('/').pop()!.toLowerCase()
        : lib.id.toLowerCase();
      this.repoToLib.set(repoName, lib);
    }
  }

  findBest(target: string): MatchResult {
    if (this.libraries.length === 0) {
      return {
        library: null,
        score: 0,
        tier: 'none',
        candidates: [],
      };
    }

    const targetLower = target.toLowerCase().trim();

    // Tier 1: Exact match
    const exactResult = this.tryExactMatch(targetLower);
    if (exactResult) {
      return exactResult;
    }

    // Tier 2: Semantic match (fuzzy)
    return this.trySemanticMatch(targetLower);
  }

  private tryExactMatch(target: string): MatchResult | null {
    // Check title
    if (this.titleToLib.has(target)) {
      return {
        library: this.titleToLib.get(target)!,
        score: 100,
        tier: 'exact',
        candidates: [],
      };
    }

    // Check repo name
    if (this.repoToLib.has(target)) {
      return {
        library: this.repoToLib.get(target)!,
        score: 100,
        tier: 'exact',
        candidates: [],
      };
    }

    return null;
  }

  private trySemanticMatch(target: string): MatchResult {
    // Build choices list with titles, repo names, and full IDs
    const choices: string[] = [];
    const choiceToLib: Map<string, LibraryInfo> = new Map();

    for (const lib of this.libraries) {
      // Add title
      choices.push(lib.title);
      choiceToLib.set(lib.title, lib);

      // Add repo name as alternative
      const repoName = lib.id.includes('/') ? lib.id.split('/').pop()! : lib.id;
      if (repoName !== lib.title) {
        choices.push(repoName);
        choiceToLib.set(repoName, lib);
      }

      // Add full ID path
      if (!choiceToLib.has(lib.id)) {
        choices.push(lib.id);
        choiceToLib.set(lib.id, lib);
      }
    }

    // Use string-similarity for fuzzy matching
    const ratings = stringSimilarity.findBestMatch(target, choices);

    // Get top 5 results
    const sortedRatings = [...ratings.ratings]
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5);

    if (sortedRatings.length === 0) {
      return {
        library: null,
        score: 0,
        tier: 'semantic',
        candidates: [],
      };
    }

    // Best match
    const bestMatch = sortedRatings[0];
    const bestLib = choiceToLib.get(bestMatch.target)!;
    const bestScore = bestMatch.rating * 100; // Convert to 0-100 scale

    // Build candidates list (deduplicated by library ID)
    const seenIds = new Set<string>();
    const candidates: Array<[LibraryInfo, number]> = [];

    for (const rating of sortedRatings) {
      const lib = choiceToLib.get(rating.target)!;
      if (!seenIds.has(lib.id)) {
        seenIds.add(lib.id);
        candidates.push([lib, rating.rating * 100]);
      }
    }

    // Check if best match meets threshold
    if (bestScore >= SEMANTIC_FLOOR) {
      return {
        library: bestLib,
        score: bestScore,
        tier: 'semantic',
        candidates,
      };
    }

    // No confident match - return candidates for error message
    return {
      library: null,
      score: bestScore,
      tier: 'semantic',
      candidates,
    };
  }
}

// ============================================================================
// Context7 Client
// ============================================================================

async function context7Search(query: string, apiKey?: string): Promise<LibraryInfo[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(
      `${CONTEXT7_BASE_URL}/search?query=${encodeURIComponent(query)}`,
      { headers, signal: controller.signal }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Context7 API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { results?: Array<Record<string, unknown>> };
    const results = data.results || [];

    return results.map((lib: Record<string, unknown>) => ({
      id: lib.id as string || '',
      title: lib.title as string || '',
      description: lib.description as string || '',
      stars: lib.stars as number || 0,
      totalTokens: lib.totalTokens as number || 0,
      trustScore: lib.trustScore as number || 0,
      benchmarkScore: lib.benchmarkScore as number || 0,
      versions: lib.versions as string[] || [],
      branch: lib.branch as string || '',
      state: lib.state as string || 'finalized',
    }));
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function context7GetContext(
  libraryId: string,
  topic: string | undefined,
  tokens: number,
  version: string | undefined,
  apiKey?: string
): Promise<DocumentationResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Build URL
  const cleanId = libraryId.replace(/^\//, '');
  let url = version
    ? `${CONTEXT7_BASE_URL}/${cleanId}/${version}`
    : `${CONTEXT7_BASE_URL}/${cleanId}`;

  // Build query params
  const params = new URLSearchParams({
    type: 'json',
    tokens: String(tokens),
  });

  if (topic) {
    params.set('topic', topic);
  }

  url += `?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Context7 API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      library?: string;
      version?: string;
      topic?: string;
      snippets?: Array<Record<string, unknown>>;
    };

    // Parse snippets into chunks
    const chunks: DocumentChunk[] = [];
    const snippets = data.snippets || [];

    for (const snippet of snippets) {
      const contentParts: string[] = [];

      const codeDescription = snippet.codeDescription as string | undefined;
      if (codeDescription) {
        contentParts.push(codeDescription);
      }

      const codeList = (snippet.codeList as string[] | undefined) || [];
      if (codeList.length > 0) {
        const codeLang = (snippet.codeLanguage as string) || '';
        for (const codeItem of codeList) {
          if (codeLang) {
            contentParts.push(`\`\`\`${codeLang}\n${codeItem}\n\`\`\``);
          } else {
            contentParts.push(codeItem);
          }
        }
      }

      chunks.push({
        title: (snippet.codeTitle as string) || (snippet.pageTitle as string) || '',
        content: contentParts.join('\n\n'),
        source: (snippet.pageTitle as string) || '',
        url: (snippet.codeId as string) || '',
      });
    }

    // Calculate total tokens
    const totalTokens = snippets.reduce(
      (sum: number, s: Record<string, unknown>) => sum + ((s.codeTokens as number) || 0),
      0
    );

    return {
      libraryId: data.library || '',
      version: data.version || '',
      topic: data.topic || null,
      tokens: totalTokens,
      chunks,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ============================================================================
// Gemini Client with Store Caching
// ============================================================================

let storeCache: StoreCache | null = null;

async function fetchStores(client: GoogleGenAI): Promise<StoreCache> {
  log('debug', 'Fetching stores from Gemini API');

  const pager = await client.fileSearchStores.list({ config: { pageSize: 20 } });
  const stores: Array<Record<string, unknown>> = [];
  let page = pager.page;

  // Handle pagination
  while (true) {
    stores.push(...Array.from(page as Iterable<Record<string, unknown>>));
    if (!pager.hasNextPage()) break;
    page = await pager.nextPage();
  }

  // Transform API response into cache structure
  const storeMap = new Map<string, string>();
  const storeList: StoreCache['storeList'] = [];

  for (const store of stores) {
    const displayName = store.displayName as string | undefined;
    const name = store.name as string | undefined;

    if (displayName && name) {
      storeMap.set(displayName, name);
      storeList.push({
        name,
        displayName,
        createTime: store.createTime as string | undefined,
        updateTime: store.updateTime as string | undefined,
      });
    }
  }

  log('info', 'Stores fetched and cached', { count: stores.length });

  return {
    stores: storeMap,
    storeList,
    timestamp: Date.now(),
  };
}

async function getStores(client: GoogleGenAI, forceRefresh: boolean = false): Promise<StoreCache> {
  const now = Date.now();

  if (!forceRefresh && storeCache && (now - storeCache.timestamp) < STORE_CACHE_TTL) {
    log('debug', 'Using cached stores');
    return storeCache;
  }

  storeCache = await fetchStores(client);
  return storeCache;
}

// ============================================================================
// Response Formatters
// ============================================================================

function parseGroundingMetadata(grounding: Record<string, unknown>, topK: number): SearchResult {
  const chunksRaw = (grounding.groundingChunks as Array<Record<string, unknown>>) || [];

  // Extract unique source titles
  const sources = new Set<string>();
  for (const chunk of chunksRaw) {
    const retrievedCtx = chunk.retrievedContext as Record<string, unknown> | undefined;
    if (retrievedCtx?.title) {
      sources.add(retrievedCtx.title as string);
    }
  }

  // Extract and truncate chunks
  const chunks: ChunkData[] = [];
  for (let i = 0; i < Math.min(topK, chunksRaw.length); i++) {
    const chunk = chunksRaw[i];
    const retrievedCtx = chunk.retrievedContext as Record<string, unknown> | undefined;

    if (retrievedCtx) {
      const title = (retrievedCtx.title as string) || '';
      const text = (retrievedCtx.text as string) || '';
      const originalLength = text.length;
      const truncatedText = text.length > CHUNK_CHAR_LIMIT
        ? text.slice(0, CHUNK_CHAR_LIMIT)
        : text;

      chunks.push({
        title,
        text: truncatedText,
        truncated: text.length > CHUNK_CHAR_LIMIT,
        originalLength,
      });
    }
  }

  return {
    responseText: 'No response generated',
    sources: Array.from(sources).sort(),
    chunks,
  };
}

function formatAskDocsMarkdown(
  result: SearchResult,
  params: AskDocsInput
): string {
  const output: string[] = [];

  output.push(`# Search Results: ${params.target}\n\n`);
  output.push(`**Query**: ${params.query}\n\n`);
  output.push(`**Response**:\n${result.responseText}\n\n`);

  // Add sources section
  output.push('---\n\n');
  output.push(`**Sources** (${result.sources.length} files):\n`);
  for (const source of result.sources) {
    output.push(`  - ${source}\n`);
  }

  // Optionally add chunk previews
  if (params.include_chunks && result.chunks.length > 0) {
    output.push('\n---\n\n');
    output.push('## Retrieved Context Chunks\n\n');

    for (let i = 0; i < result.chunks.length; i++) {
      const chunk = result.chunks[i];
      output.push(`### [${i + 1}] ${chunk.title}\n\n`);
      output.push(`${chunk.text}\n`);

      if (chunk.truncated) {
        const charsOmitted = chunk.originalLength - chunk.text.length;
        output.push(`\n... [truncated, ${charsOmitted} chars omitted]\n`);
      }

      output.push('\n---\n\n');
    }
  }

  let response = output.join('');

  // Check character limit
  if (response.length > CHARACTER_LIMIT) {
    response = truncateResponse(response);
  }

  return response;
}

function formatAskDocsJson(
  result: SearchResult,
  params: AskDocsInput
): string {
  const outputDict: Record<string, unknown> = {
    query: params.query,
    target: params.target,
    response: result.responseText,
    sources: result.sources,
  };

  // Optionally include chunks
  if (params.include_chunks) {
    outputDict.chunks = result.chunks.map(chunk => ({
      title: chunk.title,
      text: chunk.text,
      truncated: chunk.truncated,
      original_length: chunk.originalLength,
    }));
  }

  const jsonStr = JSON.stringify(outputDict, null, 2);

  // Check character limit
  if (jsonStr.length > CHARACTER_LIMIT) {
    (outputDict as Record<string, unknown>)._truncation_warning = {
      warning: `Response exceeds ${CHARACTER_LIMIT} characters`,
      original_length: jsonStr.length,
      suggestion: 'Try reducing top_k or disabling include_chunks',
    };
    return JSON.stringify(outputDict, null, 2);
  }

  return jsonStr;
}

function formatDocsMarkdown(result: DocumentationResult, tokens: number): string {
  const output: string[] = [];

  // Header with metadata
  const libName = result.libraryId.includes('/')
    ? result.libraryId.split('/').pop()!
    : result.libraryId;

  output.push(`# Documentation: ${libName}\n`);
  output.push(`**Library:** ${result.libraryId}\n`);
  output.push(`**Version:** ${result.version}\n`);

  if (result.topic) {
    output.push(`**Topic:** ${result.topic}\n`);
  }

  output.push(`**Tokens:** ${result.tokens.toLocaleString()} / ${tokens.toLocaleString()} requested\n`);
  output.push('\n---\n\n');

  // Documentation chunks
  for (const chunk of result.chunks) {
    if (chunk.title) {
      output.push(`## ${chunk.title}\n\n`);
    }

    output.push(`${chunk.content}\n\n`);

    if (chunk.url) {
      const sourceText = chunk.source || 'Source';
      output.push(`[${sourceText}](${chunk.url})\n\n`);
    }

    output.push('---\n\n');
  }

  return truncateResponse(output.join(''));
}

function formatDocsJson(result: DocumentationResult, tokens: number): string {
  const data = {
    library: result.libraryId,
    version: result.version,
    topic: result.topic,
    tokens_used: result.tokens,
    tokens_requested: tokens,
    chunks: result.chunks.map(chunk => ({
      title: chunk.title,
      content: chunk.content,
      source: chunk.source,
      url: chunk.url,
    })),
  };
  return JSON.stringify(data, null, 2);
}

function formatSearchResults(libraries: LibraryInfo[], query: string, format: string): string {
  if (format === 'json') {
    const data = {
      query,
      count: libraries.length,
      libraries: libraries.slice(0, 20).map(lib => ({
        id: lib.id,
        title: lib.title,
        description: lib.description,
        stars: lib.stars,
        total_tokens: lib.totalTokens,
        benchmark_score: lib.benchmarkScore,
        versions: lib.versions.slice(0, 5),
      })),
    };
    return JSON.stringify(data, null, 2);
  }

  // Markdown format
  const output: string[] = [];
  output.push('# Library Search Results\n\n');
  output.push(`**Query:** "${query}"\n\n`);
  output.push(`Found ${libraries.length} matching libraries:\n\n`);

  // Table header
  output.push('| Library | Stars | Quality | Tokens | Description |\n');
  output.push('|---------|-------|---------|--------|-------------|\n');

  for (const lib of libraries.slice(0, 15)) {
    const stars = formatNumber(lib.stars);
    const quality = lib.benchmarkScore ? lib.benchmarkScore.toFixed(1) : 'N/A';
    const tokens = formatNumber(lib.totalTokens);
    const desc = lib.description.length > 50
      ? lib.description.slice(0, 50) + '...'
      : lib.description;

    output.push(`| ${lib.id} | ${stars} | ${quality} | ${tokens} | ${desc} |\n`);
  }

  if (libraries.length > 15) {
    output.push(`\n*...and ${libraries.length - 15} more results*\n`);
  }

  const firstId = libraries.length > 0 ? libraries[0].id : '/owner/repo';
  output.push(`\n**To fetch:** Use \`fetch_docs(target="${firstId}")\`\n`);

  return output.join('');
}

function formatNoMatch(target: string, candidates: Array<[LibraryInfo, number]>, format: string): string {
  if (format === 'json') {
    return JSON.stringify({
      error: 'no_confident_match',
      target,
      message: 'No library found with sufficient confidence',
      candidates: candidates.slice(0, 5).map(([lib, score]) => ({
        id: lib.id,
        title: lib.title,
        score,
      })),
      suggestion: `Try fetch_docs(target="${target}", browse_index=true) to see all results`,
    }, null, 2);
  }

  const output: string[] = [];
  output.push('# No Match Found\n\n');
  output.push(`**Target:** "${target}"\n\n`);
  output.push('No library found with sufficient confidence.\n\n');

  if (candidates.length > 0) {
    output.push('**Did you mean?**\n');
    for (const [lib, score] of candidates.slice(0, 5)) {
      output.push(`  - ${lib.id} (score: ${score.toFixed(1)})\n`);
    }
    output.push('\n');
  }

  output.push(`**Tip:** Try \`fetch_docs(target="${target}", browse_index=true)\` to see all search results.\n`);

  return output.join('');
}

function formatNoResults(target: string, format: string): string {
  if (format === 'json') {
    return JSON.stringify({
      error: 'no_results',
      target,
      message: `No libraries found matching '${target}'`,
      suggestion: 'Try a different search term or check spelling',
    }, null, 2);
  }

  return `# No Results Found

**Target:** "${target}"

No libraries found matching this search term.

**Suggestions:**
- Check the spelling of the library name
- Try the official name (e.g., "Next.js" instead of "nextjs")
- Use \`fetch_docs(target="${target}", browse_index=true)\` to see partial matches
`;
}

// ============================================================================
// Error Handling
// ============================================================================

function handleError(error: unknown, context: string): string {
  if (error instanceof Error) {
    const message = error.message;

    // API key errors
    if (message.includes('API key') || message.includes('UNAUTHENTICATED') || message.includes('401')) {
      return (
        `❌ Error: Invalid or missing API key during ${context}.\n\n` +
        '**Troubleshooting Steps:**\n' +
        '1. Verify environment variable is set:\n' +
        '   ```bash\n' +
        '   echo $GEMINI_API_KEY\n' +
        '   ```\n' +
        '2. Get a new API key: https://aistudio.google.com/apikey\n' +
        '3. Ensure key has File Search API access enabled\n'
      );
    }

    // Not found errors
    if (message.includes('404') || message.includes('NOT_FOUND') || message.includes('not found')) {
      return (
        `❌ Error: Resource not found during ${context}.\n\n` +
        '**Next Steps:**\n' +
        '1. Verify the target/library name is correct\n' +
        '2. Try using browse_index=true to see available options\n' +
        '3. Check spelling and try alternative names\n'
      );
    }

    // Rate limit errors
    if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('rate limit')) {
      return (
        `❌ Error: Rate limit exceeded during ${context}.\n\n` +
        '**Solutions:**\n' +
        '1. Wait a moment and try again\n' +
        '2. Set CONTEXT7_API_KEY for higher rate limits\n' +
        '3. Reduce request frequency\n'
      );
    }

    // Permission errors
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      return (
        `❌ Error: Permission denied during ${context}.\n\n` +
        '**Solutions:**\n' +
        '1. Verify API key permissions\n' +
        '2. Check if the resource requires authentication\n'
      );
    }

    // Timeout errors
    if (message.includes('DEADLINE_EXCEEDED') || message.includes('timeout') || message.includes('aborted')) {
      return (
        `❌ Error: Request timed out during ${context}.\n\n` +
        '**Solutions:**\n' +
        '1. Try again - the service may be temporarily slow\n' +
        '2. Use a smaller depth setting for fetch_docs\n' +
        '3. Simplify your query\n'
      );
    }

    return `❌ Error during ${context}: ${message}\n\nIf this persists, please file an issue.`;
  }

  return `❌ Unexpected error during ${context}: ${String(error)}\n\nPlease file an issue.`;
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function fetchDocs(params: FetchDocsInput): Promise<string> {
  log('info', 'fetchDocs called', { target: params.target, depth: params.depth });

  const apiKey = process.env.CONTEXT7_API_KEY;
  const tokens = DEPTH_TOKENS[params.depth];

  try {
    // Step 1: Search for libraries
    const libraries = await context7Search(params.target, apiKey);

    if (libraries.length === 0) {
      return formatNoResults(params.target, 'markdown');
    }

    // Step 2: If browse_index, just return search results
    if (params.browse_index) {
      return formatSearchResults(libraries, params.target, 'markdown');
    }

    // Step 3: Smart match to find best library
    const matcher = new LibraryMatcher(libraries);
    const matchResult = matcher.findBest(params.target);

    if (!matchResult.library) {
      return formatNoMatch(params.target, matchResult.candidates, 'markdown');
    }

    // Step 4: Fetch documentation
    const docs = await context7GetContext(
      matchResult.library.id,
      params.tag,
      tokens,
      params.version,
      apiKey
    );

    // Step 5: Format and return
    return formatDocsMarkdown(docs, tokens);
  } catch (error) {
    log('error', 'fetchDocs failed', { error: error instanceof Error ? error.message : String(error) });
    return handleError(error, 'fetching documentation');
  }
}

async function askDocsAgent(
  client: GoogleGenAI,
  params: AskDocsInput
): Promise<string> {
  log('info', 'askDocsAgent called', { target: params.target, query: params.query.substring(0, 50) });

  try {
    // Get stores from cache
    const cache = await getStores(client);

    // Validate store exists
    if (!cache.stores.has(params.target)) {
      const available = Array.from(cache.stores.keys()).sort();
      return (
        `❌ Error: Documentation target '${params.target}' not found.\n\n` +
        `**Available targets:**\n` +
        available.map(s => `  - ${s}`).join('\n') +
        `\n\n**Note:** Use one of the available target names listed above.`
      );
    }

    const storeName = cache.stores.get(params.target)!;

    // Query Gemini API with file search
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: params.query,
      config: {
        tools: [{
          fileSearch: {
            fileSearchStoreNames: [storeName],
            ...(params.metadata_filter && { metadataFilter: params.metadata_filter }),
          },
        }],
        temperature: 0.0,
      },
    });

    log('debug', 'Gemini API response received', {
      hasGrounding: !!(response.candidates?.[0] as Record<string, unknown>)?.groundingMetadata
    });

    // Check if we got results
    const candidate = response.candidates?.[0] as Record<string, unknown> | undefined;
    if (!candidate?.groundingMetadata) {
      if (params.format === 'json') {
        return JSON.stringify({
          query: params.query,
          target: params.target,
          response: 'No results found',
          sources: [],
          suggestion: 'The query may not match content in this target. Try rephrasing or use a different target.',
        }, null, 2);
      }
      return (
        `No results found in target '${params.target}' for query: ${params.query}\n\n` +
        '**Why this happened:** The query may not match any content in this documentation target.\n\n' +
        '**Try:**\n' +
        '  - Rephrasing your question with different keywords\n' +
        '  - Being more specific or more general\n' +
        '  - Searching a different documentation target'
      );
    }

    const grounding = candidate.groundingMetadata as Record<string, unknown>;
    const searchResult = parseGroundingMetadata(grounding, params.top_k);

    // Get response text
    if (response.text) {
      searchResult.responseText = response.text;
    }

    // Format response
    if (params.format === 'json') {
      return formatAskDocsJson(searchResult, params);
    }
    return formatAskDocsMarkdown(searchResult, params);
  } catch (error) {
    log('error', 'askDocsAgent failed', { error: error instanceof Error ? error.message : String(error) });
    return handleError(error, 'searching documentation');
  }
}

function curate(params: CurateInput): string {
  // Placeholder implementation
  if (params.format === 'json') {
    return JSON.stringify({
      status: 'success',
      action: params.action,
      collection: params.collection_name,
      message: `Would perform '${params.action}' on collection '${params.collection_name}'`,
      note: 'This is a placeholder. Implementation pending.',
    }, null, 2);
  }

  return `# Collection Management

**Action:** ${params.action}
**Collection:** ${params.collection_name || 'All'}
**Status:** Success

This is a placeholder. Implementation pending.
`;
}

function climb(params: ClimbInput): string {
  // Placeholder implementation
  if (params.format === 'json') {
    return JSON.stringify({
      status: 'success',
      collection: params.collection,
      path: params.path,
      action: params.action,
      message: `Would navigate '${params.collection}' at '${params.path}'`,
      note: 'This is a placeholder. Implementation pending.',
    }, null, 2);
  }

  return `# Documentation Navigation

**Collection:** ${params.collection}
**Path:** ${params.path}
**Action:** ${params.action}
**Status:** Success

This is a placeholder. Implementation pending.
`;
}

// ============================================================================
// Main Function
// ============================================================================

async function main(): Promise<void> {
  log('info', 'Starting Context Tools MCP Server');

  // Check for Gemini API key (optional but recommended)
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log('info', 'GEMINI_API_KEY not set - ask_docs_agent will not be available');
  }

  // Initialize Gemini client if API key is available
  let geminiClient: GoogleGenAI | null = null;
  if (geminiApiKey) {
    geminiClient = new GoogleGenAI({ apiKey: geminiApiKey });
  }

  // Create MCP server
  const server = new McpServer({
    name: 'context-tools',
    version: '1.0.0',
  });

  // Register resources if Gemini client is available
  if (geminiClient) {
    try {
      const cache = await getStores(geminiClient);
      log('info', 'Registering documentation reference resources', { count: cache.storeList.length });

      for (const store of cache.storeList) {
        const uri = `reference://${store.displayName}`;
        server.resource(
          store.displayName,
          uri,
          async () => {
            log('debug', 'Resource read', { uri });
            const content = JSON.stringify({
              displayName: store.displayName,
              name: store.name,
              createTime: store.createTime,
              updateTime: store.updateTime,
              usage: `Ask questions about this reference with the ask_docs_agent tool using target="${store.displayName}"`,
            }, null, 2);

            return {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: content,
              }],
            };
          }
        );
      }
      log('info', 'Documentation reference resources registered successfully');
    } catch (error) {
      log('error', 'Failed to register documentation reference resources', {
        error: error instanceof Error ? error.message : String(error)
      });
      // Continue anyway - tools can still work
    }
  }

  // Register fetch_docs tool
  server.tool(
    'fetch_docs',
    `Fetch library documentation from Context7 with smart matching.

This tool retrieves documentation for libraries/frameworks with intelligent
library name matching. It eliminates the need for two-step search-then-fetch
workflows - just provide your best guess for the library name.

**Matching Algorithm:**
Uses 2-tier matching (exact → fuzzy) to find the right library,
so "react", "React", or "mongodb" → "/mongodb/docs" all match correctly.

**Use this tool when you need:**
- API documentation for a library (e.g., "next.js", "fastapi")
- Framework guides and tutorials
- Code examples and best practices

**Parameters:**
- target: Library name guess (required)
- tag: Filter results by tag like "routing" or "hooks" (optional)
- depth: Token budget - "low" (5k), "medium" (15k), "high" (50k)
- version: Specific version tag like "v15.1.8" (optional)
- browse_index: Set true to list matching libraries instead of fetching docs

**Examples:**
- Simple: fetch_docs(target="react")
- With tag: fetch_docs(target="next.js", tag="routing")
- Deep dive: fetch_docs(target="pytorch", depth="high")
- Browse: fetch_docs(target="mongo", browse_index=true)`,
    FetchDocsInputSchema.shape,
    async (params: FetchDocsInput) => {
      const result = await fetchDocs(params);
      return {
        content: [{
          type: 'text' as const,
          text: result,
        }],
      };
    }
  );

  // Register ask_docs_agent tool
  server.tool(
    'ask_docs_agent',
    `Perform semantic search across documentation using AI-powered understanding.

This tool uses natural language understanding to find relevant documentation
based on conceptual queries, not just keyword matching. It can synthesize
answers from multiple sources and provide citations.

**Use this tool when you need to:**
- Ask complex conceptual questions about documentation
- Find documentation by describing what you're trying to do
- Get synthesized answers from multiple sources
- Understand "how" and "why" questions about documented topics

**Parameters:**
- query: Natural language search query (required)
- target: Documentation target to search (required)
- top_k: Number of relevant results (1-20, default 3)
- include_chunks: Include document excerpts (default false)
- format: Response format - "markdown" or "json"
- metadata_filter: Optional filter using List Filter syntax

**Important:** Requires GEMINI_API_KEY environment variable to be set.`,
    AskDocsInputSchema.shape,
    async (params: AskDocsInput) => {
      if (!geminiClient) {
        return {
          content: [{
            type: 'text' as const,
            text: (
              '❌ Error: GEMINI_API_KEY environment variable is not set.\n\n' +
              'Please set your Gemini API key:\n' +
              '  export GEMINI_API_KEY="your-api-key-here"\n\n' +
              'Get an API key from: https://aistudio.google.com/apikey'
            ),
          }],
        };
      }

      const result = await askDocsAgent(geminiClient, params);
      return {
        content: [{
          type: 'text' as const,
          text: result,
        }],
      };
    }
  );

  // Register curate tool (placeholder)
  server.tool(
    'curate',
    `Manage and organize documentation collections.

This tool helps organize fetched documentation into named collections,
add or remove sources, and maintain documentation structure.

**Use this tool when you need to:**
- List available documentation collections
- Add new documentation sources to a collection
- Remove outdated documentation
- Reorganize documentation structure

Returns collection information or operation status.

**Note:** This is currently a placeholder - implementation pending.`,
    CurateInputSchema.shape,
    async (params: CurateInput) => {
      const result = curate(params);
      return {
        content: [{
          type: 'text' as const,
          text: result,
        }],
      };
    }
  );

  // Register climb tool (placeholder)
  server.tool(
    'climb',
    `Navigate through documentation hierarchy and structure.

This tool enables traversal of documentation organization, allowing you to
explore structure, discover related content, and understand documentation layout.

**Use this tool when you need to:**
- Explore documentation structure
- List available sections or pages
- Get information about a documentation path
- Navigate to related documentation

Returns documentation structure information or navigation results.

**Note:** This is currently a placeholder - implementation pending.`,
    ClimbInputSchema.shape,
    async (params: ClimbInput) => {
      const result = climb(params);
      return {
        content: [{
          type: 'text' as const,
          text: result,
        }],
      };
    }
  );

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'Context Tools MCP server running via stdio');
}

// Run the server
main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
