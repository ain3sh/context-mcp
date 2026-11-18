import { JSDOM } from "jsdom";
import { z } from "zod";
import { json } from "./http.js";

export function plain(html?: string | null) {
  return html ? JSDOM.fragment(html).textContent?.trim() || undefined : undefined;
}

export const crossrefWork = z.object({
  DOI: z.string(),
  title: z.array(z.string()).optional(),
  author: z
    .array(
      z.object({
        given: z.string().optional(),
        family: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  published: z.object({ "date-parts": z.array(z.array(z.number())) }).optional(),
  abstract: z.string().optional(),
  link: z.array(z.object({ URL: z.string(), "content-type": z.string().optional() })).optional(),
});
export const semanticWork = z.object({
  paperId: z.string(),
  title: z.string(),
  authors: z.array(z.object({ name: z.string() })),
  year: z.number().nullish(),
  abstract: z.string().nullish(),
  externalIds: z
    .object({ DOI: z.string().optional(), ArXiv: z.string().optional(), PubMed: z.string().optional() })
    .nullish(),
  openAccessPdf: z.object({ url: z.string() }).nullish(),
});
export const semanticApi = "https://api.semanticscholar.org/graph/v1/paper";
export const semanticFields = "title,authors,year,abstract,externalIds,openAccessPdf";
export const epmcApi = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const record = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string().optional(),
  doi: z.string().optional(),
  pmcid: z.string().optional(),
  pubYear: z.string().optional(),
  authorList: z
    .object({
      author: z.array(
        z.object({ fullName: z.string().optional(), collectiveName: z.string().optional() }),
      ),
    })
    .optional(),
  abstractText: z.string().optional(),
});
export async function epmc(query: string, limit: number, signal: AbortSignal) {
  const params = new URLSearchParams({
    query,
    format: "json",
    resultType: "core",
    pageSize: String(limit),
  });
  const data = await json(`${epmcApi}/search?${params}`, signal);
  return z.object({ resultList: z.object({ result: z.array(record) }) }).parse(data).resultList.result;
}
