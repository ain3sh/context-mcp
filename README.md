# Context Tools MCP Server

Documentation tools for AI agents — fetch library docs, search semantically, scrape websites cleanly.

## Features

- 📚 **Library Docs** - Instant access to 1000+ libraries via Context7 API
- 🔍 **Semantic Search** - Natural language Q&A over documentation stores
- 🌐 **Web Scraping** - Clean markdown extraction from any website
- 💾 **Smart Caching** - Automatic deduplication and content organization
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
      "args": ["-y", "github:ain3sh/context-mcp"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
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
    "context-mcp": {
      "type": "stdio", 
      "command": "npx",
      "args": ["-y", "github:ain3sh/context-mcp"],
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    }
  }
}
```

## Tools Overview

| Tool | Purpose | Token Usage |
|------|---------|-------------|
| [`fetch_docs`](#fetch_docs) | Get library/framework documentation | ~5k-50k tokens |
| [`fetch_site`](#fetch_site) | Scrape webpage → clean markdown | ~2k-20k tokens |
| [`ask_docs_agent`](#ask_docs_agent) | Semantic Q&A over documentation | ~500-3k tokens |

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

### `fetch_site`

Extract clean, readable content from any website using Mozilla's Readability algorithm.

#### Usage Examples
```javascript
// Single page extraction
fetch_site({
  url: "https://arxiv.org/abs/2301.00234"
})

// Include images
fetch_site({
  url: "https://example.com/tutorial",
  images: true
})

// Batch fetch multiple URLs
fetch_site({
  url: [
    "https://site.com/page1",
    "https://site.com/page2",
    "https://site.com/page3"
  ]
})

// Force refresh cached content
fetch_site({
  url: "https://news.site/article",
  refresh: true
})
```

#### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string \| string[] | required | URL(s) to fetch (max 10 for batch) |
| `images` | boolean | `false` | Fetch and save images alongside content |
| `refresh` | boolean | `false` | Bypass cache and re-fetch |

#### Output Structure

Content is saved to disk and returned:
```text
./context/
└── understanding-react-hooks/   # Auto-named from page title
    ├── CONTENT.md               # Markdown with YAML frontmatter
    └── images/
        └── diagram.jpg
```

#### How It Works
```text
URL → Fetch → JSDOM → Readability → Turndown → Clean Markdown
```

Uses the same extraction algorithm as Firefox Reader View to remove ads, navigation, and clutter.

---

### `ask_docs_agent`

AI-powered semantic search over documentation stores using Gemini File Search.

**Requires**: `GEMINI_API_KEY` environment variable ([get one here](https://aistudio.google.com/apikey))

#### Usage Examples
```javascript
// Simple question
ask_docs_agent({
  target: "context",
  query: "How does chunking work in File Search?"
})

// Include source chunks for verification
ask_docs_agent({
  target: "my-docs",
  query: "authentication setup",
  include_chunks: true,
  top_k: 5
})

// Get structured JSON response
ask_docs_agent({
  target: "api-docs",
  query: "rate limits",
  format: "json"
})
```

#### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Natural language question (5-500 chars) |
| `target` | string | required | Documentation store name |
| `top_k` | int | `3` | Number of relevant chunks to retrieve (1-20) |
| `include_chunks` | boolean | `false` | Include chunk previews in response |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Response format |
| `metadata_filter` | string | - | Advanced: List Filter syntax for file filtering |

#### Response Examples

**Default (markdown, no chunks)**: ~500-1000 tokens
```markdown
# Search Results: context

**Query**: How does chunking work?

**Response**:
Files are automatically chunked when imported into a file search store...

---

**Sources** (2 files):
  - ai.google.dev_gemini-api_docs_file-search.md
  - technical_spec.md
```

**With chunks**: ~2000-3000 tokens
```markdown
[... same as above, plus ...]

---

## Retrieved Context Chunks

### [1] ai.google.dev_gemini-api_docs_file-search.md

Files are automatically chunked when imported...
[truncated to 500 chars]
```

#### How It Works
```text
Query → Gemini File Search API → Semantic retrieval → LLM synthesis → Cited response
```

Queries pre-indexed Gemini FileSearchStores in the cloud. The stores must be created separately (e.g., via GitHub Actions workflow).

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | For `ask_docs_agent` | Your Gemini API key for semantic search |
| `CONTEXT7_API_KEY` | No | Higher rate limits for `fetch_docs` (optional) |
| `FETCH_SITE_CONTENT_DIR` | No | Content storage directory (default: `./context`) |
| `LOG_LEVEL` | No | `debug`, `info`, or `error` (default: `info`) |

### Token Efficiency

This server is optimized to minimize context usage:

| Tool | Typical Usage | Maximum |
|------|---------------|---------|
| `fetch_docs` with `depth="low"` | ~5k tokens | 10k |
| `fetch_docs` with `depth="medium"` | ~15k tokens | 30k |
| `fetch_docs` with `depth="high"` | ~50k tokens | 100k |
| `fetch_site` (single page) | ~2-5k tokens | 20k |
| `ask_docs_agent` (default) | ~500-1k tokens | 2k |
| `ask_docs_agent` with chunks | ~2-3k tokens | 5k |

## Troubleshooting

### fetch_docs: "Library not found"
- Try variations of the name (e.g., "tf" vs "tensorflow")
- Use `browse_index: true` to see available libraries
- Check if you need a specific version

### fetch_site: "Failed to extract content"
- Some sites block automated access
- Try `refresh: true` to bypass cache
- Check if the site requires authentication

### ask_docs_agent: "Store not found"
- Verify the store name matches exactly
- Ensure the store exists in your Gemini account
- Check that `GEMINI_API_KEY` is set correctly

### ask_docs_agent: Rate limits
- Free tier: ~15 queries per minute
- Wait 60 seconds between bursts
- Consider upgrading Gemini API tier if needed

### MCP client doesn't show tools
- Run `npm run build` to compile TypeScript
- Check MCP config JSON is valid
- Review client logs (e.g., `~/Library/Logs/Claude/mcp*.log`)
- Test manually: `GEMINI_API_KEY=key npx -y github:ain3sh/context-mcp`

## Development

### Local Development
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run development mode (auto-reload)
npm run dev

# Test with environment
GEMINI_API_KEY=your_key npm start
```

### Quick Test
```bash
npm run build
timeout 5s GEMINI_API_KEY=your_key npx .
```

### Project Structure
```text
context-mcp/
├── src/
│   └── index.ts         # MCP server implementation
├── dist/
│   └── index.js         # Compiled output
├── context/             # Cached content (git-ignored)
├── package.json
└── tsconfig.json
```

## License

MIT License – see [LICENSE](LICENSE)
