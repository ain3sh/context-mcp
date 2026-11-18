const doi = /^10\.\d{4,9}\/[^\s\x00-\x1f]+$/i;
const arxiv = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;

export function doiUrl(id: string): string {
  if (!doi.test(id) || id.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Invalid DOI.");
  const preprint = /^10\.48550\/arxiv\.(.+)$/i.exec(id);
  if (preprint && arxiv.test(preprint[1])) return `https://arxiv.org/abs/${preprint[1]}`;
  return "https://doi.org/" + id.toLowerCase().split("/").map(encodeURIComponent).join("/");
}

/** Both search results and reader inputs pass through the same identity grammar. */
export function paperReference(value: string): string {
  if (doi.test(value)) return doiUrl(value);
  const url = URL.parse(value);
  if (url && ["https:", "http:"].includes(url.protocol) && !url.port && !url.username && !url.password) {
    const host = url.hostname.replace(/^www\./, "");
    const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
    if (host === "doi.org" || host === "dx.doi.org") return doiUrl(path.slice(1));
    if (host === "arxiv.org") {
      const m = /^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?$/.exec(path);
      if (m && arxiv.test(m[1])) return `https://arxiv.org/abs/${m[1]}`;
    }
    if (host === "pubmed.ncbi.nlm.nih.gov" && /^\/\d+$/.test(path)) return `https://${host}${path}/`;
    const pmc = /^\/(?:pmc\/)?articles\/(PMC\d+)$/i.exec(path);
    if (["pmc.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov"].includes(host) && pmc) {
      return `https://pmc.ncbi.nlm.nih.gov/articles/${pmc[1].toUpperCase()}/`;
    }
    if (["biorxiv.org", "medrxiv.org"].includes(host)) {
      const m = /^\/content\/(10\.\d{4,9}\/[\d.]+(?:v\d+)?)(?:\.full(?:\.pdf)?|\.abstract)?$/.exec(path);
      if (m) return `https://www.${host}/content/${m[1]}`;
    }
    if (host === "semanticscholar.org") {
      const m = /^\/paper\/(?:[^/]+\/)?([a-f0-9]{40})$/i.exec(path);
      if (m) return `https://www.semanticscholar.org/paper/${m[1].toLowerCase()}`;
    }
  }
  throw new Error(
    "Expected a DOI or an arXiv, PubMed, PMC, bioRxiv, medRxiv or Semantic Scholar paper URL.",
  );
}
