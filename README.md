# Context Tools MCP Server

Search code, browse repository wikis, find and read research papers, and fetch documentation over MCP stdio.

## Features

- 📚 **Library Docs** - Instant access to 1000+ libraries via Context7 API
- 🔍 **Code and Research** - Repository wikis, code excerpts and scholarly sources
- ⚡ **Token Efficient** - Optimized responses to avoid context bloat

## Quick Start

### Recommended: `npx`
```bash
npx -y github:ain3sh/context-mcp
```

No installation required. Always uses the latest version.

### From Source
```bash
git clone https://github.com/ain3sh/context-mcp.git
cd context-mcp
npm install
npm run build
npm start
```

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "context-mcp": {
      "command": "npx",
      "args": ["-y", "github:ain3sh/context-mcp"]
    }
  }
}
```

### Claude Code (Project-Level)

Create `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "context-mcp": {
      "type": "stdio", 
      "command": "npx",
      "args": ["-y", "github:ain3sh/context-mcp"]
    }
  }
}
```

## Tools Overview

| Tool | Purpose | Token Usage |
|------|---------|-------------|
| [`code_search`](#code_search) | Find relevant code in a local directory or GitHub repository | Varies with excerpts |
| [`fetch_docs`](#fetch_docs) | Get library/framework documentation | ~5k-50k tokens |
| [`code_wiki`](#code_wiki) | Outline, read or ask about a public repo's DeepWiki | Depends on view |
| [`paper_search`](#paper_search) | Find papers and readable references | Up to 20 hits |
| [`paper_read`](#paper_read) | Read accessible source text or metadata | Full text paged |

---

### `code_search`

Ask where or how something is implemented. The only required field is `query`.

```js
code_search({ query: "Where are tools registered?" })
code_search({ query: "Where is cancellation handled?", reference: "../other-worktree" })
code_search({ query: "How is stdio framed?", reference: "https://github.com/modelcontextprotocol/typescript-sdk" })
code_search({ query: "How is login wired?", reference: "https://github.com/acme/widgets/tree/feature/auth" })
```

Omitting `reference` (or passing `"."`) searches the MCP server's launch directory, including uncommitted code. Local paths can be absolute or relative to that directory. `acme/widgets` is a local path, not a GitHub shorthand.

A GitHub repo URL searches the default branch. Everything after `/tree/` names **one exact branch**, not a subdirectory, tag, or commit. A missing branch fails the search. GitHub searches shallow-clone into a temporary directory removed after each call, not a persistent cache. Private repositories use your Git credentials.

Results contain `reference` (the resolved local directory or GitHub URL), `summary`, and `contexts` with repo- or directory-relative `file`, `lines` when available, and `content`. Both structured MCP output and readable text are returned.

**Setup:** Put the [Morph CLI](https://docs.morphllm.com/cli) on the MCP server's `PATH` and configure a Morph profile or `MORPH_API_KEY`. GitHub search also requires Git. Search sends the query and selected code to Morph. The other tools do not need Morph. Searches have a two-minute deadline; if your MCP client uses a shorter tool timeout, raise it to allow longer searches to finish.

---

### `fetch_docs`

Fetch documentation for any library or framework from Context7's massive index.

#### Usage Examples
```javascript
// Simple library fetch
fetch_docs({
  target: "react"
})

// Specific topic within a library
fetch_docs({
  target: "pytorch",
  tag: "autograd"
})

// Control documentation depth
fetch_docs({
  target: "pandas",
  depth: "high"  // ~50k tokens for comprehensive docs
})

// Browse available versions
fetch_docs({
  target: "tensorflow",
  browse_index: true
})
```

#### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | string | required | Library name (fuzzy matching supported) |
| `tag` | string | - | Topic filter within library |
| `depth` | `"low"` \| `"medium"` \| `"high"` | `"medium"` | Documentation comprehensiveness (~5k/15k/50k tokens) |
| `version` | string | - | Specific version to fetch |
| `browse_index` | boolean | `false` | List available libraries instead of fetching docs |

#### How It Works
```text
Query → Context7 API → Smart matching → Filtered docs → Markdown response
```

Context7 maintains pre-indexed documentation for 1000+ libraries. The tool uses fuzzy matching, so "tf" finds "tensorflow", "pd" finds "pandas", etc.

---

### `code_wiki`

```js
const reference = "https://github.com/modelcontextprotocol/typescript-sdk"
code_wiki({ reference })                               // outline
code_wiki({ reference, query: "read" })                 // full wiki
code_wiki({ reference, query: "How do transports work?" })
```

Uses [Cognition's public DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp). A question can take up to ten GitHub repo root URLs; browsing is for one repo. Use `code_search` for branch-specific questions.

### `paper_search`

```js
paper_search({ query: "late interaction retrieval", year: "2020-2024", limit: 5 })
paper_search({ query: "graph representation learning", source: "arxiv" })
```

Defaults to Semantic Scholar and Crossref. Restrict `source` to `semantic_scholar`, `crossref`, `arxiv`, `pubmed`, `biorxiv`, `medrxiv`, or `google_scholar`. PubMed and the two preprint collections use source-restricted Europe PMC searches. Google Scholar can block automated requests. `year` accepts `YYYY`, `YYYY-YYYY`, or `YYYY-`; `limit` is 1–20 (default 10) after deduplication.

`papers` contains `{reference, title, authors, year?, abstract?, sources}`. Identical identifiers merge, similar titles do not. `failures` distinguishes a partial search from zero matches. If all selected indexes fail, the tool returns an error.

### `paper_read`

```js
const page = await paper_read({ reference: "https://arxiv.org/abs/2004.12832v1" })
if (page.next_cursor) {
  await paper_read({ reference: page.reference, cursor: page.next_cursor })
}
```

Pass a search hit's reference unchanged, a DOI, or a DOI/arXiv/PubMed/PMC/bioRxiv/medRxiv/Semantic Scholar paper URL. `reference`, `title`, and `source_url` identify the paper and evidence. `access` is `full_text`, `abstract_only`, or `metadata_only`; `markdown` is absent for metadata-only records. Network failures are errors, not evidence that a paper is paywalled.

The reader extracts identifiable public article bodies or PDFs, not arbitrary landing-page text. PDF extraction needs Poppler's `pdftotext` on the server's `PATH`. No PDF is saved. Full text over 16,000 UTF-16 code units is paged from a bounded, process-local snapshot. Reusing a cursor returns the same text without another fetch. After eviction or a server restart, start again without a cursor.

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MORPH_API_KEY` | For `code_search`, unless a Morph profile is configured | Morph CLI authentication |
| `CONTEXT7_API_KEY` | No | Higher rate limits for `fetch_docs` (optional) |
| `LOG_LEVEL` | No | `debug`, `info`, or `error` (default: `info`) |

### Token Efficiency

This server is optimized to minimize context usage:

| Tool | Typical Usage | Maximum |
|------|---------------|---------|
| `fetch_docs` with `depth="low"` | ~5k tokens | 10k |
| `fetch_docs` with `depth="medium"` | ~15k tokens | 30k |
| `fetch_docs` with `depth="high"` | ~50k tokens | 100k |

## Troubleshooting

### fetch_docs: "Library not found"
- Try variations of the name (e.g., "tf" vs "tensorflow")
- Use `browse_index: true` to see available libraries
- Check if you need a specific version

### MCP client doesn't show tools
- Run `npm run build` to compile TypeScript
- Check MCP config JSON is valid
- Review client logs (e.g., `~/Library/Logs/Claude/mcp*.log`)
- Test the compiled server and its MCP contract with `npm test`

## Development

### Local Development
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run development mode (auto-reload)
npm run dev

# Run tests
npm test
```

### Quick Test
```bash
npm run build
npm start
```

### Project Structure

`src/index.ts` registers the tools and starts the stdio server. To change what an agent sees, open the tool file. For retrieval, look under `src/sources/` by subject: `code/` for repositories, `docs/` for library documentation, and `papers/` for scholarly work.

| Tool | Description, arguments, and response | Source (under `src/sources/`) |
| --- | --- | --- |
| `code_search` | `src/tools/codeSearch.ts` | `code/morph.ts` (local search and GitHub checkouts) |
| `code_wiki` | `src/tools/codeWiki.ts` | `code/deepwiki.ts` |
| `fetch_docs` | `src/tools/fetchDocs.ts` | `docs/context7.ts` |
| `paper_search` | `src/tools/paperSearch.ts` | `papers/search.ts` |
| `paper_read` | `src/tools/paperRead.ts` (including bookmarks) | `papers/read.ts` |

Both paper tools use `src/sources/papers/` for provider schemas, HTTP requests, and canonical paper references.

## License

MIT License – see [LICENSE](LICENSE)
