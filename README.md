# Context Tools MCP Server

An MCP server providing intelligent documentation management and search tools for AI agents. Built in TypeScript for easy installation with `npx`.

## Installation

### Using npx (recommended)

```bash
npx -y @ain3sh/context-mcp
```

### Global installation

```bash
npm install -g @ain3sh/context-mcp
context-mcp
```

### From source

```bash
git clone https://github.com/ain3sh/context-mcp.git
cd context-mcp
npm install
npm run build
npm start
```

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "context-tools": {
      "command": "npx",
      "args": ["-y", "@ain3sh/context-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here",
        "CONTEXT7_API_KEY": "optional-for-higher-rate-limits"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes (for ask_docs_agent) | Google Gemini API key for semantic search |
| `CONTEXT7_API_KEY` | No | Context7 API key for higher rate limits |
| `FETCH_DOCS_LOW_TOKENS` | No | Custom token count for "low" depth (default: 5000) |
| `FETCH_DOCS_MEDIUM_TOKENS` | No | Custom token count for "medium" depth (default: 15000) |
| `FETCH_DOCS_HIGH_TOKENS` | No | Custom token count for "high" depth (default: 50000) |
| `FETCH_DOCS_SEMANTIC_FLOOR` | No | Minimum confidence for fuzzy matching (default: 60) |
| `LOG_LEVEL` | No | Logging level: "debug", "info", "error" (default: "info") |

---

## Tools

### `fetch_docs`

Fetch library documentation from Context7 with smart matching.

**When to use:** You need API docs, code examples, or guides for a library/framework.

**Matching Algorithm:** Uses 2-tier matching (exact → fuzzy) to find the right library, so "react", "React", or "mongodb" all match correctly.

#### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | string | **Yes** | - | Library name to search for. Examples: `"react"`, `"next.js"`, `"pytorch"` |
| `tag` | string | No | None | Tag to filter/rerank results. Examples: `"routing"`, `"hooks"`, `"authentication"` |
| `depth` | `"low"` \| `"medium"` \| `"high"` | No | `"medium"` | Token budget: low (~5k), medium (~15k), high (~50k) |
| `version` | string | No | None | Specific version tag. Examples: `"v15.1.8"`, `"v14.3.0-canary.87"` |
| `browse_index` | boolean | No | `false` | If true, returns list of matching libraries instead of docs |

#### Examples

```javascript
// Simple fetch
fetch_docs({ target: "react" })

// With tag filter
fetch_docs({ target: "next.js", tag: "routing" })

// Deep dive
fetch_docs({ target: "pytorch", depth: "high" })

// Specific version
fetch_docs({ target: "next.js", version: "v15.1.8" })

// Browse available libraries
fetch_docs({ target: "mongo", browse_index: true })
```

---

### `ask_docs_agent`

Semantic search across your documentation using AI-powered understanding.

**When to use:** You have complex conceptual questions about documented topics, or need synthesized answers from multiple sources.

**Requires:** `GEMINI_API_KEY` environment variable.

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

```javascript
// Simple search
ask_docs_agent({ target: "openai", query: "How does function calling work?" })

// With more results
ask_docs_agent({ target: "unstructured", query: "PDF parsing options", top_k: 5 })

// Include source excerpts
ask_docs_agent({ target: "modelcontextprotocol", query: "tool annotations", include_chunks: true })
```

---

### `curate` (Placeholder)

Manage and organize documentation collections. Implementation pending.

### `climb` (Placeholder)

Navigate through documentation hierarchy and structure. Implementation pending.

---

## Features

- **Smart Library Matching**: 2-tier matching algorithm (exact → fuzzy) finds the right library from partial names
- **Store Caching**: 5-minute TTL cache for Gemini File Search stores reduces API calls
- **Response Limits**: Automatic truncation at 25k characters prevents context overflow
- **Environment-Driven Configuration**: All constants configurable via environment variables
- **User-Friendly Errors**: Detailed error messages with troubleshooting suggestions

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Clean build artifacts
npm run clean
```

## License

MIT
