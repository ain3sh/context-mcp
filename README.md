# Context Tools MCP Server

Documentation tools for AI agents — fetch library docs, search semantically, scrape websites cleanly.

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript → dist/
npm run build

# Run MCP server over stdio
node dist/index.js
# or during development
npm run dev
```

## Tools

| Tool | What it does |
|------|--------------|
| [`fetch_docs`](#fetch_docs) | Get library/framework documentation from Context7 |
| [`fetch_site`](#fetch_site) | Scrape any webpage → clean markdown |
| [`ask_docs_agent`](#ask_docs_agent) | Semantic Q&A over your documentation |

---

### `fetch_docs`

Fetch library/framework docs from Context7 with smart name matching.

```python
async def fetch_docs(
    *,
    target: str,
    tag: Optional[str] = None,
    depth: Literal["low", "medium", "high"] = "medium",
    version: Optional[str] = None,
    browse_index: bool = False,
) -> str:
    ...
```

<details>
<summary>Parameters</summary>

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | string | required | Library or framework name guess (1–200 chars). |
| `tag` | string | - | Optional topic filter within that library (≤200 chars). |
| `depth` | `"low"` \| `"medium"` \| `"high"` | `"medium"` | Doc length preset: 'low'/'medium'/'high' (~5k/15k/50k tokens). |
| `version` | string | - | Optional version tag string (≤50 chars). |
| `browse_index` | boolean | `false` | If true, return matching libraries instead of docs. |

</details>

---

### `fetch_site`

Scrape websites and convert to clean markdown using Mozilla Readability.

```python
async def fetch_site(
    *,
    url: Union[str, List[str]],
    images: bool = False,
    refresh: bool = False,
) -> str:
    ...
```

Content saves to `./context/{title}/CONTENT.md` with YAML frontmatter.

<details>
<summary>Parameters</summary>

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string \| string[] | required | Single URL string or list of 1–10 URLs to fetch. |
| `images` | boolean | `false` | If true, fetch and store images alongside markdown. |
| `refresh` | boolean | `false` | If true, bypass cache and re-fetch from origin. |

</details>

---

### `ask_docs_agent`

AI-powered semantic search over documentation. Requires `GEMINI_API_KEY`.

```python
async def ask_docs_agent(
    *,
    query: str,
    target: str,
    top_k: int = 3,
    include_chunks: bool = False,
    format: Literal["markdown", "json"] = "markdown",
    metadata_filter: Optional[str] = None,
) -> str:
    ...
```

Typical calls only set `target`, `query`, and sometimes `top_k` or `include_chunks`; `format` and `metadata_filter` are advanced knobs.

<details>
<summary>Parameters</summary>

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Question to answer over this documentation (5–500 chars). |
| `target` | string | required | Docs store / target name to search (1–100 chars). |
| `top_k` | int | `3` | Number of relevant chunks to retrieve (1–20). |
| `include_chunks` | boolean | `false` | If true, include chunk previews; false returns answer + sources only. |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Response format; defaults to 'markdown'. Use 'json' only when you need structured parsing. |
| `metadata_filter` | string | - | Optional List Filter string to limit which files are searched; leave empty unless you know the store's metadata schema. |

</details>

---

## Configuration

<details>
<summary>Environment Variables</summary>

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | For `ask_docs_agent` | [Get one here](https://aistudio.google.com/apikey) |
| `CONTEXT7_API_KEY` | No | Higher rate limits for `fetch_docs` |
| `FETCH_SITE_CONTENT_DIR` | No | Storage directory (default: `./context`) |

</details>

## Testing

```bash
# Typecheck / compile the server
npm run build
```
