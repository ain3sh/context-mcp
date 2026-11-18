import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import fc from "fast-check";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCodeWiki } from "../dist/tools/codeWiki.js";
import { registerFetchDocs } from "../dist/tools/fetchDocs.js";
import { registerPaperSearch } from "../dist/tools/paperSearch.js";
import { PaperReader, registerPaperRead } from "../dist/tools/paperRead.js";
import { paperReference } from "../dist/sources/papers/references.js";

const doi = "10.1234/example";
const ref = `https://doi.org/${doi}`;
const shared = { title: "Same title", year: 2020 };
const signal = new AbortController().signal;

async function harness(t) {
  const server = new McpServer({ name: "test", version: "1" });
  registerPaperSearch(server);
  registerPaperRead(server);
  registerCodeWiki(server);
  registerFetchDocs(server);
  const client = new Client({ name: "reader", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  await client.listTools();
  return (name, args) => client.callTool({ name, arguments: args });
}
function response(body, status = 200, type = "application/json") {
  return {
    data: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    headers: { "content-type": type },
    status,
  };
}

test("default search interleaves arXiv and Crossref, credits matching IDs, and reports partial failures", async (t) => {
  const call = await harness(t);
  let arxivStatus = 200,
    crossrefStatus = 200,
    hasAbstract = true;
  t.mock.method(axios, "get", async (href) => {
    const url = new URL(href);
    const work = {
      DOI: doi.toUpperCase(),
      title: [shared.title],
      ...(hasAbstract && { abstract: "<p>Real abstract</p>" }),
    };
    if (url.hostname === "export.arxiv.org") {
      assert.match(url.searchParams.get("search_query"), /ti:"same title"/);
      return response(
        `<feed>${["2004.12831", "2004.12832", "2004.12833"].map((id, i) => `<entry>
          <id>https://arxiv.org/abs/${id}</id><title>${i ? shared.title : `Not the ${shared.title}`}</title><published>2020-04-27</published>
        </entry>`).join("")}</feed>`,
        arxivStatus,
      );
    }
    if (url.pathname === "/works") return response({
      message: { items: [{ ...work, DOI: "10.48550/arxiv.2004.12832" }, work] },
    }, crossrefStatus);
    if (url.pathname.startsWith("/works/")) return response({ message: work });
    if (url.hostname === "www.ebi.ac.uk") return response({ resultList: { result: [] } });
    if (url.hostname === "doi.org")
      return response("<article>Subscribe for access</article>", 200, "text/html");
    throw new Error(`Unexpected URL: ${url.origin}`);
  });
  const search = () => call("paper_search", { query: "same title" });
  const first = (await search()).structuredContent;
  assert.deepEqual(first.failures, []);
  assert.deepEqual(
    first.papers.map((p) => [p.reference, p.sources]),
    [
      ["https://arxiv.org/abs/2004.12832", ["crossref", "arxiv"]],
      [ref, ["crossref"]],
      ["https://arxiv.org/abs/2004.12833", ["arxiv"]],
      ["https://arxiv.org/abs/2004.12831", ["arxiv"]],
    ],
  );
  const reference = first.papers[1].reference;
  assert.deepEqual((await call("paper_read", { reference })).structuredContent, {
    reference,
    title: shared.title,
    source_url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    access: "abstract_only",
    markdown: "Real abstract",
  });
  hasAbstract = false;
  const bare = (await call("paper_read", { reference: doi })).structuredContent;
  assert.equal(bare.access, "metadata_only");
  assert.ok(!("markdown" in bare));
  arxivStatus = 503;
  const partial = (await search()).structuredContent;
  assert.deepEqual(partial.papers[0].sources, ["crossref"]);
  assert.deepEqual(
    partial.failures.map((f) => f.source),
    ["arxiv"],
  );
  crossrefStatus = 503;
  assert.equal((await search()).isError, true);
  for (const args of [
    { year: "2024-2020" },
    { limit: 21 },
    { year: "2024-2" },
    { sort: "date" },
    { query: " " },
  ])
    assert.equal((await call("paper_search", { query: "test", ...args })).isError, true);
});

test("versioned links, zero hits, blocked sources, and full-text provenance survive the provider boundary", async (t) => {
  const call = await harness(t);
  const urls = [];
  t.mock.method(axios, "get", async (href) => {
    const u = new URL(href);
    urls.push(u);
    if (u.hostname === "export.arxiv.org")
      return response(
        `<feed><entry><id>http://arxiv.org/abs/2004.12832v1</id><title>Example</title><published>2020-04-27</published><author><name>A B</name></author></entry></feed>`,
      );
    if (u.pathname.startsWith("/abs/"))
      return response('<meta name="citation_title" content="Example">');
    if (u.pathname.startsWith("/html/"))
      return response(
        '<article class="ltx_document"><section class="ltx_section"><h2>Methods</h2><p>The method.</p></section></article>',
        200,
        "text/html",
      );
    if (u.hostname === "scholar.google.com") return response("Verify your session", 200, "text/html");
    if (u.hostname === "www.ebi.ac.uk") return response({ resultList: { result: [] } });
    throw new Error("Unexpected endpoint");
  });
  const query = "retrieval";
  const arxiv = await call("paper_search", { source: "arxiv", query, year: "2020-" });
  assert.match(urls[0].searchParams.get("search_query"), /202001010000 TO/);
  const { reference } = arxiv.structuredContent.papers[0];
  const article = (await call("paper_read", { reference })).structuredContent;
  assert.equal(article.access, "full_text");
  assert.equal(article.source_url, "https://arxiv.org/html/2004.12832v1");
  assert.match(article.markdown, /## Methods/);
  assert.ok(!("next_cursor" in article));
  for (const [source, scope] of [
    ["pubmed", "SRC:MED"],
    ["biorxiv", 'PUBLISHER:"bioRxiv"'],
    ["medrxiv", 'PUBLISHER:"medRxiv"'],
  ]) {
    const result = (await call("paper_search", { source, query, year: "2020" })).structuredContent;
    assert.deepEqual(result, { papers: [], failures: [] });
    assert.ok(urls.at(-1).searchParams.get("query").includes(scope));
  }
  assert.equal((await call("paper_search", { source: "google_scholar", query })).isError, true);
  assert.equal(
    paperReference("https://www.medrxiv.org/content/10.1101/2020.01.01.123456v2.full.pdf"),
    "https://www.medrxiv.org/content/10.1101/2020.01.01.123456v2",
  );
});

test("Scholar results expose readable IDs; an unavailable index is not an empty index", async (t) => {
  const call = await harness(t);
  let offline = false;
  t.mock.method(axios, "get", async (href) => {
    if (offline) throw new Error("connection lost");
    if (new URL(href).hostname === "api.semanticscholar.org") return response({ total: 0, offset: 0 });
    return response(
      `<div class="gs_r gs_scl"><h3 class="gs_rt"><a href="https://publisher.example/doi/${doi}">Example</a></h3><div class="gs_a">A Smith, B Jones - Journal, 2024</div></div>`,
      200,
      "text/html",
    );
  });
  const result = await call("paper_search", { query: "search", source: "google_scholar" });
  assert.deepEqual(result.structuredContent.papers, [
    {
      reference: ref,
      title: "Example",
      authors: ["A Smith", "B Jones"],
      year: 2024,
      sources: ["google_scholar"],
    },
  ]);
  const empty = await call("paper_search", { query: "no matches", source: "semantic_scholar" });
  assert.deepEqual(empty.structuredContent, { papers: [], failures: [] });
  offline = true;
  assert.equal((await call("paper_read", { reference: ref })).isError, true);
});

test("wiki routing uses real MCP requests and preserves upstream Markdown", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.method === "GET") return new Response(null, { status: 405 });
    const msg = JSON.parse(init.body);
    if (!msg.id && msg.id !== 0) return new Response(null, { status: 202 });
    let result;
    if (msg.method === "initialize")
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "wiki", version: "1" },
      };
    else {
      assert.equal(msg.method, "tools/call");
      calls.push(msg.params);
      result = { content: [{ type: "text", text: "[Source](https://deepwiki.com/example/repo)" }] };
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  });
  const call = await harness(t);
  const a = "https://github.com/example/repo",
    b = "https://github.com/example/sdk";
  for (const args of [
    { reference: a },
    { reference: a, query: "read" },
    { reference: [a, b], query: "How do reads work?" },
  ]) {
    const res = await call("code_wiki", args);
    assert.equal(res.content[0].text, "[Source](https://deepwiki.com/example/repo)");
  }
  assert.deepEqual(
    calls.map((c) => [c.name, c.arguments]),
    [
      ["read_wiki_structure", { repoName: "example/repo" }],
      ["read_wiki_contents", { repoName: "example/repo" }],
      [
        "ask_wiki_question",
        { repoName: ["example/repo", "example/sdk"], question: "How do reads work?" },
      ],
    ],
  );
  for (const args of [
    { reference: [a, b], query: "read" },
    { reference: a, query: " " },
    { reference: `${a}/tree/main` },
    { reference: a, extra: true },
  ])
    assert.equal((await call("code_wiki", args)).isError, true);
  assert.equal(calls.length, 3);
});

test("fetch_docs honors explicit IDs and provider ranking and preserves versioned Markdown", async (t) => {
  const call = await harness(t);
  const base = "https://context7.com/api/v1";
  const id = "/example/widgets";
  const otherId = "/example/widgets-archive";
  const markdown = "### Install\n\nSource: https://example.org/docs\n\n```sh\nnpm i widgets\n```";
  const docRequests = [];
  t.mock.method(axios, "get", async (url, { params }) => {
    if (url === `${base}/search`) {
      if (params.query === "offline") {
        throw new axios.AxiosError("Unavailable", undefined, undefined, undefined, { status: 429 });
      }
      const results = params.query === "absent" ? [] : [
        { id, title: "Widgets" },
        { id: otherId, title: "Widgets" },
        { id: "/example/unrelated", title: otherId },
      ];
      return { data: { results } };
    }
    docRequests.push({ url, params });
    return { data: markdown };
  });
  const docs = (args) => call("fetch_docs", args);
  assert.match((await docs({ target: "Widgets", browse_index: true })).content[0].text, /\| \/example\/widgets \|/);
  assert.match((await docs({ target: "absent" })).content[0].text, /No Results Found/);
  assert.match((await docs({ target: "nosuchpackagezz" })).content[0].text, /Did you mean\?[\s\S]*\/example\/widgets/);
  for (const target of ["Widgets", otherId, "Widges"]) {
    const result = await docs({ target, version: "v2", tag: "install" });
    assert.equal(result.isError, false);
    assert.ok(result.content[0].text.includes(markdown));
  }
  const params = { type: "txt", tokens: Number(process.env.FETCH_DOCS_MEDIUM_TOKENS ?? 15_000), topic: "install" };
  assert.deepEqual(docRequests, [id, otherId, id].map(id => ({ url: `${base}${id}/v2`, params })));
  const failure = await docs({ target: "offline" });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /429/);
});

test("bookmarks replay immutable pages for independent readers, even across overlapping loads", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(fc.constantFrom("x", "🦊", "\n"), { minLength: 12, maxLength: 70 }),
      async (s, chars) => {
        const original = chars.join("");
        let loads = 0;
        const load = s.scheduleFunction(async () => ({
          access: "full_text",
          title: "fixture",
          source_url: ref,
          markdown: `${++loads}:${original}`,
        }));
        const reader = new PaperReader(load, 5, 512);
        const pages = await s.waitFor(
          Promise.all([
            reader.read({ reference: ref }, signal),
            reader.read({ reference: ref }, signal),
          ]),
        );
        for (let page of pages) {
          const prefix = page.markdown.slice(0, 2);
          let text = page.markdown;
          while (page.next_cursor) {
            const args = { reference: doi, cursor: page.next_cursor };
            const [first, replay] = await Promise.all([
              reader.read(args, signal),
              reader.read(args, signal),
            ]);
            assert.deepEqual(replay, first);
            assert.ok(first.markdown.isWellFormed());
            text += first.markdown;
            page = first;
          }
          assert.equal(text, prefix + original);
        }
        assert.equal(loads, 2);
      },
    ),
  );
});

test("expired and wrong-paper bookmarks never fetch or resume a different document", async () => {
  let loads = 0;
  const load = async () => ({
    access: "full_text",
    title: "test",
    source_url: ref,
    markdown: `${++loads}2345678`,
  });
  const reader = new PaperReader(load, 4, 2 * ref.length + "test".length + 8);
  const { next_cursor: cursor } = await reader.read({ reference: doi }, signal);
  await assert.rejects(reader.read({ reference: "10.1234/other", cursor }, signal), /cursor/);
  await reader.read({ reference: doi }, signal);
  await assert.rejects(reader.read({ reference: doi, cursor }, signal), /expired/);
  await assert.rejects(new PaperReader(load).read({ reference: doi, cursor }, signal), /expired/);
  assert.equal(loads, 2);
});
