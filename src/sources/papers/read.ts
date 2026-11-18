import { execFile } from "node:child_process";
import { JSDOM } from "jsdom";
import Turndown from "turndown";
import { z } from "zod";
import { download, json } from "./http.js";
import {
  crossrefWork,
  epmc,
  epmcApi,
  plain,
  semanticApi,
  semanticFields,
  semanticWork,
} from "./providers.js";
import { doiUrl, paperReference } from "./references.js";

type Content = { access: "full_text" | "abstract_only"; markdown: string } | { access: "metadata_only" };
export type Document = { title: string; source_url: string } & Content;
const unavailable = [401, 403, 404, 410, 451];
const markdown = new Turndown({ headingStyle: "atx" });
function metadata(title: string, source_url: string, abstract?: string | null): Document {
  return {
    title,
    source_url,
    ...(abstract?.trim()
      ? ({ access: "abstract_only", markdown: abstract.trim() } as const)
      : ({ access: "metadata_only" } as const)),
  };
}

function pdfText(pdf: Buffer, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "pdftotext",
      ["-enc", "UTF-8", "-", "-"],
      { signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err)
          return reject(
            new Error(
              err.code === "ENOENT"
                ? "Install Poppler (pdftotext) to read PDFs."
                : "PDF text extraction failed.",
              { cause: err },
            ),
          );
        const text = stdout.replaceAll("\f", "\n\n").trim();
        if (!text) return reject(new Error("No extractable text in this PDF."));
        resolve(text);
      },
    );
    child.stdin!.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code !== "EPIPE") reject(e);
    });
    child.stdin!.end(pdf);
  });
}

/** Only positively identified article bodies or PDFs count as full text, never an abstract/consent page. */
async function fullText(
  href: string,
  title: string,
  signal: AbortSignal,
): Promise<Document | undefined> {
  const file = await download(href, signal, unavailable);
  if (!file) return;
  if (file.data.subarray(0, 5).toString() === "%PDF-") {
    return {
      access: "full_text",
      title,
      source_url: file.url,
      markdown: await pdfText(file.data, signal),
    };
  }
  if (file.type.includes("pdf")) throw new Error("The paper provider returned an invalid PDF.");
  const doc = new JSDOM(file.data.toString(), { url: file.url }).window.document;
  const section = doc.querySelector(
    ".ltx_document:has(.ltx_section), .article.fulltext-view, .article__body:has(section), .article-body:has(section), .article__sections, [itemprop=articleBody]:has(section)",
  );
  if (!section) return;
  section.querySelectorAll("script,style,nav,button,form").forEach((n) => n.remove());
  const text = markdown.turndown(section.outerHTML).trim();
  if (text) return { access: "full_text", title, source_url: file.url, markdown: text };
}

async function archiveText(pmcid: string, title: string, signal: AbortSignal) {
  const file = await download(
    `${epmcApi}/${encodeURIComponent(pmcid)}/fullTextXML`,
    signal,
    unavailable,
  );
  if (!file) return;
  const doc = new JSDOM(file.data.toString(), { contentType: "text/xml" }).window.document;
  const body = doc.querySelector("article > body");
  if (!body) return;
  const rendered = [
    doc.querySelector("article-meta > abstract"),
    body,
    doc.querySelector("article > back"),
  ]
    .filter((n) => n)
    .map((n) => n!.outerHTML)
    .join("\n")
    .replace(/<(\/?)title>/g, "<$1h2>")
    .replace(/<(\/?)list(?: [^>]*)?>/g, "<$1ul>")
    .replace(/<(\/?)list-item>/g, "<$1li>");
  const text = markdown.turndown(rendered).trim();
  if (text) return { access: "full_text", title, source_url: file.url, markdown: text } as const;
}

async function readDoi(ref: string, signal: AbortSignal): Promise<Document> {
  const id = decodeURIComponent(new URL(ref).pathname.slice(1));
  const url = `https://api.crossref.org/works/${encodeURIComponent(id)}`;
  const file = await download(url, signal, [404]);
  let meta: Document, pdfUrl: string | undefined;
  if (file) {
    const work = z.object({ message: crossrefWork }).parse(JSON.parse(file.data.toString())).message;
    meta = metadata(plain(work.title?.[0]) ?? id, url, plain(work.abstract));
    pdfUrl = work.link?.find(
      (l) => l["content-type"] === "application/pdf" && l.URL.startsWith("https://"),
    )?.URL;
  } else {
    const dataUrl = `https://api.datacite.org/dois/${encodeURIComponent(id)}`;
    const {
      data: { attributes },
    } = z
      .object({
        data: z.object({
          attributes: z.object({
            titles: z.array(z.object({ title: z.string() })),
            descriptions: z
              .array(z.object({ description: z.string(), descriptionType: z.string() }))
              .optional(),
          }),
        }),
      })
      .parse(await json(dataUrl, signal));
    meta = metadata(
      attributes.titles[0]?.title ?? id,
      dataUrl,
      plain(attributes.descriptions?.find((d) => d.descriptionType === "Abstract")?.description),
    );
  }
  const record = (await epmc(`DOI:"${id.replaceAll('"', "")}"`, 1, signal))[0];
  if (record?.pmcid) {
    const body = await archiveText(record.pmcid, meta.title, signal);
    if (body) return body;
  }
  const publisher =
    (pdfUrl && (await fullText(pdfUrl, meta.title, signal))) ||
    (await fullText(ref, meta.title, signal));
  if (publisher) return publisher;
  if (meta.access === "metadata_only" && record?.abstractText) {
    return metadata(
      meta.title,
      `https://europepmc.org/article/${record.source}/${record.id}`,
      plain(record.abstractText),
    );
  }
  return meta;
}

/** reference is canonical (validated by paperReference). */
export async function readPaper(reference: string, signal: AbortSignal): Promise<Document> {
  const url = new URL(reference);
  if (url.hostname === "doi.org") return readDoi(reference, signal);
  if (url.hostname.endsWith(".ncbi.nlm.nih.gov")) {
    const id = url.pathname.split("/").filter(Boolean).at(-1)!;
    const [work] = await epmc(
      id.startsWith("PMC") ? `PMCID:${id}` : `EXT_ID:${id} AND SRC:MED`,
      1,
      signal,
    );
    if (!work) throw new Error(`No record for ${reference}`);
    const meta = metadata(plain(work.title) ?? id, reference, plain(work.abstractText));
    const body = work.pmcid && (await archiveText(work.pmcid, meta.title, signal));
    return (
      body || (work.doi && (await fullText(`https://doi.org/${work.doi}`, meta.title, signal))) || meta
    );
  }
  if (url.hostname === "www.semanticscholar.org") {
    const source = `${semanticApi}/${url.pathname.split("/").pop()}?fields=${semanticFields}`;
    const work = semanticWork.parse(await json(source, signal));
    const primary = work.externalIds?.ArXiv;
    if (primary) return readPaper(paperReference(`https://arxiv.org/abs/${primary}`), signal);
    const pdf = work.openAccessPdf?.url;
    if (pdf?.startsWith("https://")) {
      const body = await fullText(pdf, work.title, signal);
      if (body) return body;
    }
    if (work.externalIds?.DOI) return readPaper(doiUrl(work.externalIds.DOI), signal);
    return metadata(work.title, source, work.abstract);
  }
  const page = await download(reference, signal);
  const doc = new JSDOM(page!.data.toString()).window.document;
  const title = doc.querySelector<HTMLMetaElement>('meta[name="citation_title"]')?.content;
  if (!title) throw new Error("Could not identify the paper on its landing page.");
  const abstract =
    doc.querySelector("blockquote.abstract, #abstract-1, .abstract")?.textContent.trim() ||
    doc.querySelector<HTMLMetaElement>('meta[name="citation_abstract"]')?.content;
  const arxiv = url.hostname === "arxiv.org";
  for (const href of arxiv
    ? [reference.replace("/abs/", "/html/"), reference.replace("/abs/", "/pdf/")]
    : [`${reference}.full`, `${reference}.full.pdf`]) {
    const body = await fullText(href, title, signal);
    if (body) return body;
  }
  return metadata(title, page!.url, abstract);
}
