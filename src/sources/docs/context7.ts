import axios from "axios";

const api = "https://context7.com/api/v1";
const headers = process.env.CONTEXT7_API_KEY
  ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` }
  : undefined;

export const depthTokens = {
  low: Number(process.env.FETCH_DOCS_LOW_TOKENS ?? "5000"),
  medium: Number(process.env.FETCH_DOCS_MEDIUM_TOKENS ?? "15000"),
  high: Number(process.env.FETCH_DOCS_HIGH_TOKENS ?? "50000"),
};
const semanticFloor = Number(process.env.FETCH_DOCS_SEMANTIC_FLOOR ?? "60");

export interface Library {
  id: string;
  title: string;
  description: string;
  stars: number;
  totalTokens: number;
  benchmarkScore: number;
}

export async function searchLibraries(query: string, signal: AbortSignal): Promise<Library[]> {
  const { data } = await axios.get<{ results?: Partial<Library>[] }>(`${api}/search`, {
    params: { query }, headers, signal,
  });
  return (data.results ?? []).map((lib) => ({
    id: lib.id ?? "",
    title: lib.title ?? "",
    description: lib.description ?? "",
    stars: lib.stars ?? 0,
    totalTokens: lib.totalTokens ?? 0,
    benchmarkScore: lib.benchmarkScore ?? 0,
  }));
}

function similarity(a: string, b: string): number {
  // Levenshtein distance, keeping only the previous row.
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    row = next;
  }
  return 100 * (1 - row[b.length] / (Math.max(a.length, b.length) || 1));
}

export type Candidate = { lib: Library; score: number };

export function matchLibrary(libraries: Library[], target: string): Library | Candidate[] {
  const query = target.toLowerCase().trim();
  const names = libraries.map((lib) => {
    const id = lib.id.toLowerCase();
    return { lib, title: lib.title.toLowerCase(), repo: id.split("/").at(-1)!, id };
  });
  // Prefer exact title, then repository name, then id (with or without leading slash).
  const lastFirst = [...names].reverse();
  const bareQuery = query.replace(/^\/+/, "");
  const exact = lastFirst.find((n) => n.title === query)
    ?? lastFirst.find((n) => n.repo === query)
    ?? lastFirst.find((n) => n.id === query)
    ?? lastFirst.find((n) => n.id.replace(/^\/+/, "") === bareQuery);
  if (exact) return exact.lib;

  const candidates = names.map(({ lib, title, repo, id }) => ({
    lib, score: Math.max(...Array.from(new Set([title, repo, id]), (n) => similarity(query, n))),
  })).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= semanticFloor ? best.lib : candidates;
}

interface Documentation {
  library?: string;
  version?: string;
  topic?: string | null;
  snippets?: {
    codeDescription?: string;
    codeList?: string[];
    codeLanguage?: string;
    codeTitle?: string;
    pageTitle?: string;
    codeId?: string;
    codeTokens?: number;
  }[];
}

export async function getDocumentation(
  library: Library, topic: string | undefined, version: string | undefined, tokens: number, signal: AbortSignal,
) {
  const id = library.id.replace(/^\/+/, "");
  const { data } = await axios.get<Documentation>(`${api}/${id}${version ? `/${version}` : ""}`, {
    params: { type: "json", tokens, ...(topic && { topic }) },
    headers, signal,
  });
  return data;
}
