import { JSDOM } from "jsdom";
import { z } from "zod";
import { download, json } from "./http.js";
import { crossrefWork, epmc, plain, semanticApi, semanticFields, semanticWork } from "./providers.js";
import { doiUrl, paperReference } from "./references.js";

export const source = z.enum([
  "semantic_scholar",
  "crossref",
  "arxiv",
  "pubmed",
  "biorxiv",
  "medrxiv",
  "google_scholar",
]);
type Source = z.infer<typeof source>;
export const paper = z.object({
  reference: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().optional(),
  abstract: z.string().optional(),
  sources: z.array(source),
});
type Hit = z.infer<typeof paper>;
type Search = { query: string; source?: Source; year?: string; limit: number };

async function lookup(s: Source, { query, year, limit }: Search, signal: AbortSignal): Promise<Hit[]> {
  const [from, to = year] = (year ?? "").split("-");
  const sources = [s];
  if (s === "semantic_scholar") {
    const params = new URLSearchParams({
      query,
      fields: semanticFields,
      limit: String(limit),
      ...(year && { year }),
    });
    const page = z
      .union([z.object({ data: z.array(semanticWork) }), z.object({ total: z.literal(0) })])
      .parse(await json(`${semanticApi}/search?${params}`, signal));
    if (!("data" in page)) return [];
    const { data } = page;
    return data.map((w) => ({
      reference: w.externalIds?.DOI
        ? doiUrl(w.externalIds.DOI)
        : paperReference(
            w.externalIds?.ArXiv
              ? `https://arxiv.org/abs/${w.externalIds.ArXiv}`
              : `https://www.semanticscholar.org/paper/${w.paperId}`,
          ),
      title: w.title,
      authors: w.authors.map((a) => a.name),
      year: w.year ?? undefined,
      abstract: w.abstract ?? undefined,
      sources,
    }));
  }
  if (s === "crossref") {
    const filter = [from && `from-pub-date:${from}`, to && `until-pub-date:${to}`]
      .filter(Boolean)
      .join(",");
    const params = new URLSearchParams({
      "query.bibliographic": query,
      rows: String(limit),
      ...(filter && { filter }),
    });
    const { message } = z
      .object({ message: z.object({ items: z.array(crossrefWork) }) })
      .parse(await json(`https://api.crossref.org/works?${params}`, signal));
    return message.items.map((w) => ({
      reference: doiUrl(w.DOI),
      title: plain(w.title?.[0]) ?? w.DOI,
      sources,
      abstract: plain(w.abstract),
      year: w.published?.["date-parts"][0]?.[0],
      authors: (w.author ?? []).map((a) => a.name || [a.given, a.family].filter(Boolean).join(" ")),
    }));
  }
  if (s === "arxiv") {
    const terms = query
      .trim()
      .split(/\s+/)
      .map((t) => `all:"${t.replaceAll('"', "")}"`)
      .join(" AND ");
    const params = new URLSearchParams({
      search_query:
        terms + (from ? ` AND submittedDate:[${from}01010000 TO ${to || "9999"}12312359]` : ""),
      max_results: String(limit),
      sortBy: "relevance",
    });
    const r = await download(`https://export.arxiv.org/api/query?${params}`, signal);
    const doc = new JSDOM(r!.data.toString(), { contentType: "text/xml" }).window.document;
    if (doc.documentElement.localName !== "feed") throw new Error("arXiv did not return an Atom feed.");
    return [...doc.querySelectorAll("entry")].map((e) => ({
      reference: paperReference(e.querySelector("id")!.textContent.trim()),
      title: e.querySelector("title")!.textContent.trim(),
      authors: [...e.querySelectorAll("author > name")].map((x) => x.textContent.trim()),
      year: Number(e.querySelector("published")?.textContent.slice(0, 4)),
      abstract: e.querySelector("summary")?.textContent.trim(),
      sources,
    }));
  }
  if (s === "google_scholar") {
    const params = new URLSearchParams({
      q: query,
      num: String(limit),
      hl: "en",
      ...(from && { as_ylo: from }),
      ...(to && { as_yhi: to }),
    });
    const r = await download(`https://scholar.google.com/scholar?${params}`, signal);
    const doc = new JSDOM(r!.data.toString()).window.document;
    const rows = [...doc.querySelectorAll(".gs_r.gs_scl")];
    if (!rows.length && !/did not match|no results found/i.test(doc.body.textContent))
      throw new Error("Google Scholar blocked or did not provide search results. Try another index.");
    const hits = rows.flatMap((row) => {
      const link = row.querySelector(".gs_rt a");
      const href = link?.getAttribute("href");
      if (!href) return [];
      const meta = row.querySelector(".gs_a")?.textContent ?? "";
      const id = decodeURI(href).match(/10\.\d{4,9}\/[^?#\s]+/i)?.[0];
      let reference: string;
      try {
        reference = paperReference(href);
      } catch {
        if (!id) return [];
        reference = doiUrl(id.replace(/\/(?:full|abstract|pdf)\/?$/, ""));
      }
      return [
        {
          reference,
          title: link!.textContent.trim(),
          authors: meta.split(" - ")[0].split(/,\s*/).filter(Boolean),
          year: Number(meta.match(/\b(?:19|20)\d{2}\b/)?.[0]) || undefined,
          sources,
        },
      ];
    });
    if (rows.length && !hits.length)
      throw new Error("No Google Scholar results had a supported paper identifier.");
    return hits;
  }
  const scope =
    s === "pubmed" ? "SRC:MED" : `SRC:PPR AND PUBLISHER:"${s === "biorxiv" ? "bioRxiv" : "medRxiv"}"`;
  const records = await epmc(
    `(${query}) AND ${scope}${from ? ` AND FIRST_PDATE:[${from}-01-01 TO ${to || "9999"}-12-31]` : ""}`,
    limit,
    signal,
  );
  return records.flatMap((w) => {
    const reference =
      s === "pubmed"
        ? paperReference(`https://pubmed.ncbi.nlm.nih.gov/${w.id}/`)
        : w.doi
          ? paperReference(`https://www.${s}.org/content/${w.doi}`)
          : undefined;
    return reference
      ? [
          {
            reference,
            title: plain(w.title) ?? reference,
            authors: (w.authorList?.author ?? [])
              .map((a) => a.fullName || a.collectiveName || "")
              .filter(Boolean),
            year: Number(w.pubYear) || undefined,
            abstract: plain(w.abstractText),
            sources,
          },
        ]
      : [];
  });
}

export async function searchPapers(input: Search, signal: AbortSignal) {
  const indexes: Source[] = input.source ? [input.source] : ["semantic_scholar", "crossref"];
  const results = await Promise.allSettled(
    indexes.map((s) => lookup(s, input, AbortSignal.any([signal, AbortSignal.timeout(25_000)]))),
  );
  signal.throwIfAborted();
  const failures = results.flatMap((r, i) =>
    r.status === "rejected" ? [{ source: indexes[i], message: String(r.reason) }] : [],
  );
  if (failures.length === indexes.length)
    throw new Error(failures.map((f) => `${f.source}: ${f.message}`).join("; "));
  const papers = new Map<string, Hit>();
  const [firstYear, lastYear = firstYear] = (input.year ?? "").split("-");
  // Interleave rankings. Still visit all candidates so a late duplicate credits both sources.
  const lists = results.map((r) => (r.status === "fulfilled" ? r.value : []));
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++)
    for (const list of lists) {
      const hit = list[i];
      if (!hit) continue;
      if (
        firstYear &&
        (!hit.year || hit.year < Number(firstYear) || (lastYear && hit.year > Number(lastYear)))
      )
        continue;
      const prior = papers.get(hit.reference);
      if (prior) {
        if (!prior.sources.includes(hit.sources[0])) prior.sources = [...prior.sources, hit.sources[0]];
        prior.abstract ??= hit.abstract;
      } else papers.set(hit.reference, hit);
    }
  return { papers: [...papers.values()].slice(0, input.limit), failures };
}
