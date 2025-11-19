import axios, { AxiosError } from "axios";

const CONTEXT7_API_URL = "https://context7.com/api/v1";
const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
const CHARACTER_LIMIT = 25_000;

const DEPTH_TOKENS = {
  low: Number(process.env.FETCH_DOCS_LOW_TOKENS ?? "5000"),
  medium: Number(process.env.FETCH_DOCS_MEDIUM_TOKENS ?? "15000"),
  high: Number(process.env.FETCH_DOCS_HIGH_TOKENS ?? "50000"),
} as const;

const SEMANTIC_FLOOR = Number(
  process.env.FETCH_DOCS_SEMANTIC_FLOOR ?? "60",
);

type Depth = keyof typeof DEPTH_TOKENS;

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface FetchDocsParams {
  target: string;
  tag?: string;
  depth: Depth;
  version?: string;
  browse_index: boolean;
}

interface FetchParams {
  target: string;
  tag?: string;
  depth: Depth;
  version?: string;
  browseIndex: boolean;
  responseFormat: ResponseFormat;
}

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
  candidates: Array<{ lib: LibraryInfo; score: number }>;
}

async function makeRequest<T>(
  url: string,
  options?: {
    method?: "GET" | "POST";
    params?: Record<string, unknown>;
    timeout?: number;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const response = await axios.request<T>({
    url,
    method: options?.method ?? "GET",
    params: options?.params,
    timeout: options?.timeout,
    headers: options?.headers,
  });
  return response.data;
}

function truncateResponse(content: string, limit: number = CHARACTER_LIMIT): string {
  if (content.length <= limit) return content;
  const truncated = content.slice(0, limit);
  return (
    `${truncated}\n\n[TRUNCATED - Response exceeds ${limit.toLocaleString()} characters. ` +
    `Try using a lower depth or adding a topic filter.]`
  );
}

function formatApiErrorMessage(statusCode: number, message: string): string {
  const suggestions: string[] = [];
  if (statusCode === 401) {
    suggestions.push("Check your CONTEXT7_API_KEY if using authentication");
  } else if (statusCode === 404) {
    suggestions.push("The library may not exist in Context7's index");
    suggestions.push("Try searching with unsure=true to see available libraries");
  } else if (statusCode === 429) {
    suggestions.push("You've hit the rate limit - wait a moment and try again");
    suggestions.push("Set CONTEXT7_API_KEY for higher rate limits");
  }
  if (!suggestions.length) {
    suggestions.push("Try again later");
  }

  return [
    "# API Error",
    "",
    `**Status:** ${statusCode}`,
    `**Message:** ${message}`,
    "",
    "**Suggestions:**",
    ...suggestions.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

function formatError(error: unknown, context: string): string {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<any>;
    const status = err.response?.status ?? 500;
    const message =
      (err.response?.data as any)?.message ||
      (err.response?.data as any)?.error ||
      err.message;
    return formatApiErrorMessage(status, message);
  }

  const message = error instanceof Error ? error.message : String(error);
  return `Error in ${context}: ${message}`;
}

async function searchLibraries(query: string): Promise<LibraryInfo[]> {
  const headers: Record<string, string> = {};
  if (CONTEXT7_API_KEY) {
    headers["Authorization"] = `Bearer ${CONTEXT7_API_KEY}`;
  }

  type SearchResponse = { results?: any[] };
  const data = await makeRequest<SearchResponse>(`${CONTEXT7_API_URL}/search`, {
    params: { query },
    headers,
  });

  const results = data.results ?? [];
  return results.map((lib) => ({
    id: lib.id ?? "",
    title: lib.title ?? "",
    description: lib.description ?? "",
    stars: lib.stars ?? 0,
    totalTokens: lib.totalTokens ?? 0,
    trustScore: lib.trustScore ?? 0,
    benchmarkScore: lib.benchmarkScore ?? 0,
    versions: Array.isArray(lib.versions) ? lib.versions : [],
    branch: lib.branch ?? "",
    state: lib.state ?? "finalized",
  }));
}

async function getDocumentation(
  libraryId: string,
  topic: string | undefined,
  tokens: number,
  version: string | undefined,
): Promise<DocumentationResult> {
  const cleanId = libraryId.replace(/^\/+/, "");
  const base = version
    ? `${CONTEXT7_API_URL}/${cleanId}/${version}`
    : `${CONTEXT7_API_URL}/${cleanId}`;

  const headers: Record<string, string> = {};
  if (CONTEXT7_API_KEY) {
    headers["Authorization"] = `Bearer ${CONTEXT7_API_KEY}`;
  }

  const params: Record<string, unknown> = {
    type: "json",
    tokens,
  };
  if (topic) params.topic = topic;

  type Snippet = {
    codeDescription?: string;
    codeList?: string[];
    codeLanguage?: string;
    codeTitle?: string;
    pageTitle?: string;
    codeId?: string;
    codeTokens?: number;
  };

  type DocsResponse = {
    library?: string;
    version?: string;
    topic?: string | null;
    snippets?: Snippet[];
  };

  const data = await makeRequest<DocsResponse>(base, { params, headers });
  const snippets = data.snippets ?? [];

  const chunks: DocumentChunk[] = snippets.map((snippet) => {
    const parts: string[] = [];
    if (snippet.codeDescription) parts.push(snippet.codeDescription);
    if (snippet.codeList && snippet.codeList.length) {
      const lang = snippet.codeLanguage ?? "";
      for (const code of snippet.codeList) {
        if (lang) {
          parts.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\``);
        } else {
          parts.push(code);
        }
      }
    }
    const title = snippet.codeTitle || snippet.pageTitle || "";
    const source = snippet.pageTitle || "";
    const url = snippet.codeId || "";
    return {
      title,
      content: parts.join("\n\n"),
      source,
      url,
    };
  });

  const totalTokens = snippets.reduce(
    (acc, s) => acc + (s.codeTokens ?? 0),
    0,
  );

  return {
    libraryId: data.library ?? "",
    version: data.version ?? "",
    topic: data.topic ?? null,
    tokens: totalTokens,
    chunks,
  };
}

function buildMatchResult(libraries: LibraryInfo[], target: string): MatchResult {
  if (!libraries.length) {
    return { library: null, score: 0, tier: "none", candidates: [] };
  }

  const normalizedTarget = target.toLowerCase().trim();

  const byTitle = new Map<string, LibraryInfo>();
  const byRepo = new Map<string, LibraryInfo>();
  for (const lib of libraries) {
    byTitle.set(lib.title.toLowerCase(), lib);
    const repo = lib.id.includes("/")
      ? lib.id.split("/").pop()!.toLowerCase()
      : lib.id.toLowerCase();
    byRepo.set(repo, lib);
  }

  if (byTitle.has(normalizedTarget)) {
    return {
      library: byTitle.get(normalizedTarget)!,
      score: 100,
      tier: "exact",
      candidates: [],
    };
  }
  if (byRepo.has(normalizedTarget)) {
    return {
      library: byRepo.get(normalizedTarget)!,
      score: 100,
      tier: "exact",
      candidates: [],
    };
  }

  function similarity(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    const dp: number[][] = Array.from({ length: la + 1 }, () =>
      new Array(lb + 1).fill(0),
    );
    for (let i = 0; i <= la; i++) dp[i][0] = i;
    for (let j = 0; j <= lb; j++) dp[0][j] = j;
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }
    const dist = dp[la][lb];
    const maxLen = Math.max(la, lb) || 1;
    return 100 * (1 - dist / maxLen);
  }

  const candidates: Array<{ lib: LibraryInfo; score: number }> = [];
  for (const lib of libraries) {
    const names = new Set<string>();
    names.add(lib.title.toLowerCase());
    const repo = lib.id.includes("/")
      ? lib.id.split("/").pop()!.toLowerCase()
      : lib.id.toLowerCase();
    names.add(repo);
    names.add(lib.id.toLowerCase());

    let bestForLib = 0;
    for (const name of names) {
      const score = similarity(normalizedTarget, name);
      if (score > bestForLib) bestForLib = score;
    }
    candidates.push({ lib, score: bestForLib });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best.score >= SEMANTIC_FLOOR) {
    return {
      library: best.lib,
      score: best.score,
      tier: "semantic",
      candidates,
    };
  }

  return {
    library: null,
    score: best.score,
    tier: "semantic",
    candidates,
  };
}

function formatDocsMarkdown(result: DocumentationResult, params: FetchParams): string {
  const out: string[] = [];
  const libName = result.libraryId.includes("/")
    ? result.libraryId.split("/").pop()!
    : result.libraryId;

  out.push(`# Documentation: ${libName}\n`);
  out.push(`**Library:** ${result.libraryId}`);
  out.push(`**Version:** ${result.version}`);
  if (result.topic) {
    out.push(`**Topic:** ${result.topic}`);
  }
  out.push(
    `**Tokens:** ${result.tokens.toLocaleString()} / ${DEPTH_TOKENS[params.depth].toLocaleString()} requested`,
  );
  out.push("\n---\n\n");

  for (const chunk of result.chunks) {
    if (chunk.title) {
      out.push(`## ${chunk.title}\n\n`);
    }
    out.push(`${chunk.content}\n\n`);
    if (chunk.url) {
      const sourceText = chunk.source || "Source";
      out.push(`[${sourceText}](${chunk.url})\n\n`);
    }
    out.push("---\n\n");
  }

  return truncateResponse(out.join(""));
}

function formatDocsJson(result: DocumentationResult, params: FetchParams): string {
  const data = {
    library: result.libraryId,
    version: result.version,
    topic: result.topic,
    tokens_used: result.tokens,
    tokens_requested: DEPTH_TOKENS[params.depth],
    chunks: result.chunks.map((chunk) => ({
      title: chunk.title,
      content: chunk.content,
      source: chunk.source,
      url: chunk.url,
    })),
  };
  return JSON.stringify(data, null, 2);
}

function formatSearchMarkdown(libraries: LibraryInfo[], query: string): string {
  const out: string[] = [];
  out.push("# Library Search Results\n\n");
  out.push(`**Query:** "${query}"\n\n`);
  out.push(`Found ${libraries.length} matching libraries:\n\n`);
  out.push("| Library | Stars | Quality | Tokens | Description |\n");
  out.push("|---------|-------|---------|--------|-------------|\n");

  const top = libraries.slice(0, 15);
  for (const lib of top) {
    const stars = formatNumber(lib.stars);
    const quality = lib.benchmarkScore ? lib.benchmarkScore.toFixed(1) : "N/A";
    const tokens = formatNumber(lib.totalTokens);
    const desc = lib.description.length > 50
      ? `${lib.description.slice(0, 50)}...`
      : lib.description;
    out.push(
      `| ${lib.id} | ${stars} | ${quality} | ${tokens} | ${desc} |\n`,
    );
  }

  if (libraries.length > 15) {
    out.push(`\n*...and ${libraries.length - 15} more results*\n`);
  }

  const firstId = libraries[0]?.id ?? "/owner/repo";
  out.push(
    `\n**To fetch:** Use \`fetch_docs(target="${firstId}")\`\n`,
  );

  return out.join("");
}

function formatSearchJson(libraries: LibraryInfo[], query: string): string {
  const data = {
    query,
    count: libraries.length,
    libraries: libraries.slice(0, 20).map((lib) => ({
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

function formatNoResults(target: string, responseFormat: ResponseFormat): string {
  if (responseFormat === ResponseFormat.JSON) {
    return JSON.stringify(
      {
        error: "no_results",
        target,
        message: `No libraries found matching '${target}'`,
        suggestion:
          "Try a different search term or check spelling",
      },
      null,
      2,
    );
  }

  return [
    "# No Results Found",
    "",
    `**Target:** "${target}"`,
    "",
    "No libraries found matching this search term.",
    "",
    "**Suggestions:**",
    "- Check the spelling of the library name",
    "- Try the official name (e.g., \"Next.js\" instead of \"nextjs\")",
    `- Use \`fetch_docs(target="${target}", browse_index=true)\` to see partial matches`,
    "",
  ].join("\n");
}

function formatNoMatch(
  target: string,
  candidates: Array<{ lib: LibraryInfo; score: number }>,
  responseFormat: ResponseFormat,
): string {
  if (responseFormat === ResponseFormat.JSON) {
    return JSON.stringify(
      {
        error: "no_confident_match",
        target,
        message: "No library found with sufficient confidence",
        candidates: candidates.slice(0, 5).map(({ lib, score }) => ({
          id: lib.id,
          title: lib.title,
          score,
        })),
        suggestion:
          `Try fetch_docs(target="${target}", browse_index=true) to see all results`,
      },
      null,
      2,
    );
  }

  const out: string[] = [];
  out.push("# No Match Found\n\n");
  out.push(`**Target:** "${target}"\n\n`);
  out.push("No library found with sufficient confidence.\n\n");
  if (candidates.length) {
    out.push("**Did you mean?**\n");
    for (const { lib, score } of candidates.slice(0, 5)) {
      out.push(`  - ${lib.id} (score: ${score.toFixed(1)})\n`);
    }
    out.push("\n");
  }
  out.push(
    `**Tip:** Try \`fetch_docs(target="${target}", browse_index=true)\` to see all search results.\n`,
  );
  return out.join("");
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export async function fetchDocs(params: FetchDocsParams): Promise<string> {
  const fetchParams: FetchParams = {
    target: params.target,
    tag: params.tag,
    depth: params.depth,
    version: params.version,
    browseIndex: params.browse_index,
    responseFormat: ResponseFormat.MARKDOWN,
  };

  try {
    const libraries = await searchLibraries(fetchParams.target);
    if (!libraries.length) {
      return formatNoResults(
        fetchParams.target,
        fetchParams.responseFormat,
      );
    }

    if (fetchParams.browseIndex) {
      if (fetchParams.responseFormat === ResponseFormat.JSON) {
        return formatSearchJson(libraries, fetchParams.target);
      }
      return formatSearchMarkdown(libraries, fetchParams.target);
    }

    const match = buildMatchResult(libraries, fetchParams.target);
    if (!match.library) {
      return formatNoMatch(
        fetchParams.target,
        match.candidates,
        fetchParams.responseFormat,
      );
    }

    const docs = await getDocumentation(
      match.library.id,
      fetchParams.tag,
      DEPTH_TOKENS[fetchParams.depth],
      fetchParams.version,
    );

    if (fetchParams.responseFormat === ResponseFormat.JSON) {
      return formatDocsJson(docs, fetchParams);
    }
    return formatDocsMarkdown(docs, fetchParams);
  } catch (error) {
    return formatError(error, "fetch_docs");
  }
}
