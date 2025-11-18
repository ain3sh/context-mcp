# Context Tools MCP Server

An MCP server providing intelligent documentation retrieval and semantic search for AI agents.

**What it does**: Fetches library documentation from Context7 with smart matching, and performs semantic search over your Gemini FileSearchStores with AI-generated answers and citations.

**What it doesn't do**: Index files or manage FileSearchStores. Indexing happens separately (e.g., via GitHub Actions or custom pipelines).

## Features

- 📚 **Fetch Docs**: Retrieve library documentation from Context7 with intelligent name matching
- 🔍 **Semantic Search**: Query Gemini FileSearchStores with natural language
- 🎯 **Smart Matching**: 2-tier algorithm (exact → fuzzy) finds libraries from partial names
- ⚡ **Efficient**: Store caching (5-min TTL), response limits (25k chars), token budgets
- 📊 **Dual Formats**: Markdown (human-readable) and JSON (programmatic)
- 🔧 **Configurable**: All constants adjustable via environment variables

---

## Architecture

```
Context7 API                    Gemini FileSearchStores (cloud)
     ↓                                      ↓
     └──────────── context-mcp server ──────┘
                         ↓
                       Claude
```

**Key points**:
- `fetch_docs` queries Context7's documentation index
- `ask_docs_agent` queries your Gemini FileSearchStores
- Server discovers Gemini stores dynamically on startup
- No local file indexing or management

---

## Quick Start

### Recommended: `npx`

```bash
npx -y @ain3sh/context-mcp
```

No cloning required. Always uses the latest version.

### From Source

```bash
git clone https://github.com/ain3sh/context-mcp.git
cd context-mcp
npm install
npm run build
npm start
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | For `ask_docs_agent` | Google Gemini API key ([get one](https://aistudio.google.com/apikey)) |
| `CONTEXT7_API_KEY` | No | Context7 API key for higher rate limits |
| `FETCH_DOCS_LOW_TOKENS` | No | Token count for "low" depth (default: `5000`) |
| `FETCH_DOCS_MEDIUM_TOKENS` | No | Token count for "medium" depth (default: `15000`) |
| `FETCH_DOCS_HIGH_TOKENS` | No | Token count for "high" depth (default: `50000`) |
| `FETCH_DOCS_SEMANTIC_FLOOR` | No | Minimum confidence for fuzzy matching (default: `60`) |
| `LOG_LEVEL` | No | `debug`, `info`, or `error` (default: `info`) |

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "context-tools": {
      "command": "npx",
      "args": ["-y", "@ain3sh/context-mcp"],
      "env": {
        "GEMINI_API_KEY": "your_gemini_api_key",
        "CONTEXT7_API_KEY": "optional_context7_key"
      }
    }
  }
}
```

### Claude Code (Project-Level)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "context-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ain3sh/context-mcp"],
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}",
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    }
  }
}
```

Then set:

```bash
export GEMINI_API_KEY=your_gemini_key
export CONTEXT7_API_KEY=your_context7_key  # optional
```

---

## Usage

### Tool 1: `fetch_docs`

Fetch library documentation from Context7 with smart matching.

**When to use**: You need API docs, code examples, or guides for a library/framework.

```ts
// Simple fetch
fetch_docs({
  target: "react"
})

// With topic filter
fetch_docs({
  target: "next.js",
  tag: "routing"
})

// Deep dive with more tokens
fetch_docs({
  target: "pytorch",
  depth: "high"
})

// Browse available libraries
fetch_docs({
  target: "mongo",
  browse_index: true
})
```

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `target` | string | **Yes** | - | Library name to search for<br>e.g. `"react"`, `"next.js"`, `"pytorch"` |
| `tag` | string | No | - | Topic filter to focus results<br>e.g. `"routing"`, `"hooks"`, `"authentication"` |
| `depth` | string | No | `"medium"` | Token budget: `"low"` (~5k), `"medium"` (~15k), `"high"` (~50k) |
| `version` | string | No | - | Specific version tag<br>e.g. `"v15.1.8"`, `"v14.3.0-canary.87"` |
| `browse_index` | boolean | No | `false` | Return list of matching libraries instead of fetching docs |

#### Response Format

```markdown
# Documentation: next.js

**Library:** /vercel/next.js
**Version:** v15.1.8
**Topic:** routing
**Tokens:** 14,832 / 15,000 requested

---

## App Router

The App Router uses a new file-system based router...

[Source](https://nextjs.org/docs/app/building-your-application/routing)

---
```

---

### Tool 2: `ask_docs_agent`

Semantic search over your Gemini FileSearchStores with AI-generated answers.

**When to use**: You have complex conceptual questions or need synthesized answers from multiple sources.

**Requires**: `GEMINI_API_KEY` environment variable.

```ts
// Simple search
ask_docs_agent({
  target: "openai",
  query: "How does function calling work?"
})

// With more results
ask_docs_agent({
  target: "unstructured",
  query: "PDF parsing options",
  top_k: 5
})

// Include source chunks for verification
ask_docs_agent({
  target: "modelcontextprotocol",
  query: "tool annotations",
  include_chunks: true
})
```

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | **Yes** | - | Natural language search query (5-500 chars) |
| `target` | string | **Yes** | - | Documentation store to search<br>e.g. `"openai"`, `"unstructured"` |
| `top_k` | number | No | `3` | Number of chunks to retrieve (1-20) |
| `include_chunks` | boolean | No | `false` | Include document excerpts in response |
| `format` | string | No | `"markdown"` | Response format: `"markdown"` or `"json"` |
| `metadata_filter` | string | No | - | Advanced filter using [List Filter syntax](https://google.aip.dev/160) |

#### Discovering Stores

Gemini FileSearchStores are exposed as MCP Resources. The server discovers them on startup via the Gemini API.

Store names come from the `displayName` field set when creating the FileSearchStore.

#### Response Format

**Default (`include_chunks=false`):**

```markdown
# Search Results: openai

**Query**: How does function calling work?

**Response**:
Function calling allows you to describe functions to the model...

---

**Sources** (3 files):
  - function-calling-guide.md
  - api-reference.md
  - examples/tools.md
```

**With chunks (`include_chunks=true`):**

```markdown
[... same as above, plus ...]

---

## Retrieved Context Chunks

### [1] function-calling-guide.md

Function calling enables the model to generate structured outputs...
[truncated to 500 chars per chunk]

---
```

---

### Placeholder Tools

**`curate`**: Manage documentation collections. Implementation pending.

**`climb`**: Navigate documentation hierarchy. Implementation pending.

---

## Performance & Efficiency

### Token Budgets

| Mode | Tokens (approx.) | Contents |
|------|------------------|----------|
| `fetch_docs` (low) | ~5,000 | Concise API reference |
| `fetch_docs` (medium) | ~15,000 | Standard documentation |
| `fetch_docs` (high) | ~50,000 | Deep dive with examples |
| `ask_docs_agent` (default) | ~500-1,000 | Answer + citations |
| `ask_docs_agent` (with chunks) | ~2,000-3,000 | Answer + chunk previews |

### Safeguards

- **Response limit**: 25,000 characters (truncated with warning)
- **Chunk previews**: 500 characters max per chunk
- **Store caching**: 5-minute TTL reduces Gemini API calls
- **Smart matching**: Finds libraries without exact name matches

---

## Development

### Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode (auto-reload)
npm run dev

# Run with API keys
GEMINI_API_KEY=your_key npm start
```

### Project Structure

```text
context-mcp/
├── src/
│   └── index.ts            # Main MCP server implementation
├── dist/
│   └── index.js            # Compiled output
├── package.json            # Includes bin field for CLI
├── tsconfig.json
└── README.md
```

### Quick Local Test

```bash
npm run build
timeout 5s GEMINI_API_KEY=your_key npx .
```

MCP servers are long-lived; real testing is best via an MCP client (Claude Desktop, Claude Code, etc.).

---

## Troubleshooting

### Store Not Found (`ask_docs_agent`)

**Error**: `Documentation target 'xyz' not found`

**Check**:
- Store exists in Gemini ([Google AI Studio](https://aistudio.google.com/))
- Store has files uploaded
- Store's `displayName` matches your query
- Restart the MCP server (store list is cached at startup)

### Library Not Found (`fetch_docs`)

**Error**: `No match found` or `No results`

**Try**:
- Check spelling of library name
- Use official name (e.g., `"Next.js"` not `"nextjs"`)
- Use `browse_index: true` to see available matches
- Try partial name (e.g., `"mongo"` for MongoDB)

### API Key Problems

**Symptoms**: `UNAUTHENTICATED`, `Invalid API key`, `401`

**Check**:
- Environment variable is set correctly
- Key works at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- File Search API access is enabled (for Gemini)
- Quota not exceeded

### No Results (`ask_docs_agent`)

**Symptoms**: `No results found`

**Try**:
- Broader or more precise query wording
- Confirm files exist in the store
- Use terms closer to the docs' wording
- Ensure files use supported formats (Markdown, text, PDF)

### Rate Limits

**Error**: `429`, `RESOURCE_EXHAUSTED`

**For Gemini**:
- Free tier: ~15 RPM
- Wait 60 seconds before retrying

**For Context7**:
- Set `CONTEXT7_API_KEY` for higher limits
- Reduce query frequency

### Server Not Loading in Client

**Symptoms**: MCP client doesn't show `context-tools`

**Check**:
- `npm run build` completes without errors
- MCP config JSON is valid (use a JSON validator)
- Client logs (e.g., `~/Library/Logs/Claude/mcp*.log`)
- Manual run works:

  ```bash
  GEMINI_API_KEY=key npx -y @ain3sh/context-mcp
  ```

---

## License

MIT
