# Context Tools MCP Server

An MCP server providing intelligent documentation management and search tools for AI agents.

## Installation

```bash
pip install -r requirements.txt
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes (for ask_docs_agent) | Google Gemini API key for semantic search |
| `CONTEXT7_API_KEY` | No | Context7 API key for higher rate limits |
| `FETCH_DOCS_LOW_TOKENS` | No | Custom token count for "low" depth (default: 5000) |
| `FETCH_DOCS_MEDIUM_TOKENS` | No | Custom token count for "medium" depth (default: 15000) |
| `FETCH_DOCS_HIGH_TOKENS` | No | Custom token count for "high" depth (default: 50000) |

---

## Tools

### `fetch_docs`

Fetch library documentation from Context7 with smart matching.

**When to use:** You need API docs, code examples, or guides for a library/framework.

#### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | string | **Yes** | - | Library name to search for. Examples: `"react"`, `"next.js"`, `"pytorch"` |
| `tag` | string | No | None | Tag to filter/rerank results. Examples: `"routing"`, `"hooks"`, `"authentication"` |
| `depth` | `"low"` \| `"medium"` \| `"high"` | No | `"medium"` | Token budget: low (~5k), medium (~15k), high (~50k) |
| `version` | string | No | None | Specific version tag. Examples: `"v15.1.8"`, `"v14.3.0-canary.87"` |
| `browse_index` | boolean | No | `false` | If true, returns list of matching libraries instead of docs |

#### Examples

```python
# Simple fetch
fetch_docs(target="react")

# With tag filter
fetch_docs(target="next.js", tag="routing")

# Deep dive
fetch_docs(target="pytorch", depth="high")

# Specific version
fetch_docs(target="next.js", version="v15.1.8")

# Browse available libraries
fetch_docs(target="mongo", browse_index=true)
```

---

### `ask_docs_agent`

Semantic search across your documentation using AI-powered understanding.

**When to use:** You have complex conceptual questions about documented topics, or need synthesized answers from multiple sources.

#### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | **Yes** | - | Natural language search query (5-500 chars) |
| `target` | string | **Yes** | - | Documentation target to search. Examples: `"openai"`, `"unstructured"` |
| `top_k` | integer | No | `3` | Number of relevant results (1-20) |
| `include_chunks` | boolean | No | `false` | Include document excerpts in response |
| `format` | `"markdown"` \| `"json"` | No | `"markdown"` | Response format |
| `metadata_filter` | string | No | None | Filter using List Filter syntax |

#### Examples

```python
# Simple search
ask_docs_agent(target="openai", query="How does function calling work?")

# With more results
ask_docs_agent(target="unstructured", query="PDF parsing options", top_k=5)

# Include source excerpts
ask_docs_agent(target="modelcontextprotocol", query="tool annotations", include_chunks=true)
```

---

## Running the Server

```bash
python server.py
```

## Running Tests

```bash
# Test fetch_docs
python3 test_fetch_docs.py

# Test ask_docs_agent
python3 test_ask_docs_agent.py
```
