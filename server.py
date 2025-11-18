#!/usr/bin/env python3
"""
Context Tools MCP Server

An MCP server providing intelligent documentation management and search tools.
Enables AI agents to fetch, curate, navigate, and semantically search documentation.
"""

import logging
import os
from typing import Optional, Literal
from mcp.server import Server
from mcp.server.stdio import stdio_server
from pydantic import BaseModel, Field, ConfigDict

# Import ask-docs-agent module
try:
    from ask_docs_agent import search_documentation, StoreNotFoundError
except ImportError:
    # Fallback if module structure is different
    import sys
    sys.path.insert(0, os.path.dirname(__file__))
    from ask_docs_agent import search_documentation, StoreNotFoundError

# Import fetch_docs module
from fetch_docs import fetch_documentation

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("context-tools")

# Initialize MCP server
app = Server("context-tools")

# Constants
CHARACTER_LIMIT = 25000  # Maximum characters for tool responses
DEFAULT_PAGE_SIZE = 50   # Default pagination size


# ============================================================================
# Input Models (Pydantic v2)
# ============================================================================

class FetchDocsInput(BaseModel):
    """Input model for fetching documentation from Context7."""
    model_config = ConfigDict(extra="forbid")
    
    target: str = Field(
        ...,
        description="Library name to search for. Examples: 'react', 'next.js', 'pytorch', 'fastapi'",
        min_length=1,
        max_length=200
    )
    tag: Optional[str] = Field(
        default=None,
        description="Tag to filter/rerank results within the library. Examples: 'routing', 'hooks', 'authentication'",
        max_length=200
    )
    depth: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Token amount: 'low' (~5k tokens), 'medium' (~15k), 'high' (~50k for deep dives)"
    )
    version: Optional[str] = Field(
        default=None,
        description="Specific version tag. Examples: 'v15.1.8', 'v14.3.0-canary.87'",
        max_length=50
    )
    browse_index: bool = Field(
        default=False,
        description="If true, returns list of matching libraries instead of fetching docs. Use to discover available libraries."
    )


class CurateInput(BaseModel):
    """Input model for curating/organizing documentation collections."""
    model_config = ConfigDict(extra="forbid")
    
    action: Literal["list", "add", "remove", "organize"] = Field(
        ...,
        description="Action to perform: 'list' collections, 'add' new source, 'remove' source, 'organize' structure"
    )
    collection_name: Optional[str] = Field(
        default=None,
        description="Name of the documentation collection. Examples: 'python-stdlib', 'react-docs', 'company-internal'",
        max_length=100
    )
    source: Optional[str] = Field(
        default=None,
        description="Source URL or path to add to collection",
        max_length=2000
    )
    format: Literal["markdown", "json"] = Field(
        default="markdown",
        description="Response format: 'markdown' for human-readable or 'json' for structured data"
    )


class ClimbInput(BaseModel):
    """Input model for navigating documentation hierarchy."""
    model_config = ConfigDict(extra="forbid")
    
    collection: str = Field(
        ...,
        description="Name of the documentation collection to navigate. Examples: 'python-stdlib', 'react-docs'",
        min_length=1,
        max_length=100
    )
    path: Optional[str] = Field(
        default="/",
        description="Path within documentation hierarchy. Examples: '/', '/api/reference', '/guides/getting-started'",
        max_length=500
    )
    action: Literal["list", "info", "navigate"] = Field(
        default="list",
        description="Action: 'list' entries at path, 'info' about path, 'navigate' to related content"
    )
    format: Literal["markdown", "json"] = Field(
        default="markdown",
        description="Response format: 'markdown' for human-readable or 'json' for structured data"
    )


class AskDocsInput(BaseModel):
    """Input model for semantic documentation search."""
    model_config = ConfigDict(extra="forbid")
    
    query: str = Field(
        ...,
        description="Natural language search query. Examples: 'How does async/await work in Python?', 'React hooks best practices'",
        min_length=5,
        max_length=500
    )
    target: str = Field(
        ...,
        description="Documentation target to search. Examples: 'unstructured', 'modelcontextprotocol', 'openai'",
        min_length=1,
        max_length=100
    )
    top_k: int = Field(
        default=3,
        description="Number of relevant results to return (1-20)",
        ge=1,
        le=20
    )
    include_chunks: bool = Field(
        default=False,
        description="Include document excerpts in response. False returns synthesized answer only"
    )
    format: Literal["markdown", "json"] = Field(
        default="markdown",
        description="Response format: 'markdown' for human-readable or 'json' for structured data"
    )
    metadata_filter: Optional[str] = Field(
        default=None,
        description="Optional metadata filter using List Filter syntax (google.aip.dev/160)",
        max_length=500
    )


# ============================================================================
# Shared Utilities
# ============================================================================

def truncate_response(content: str, limit: int = CHARACTER_LIMIT) -> str:
    """
    Truncate response content if it exceeds character limit.
    
    Args:
        content: The content to potentially truncate
        limit: Maximum character limit
        
    Returns:
        Truncated content with informative message if truncated
    """
    if len(content) <= limit:
        return content
    
    truncated = content[:limit]
    return f"{truncated}\n\n[... Content truncated at {limit} characters. Use more specific queries or pagination to see more ...]"


def format_error(error: Exception, context: str) -> str:
    """
    Format error message for LLM consumption with actionable guidance.
    
    Args:
        error: The exception that occurred
        context: Context about what operation failed
        
    Returns:
        Human-readable error message with suggested next steps
    """
    # Handle StoreNotFoundError specially
    if isinstance(error, StoreNotFoundError):
        error_msg = f"Error: Store '{error.store}' not found.\n\n"
        error_msg += "Available stores:\n"
        error_msg += "\n".join(f"  - {s}" for s in sorted(error.available))
        error_msg += "\n\nSuggestion: Use one of the available store names listed above."
        return error_msg
    
    error_msg = f"Error during {context}: {str(error)}"
    
    # Add actionable suggestions based on error type
    if "not found" in str(error).lower():
        error_msg += "\n\nSuggestion: Try listing available collections first with curate(action='list')"
    elif "connection" in str(error).lower() or "timeout" in str(error).lower():
        error_msg += "\n\nSuggestion: Check the URL is accessible and try again"
    elif "permission" in str(error).lower() or "api key" in str(error).lower():
        error_msg += "\n\nSuggestion: Verify GEMINI_API_KEY environment variable is set correctly"
    
    return error_msg


# ============================================================================
# Tool Implementations
# ============================================================================

@app.tool(
    name="fetch_docs",
    description="""
    Fetch library documentation from Context7 with smart matching.
    
    This tool retrieves documentation for libraries/frameworks with intelligent
    library name matching. It eliminates the need for two-step search-then-fetch
    workflows - just provide your best guess for the library name.
    
    **Matching Algorithm:**
    Uses 2-tier matching (exact → fuzzy) to find the right library,
    so "react", "React", or "mongodb" → "/mongodb/docs" all match correctly.
    
    **Use this tool when you need:**
    - API documentation for a library (e.g., "next.js", "fastapi")
    - Framework guides and tutorials
    - Code examples and best practices
    
    **Parameters:**
    - `target`: Library name guess (required)
    - `tag`: Filter results by tag like "routing" or "hooks" (optional)
    - `depth`: Token budget - "low" (5k), "medium" (15k), "high" (50k)
    - `version`: Specific version tag like "v15.1.8" (optional)
    - `browse_index`: Set true to list matching libraries instead of fetching docs
    
    **Examples:**
    - Simple: `fetch_docs(target="react")`
    - With tag: `fetch_docs(target="next.js", tag="routing")`
    - Deep dive: `fetch_docs(target="pytorch", depth="high")`
    - Browse: `fetch_docs(target="mongo", browse_index=true)`
    
    **Environment Variables:**
    - `CONTEXT7_API_KEY`: Optional, for higher rate limits and private libraries
    """,
    annotations={
        "readOnlyHint": True,
        "openWorldHint": True
    }
)
async def fetch_docs(input_data: FetchDocsInput) -> str:
    """
    Fetch library documentation from Context7.
    
    Args:
        input_data: FetchDocsInput with target, tag, depth, version, browse_index
        
    Returns:
        Fetched documentation or search results
    """
    try:
        result = await fetch_documentation(
            target=input_data.target,
            topic=input_data.tag,  # API calls it topic, we expose as tag
            depth=input_data.depth,
            version=input_data.version,
            unsure=input_data.browse_index,  # API calls it unsure, we expose as browse_index
            response_format="markdown"  # Always markdown
        )
        return result
        
    except Exception as e:
        error_msg = format_error(e, "fetching documentation")
        logger.error(error_msg)
        return error_msg


@app.tool(
    name="curate",
    description="""
    Manage and organize documentation collections.
    
    This tool helps organize fetched documentation into named collections,
    add or remove sources, and maintain documentation structure.
    
    Use this tool when you need to:
    - List available documentation collections
    - Add new documentation sources to a collection
    - Remove outdated documentation
    - Reorganize documentation structure
    
    Returns collection information or operation status.
    """,
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False
    }
)
async def curate(input_data: CurateInput) -> str:
    """
    Curate and organize documentation collections.
    
    Args:
        input_data: CurateInput with action, collection_name, source, and format
        
    Returns:
        Collection information or operation result
    """
    try:
        # TODO: Implement actual curation logic
        result = {
            "status": "success",
            "action": input_data.action,
            "collection": input_data.collection_name,
            "message": f"Would perform '{input_data.action}' on collection '{input_data.collection_name}'"
        }
        
        if input_data.format == "json":
            import json
            return json.dumps(result, indent=2)
        else:
            return f"""# Collection Management

**Action:** {input_data.action}
**Collection:** {input_data.collection_name or 'All'}
**Status:** Success

This is a placeholder. Implementation pending.
"""
    except Exception as e:
        error_msg = format_error(e, "curating documentation")
        logger.error(error_msg)
        return error_msg


@app.tool(
    name="climb",
    description="""
    Navigate through documentation hierarchy and structure.
    
    This tool enables traversal of documentation organization, allowing you to
    explore structure, discover related content, and understand documentation layout.
    
    Use this tool when you need to:
    - Explore documentation structure
    - List available sections or pages
    - Get information about a documentation path
    - Navigate to related documentation
    
    Returns documentation structure information or navigation results.
    """,
    annotations={
        "readOnlyHint": True
    }
)
async def climb(input_data: ClimbInput) -> str:
    """
    Navigate documentation hierarchy.
    
    Args:
        input_data: ClimbInput with collection, path, action, and format
        
    Returns:
        Documentation hierarchy information
    """
    try:
        # TODO: Implement actual navigation logic
        result = {
            "status": "success",
            "collection": input_data.collection,
            "path": input_data.path,
            "action": input_data.action,
            "message": f"Would navigate '{input_data.collection}' at '{input_data.path}'"
        }
        
        if input_data.format == "json":
            import json
            return json.dumps(result, indent=2)
        else:
            return f"""# Documentation Navigation

**Collection:** {input_data.collection}
**Path:** {input_data.path}
**Action:** {input_data.action}
**Status:** Success

This is a placeholder. Implementation pending.
"""
    except Exception as e:
        error_msg = format_error(e, "navigating documentation")
        logger.error(error_msg)
        return error_msg


@app.tool(
    name="ask_docs_agent",
    description="""
    Perform semantic search across documentation using AI-powered understanding.
    
    This tool uses natural language understanding to find relevant documentation
    based on conceptual queries, not just keyword matching. It can synthesize
    answers from multiple sources and provide citations.
    
    Use this tool when you need to:
    - Ask complex conceptual questions about documentation
    - Find documentation by describing what you're trying to do
    - Get synthesized answers from multiple sources
    - Understand "how" and "why" questions about documented topics
    
    Returns either a synthesized answer with citations, or includes document
    excerpts if include_chunks is True.
    
    **Important:** Requires GEMINI_API_KEY environment variable to be set.
    """,
    annotations={
        "readOnlyHint": True,
        "openWorldHint": True
    }
)
async def ask_docs_agent_tool(input_data: AskDocsInput) -> str:
    """
    Semantic search and Q&A over documentation using Gemini File Search.
    
    Args:
        input_data: AskDocsInput with query, target, top_k, include_chunks, format, and metadata_filter
        
    Returns:
        AI-generated answer with citations or document excerpts
    """
    try:
        # Get API key from environment
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return (
                "Error: GEMINI_API_KEY environment variable is not set.\n\n"
                "Please set your Gemini API key:\n"
                "  export GEMINI_API_KEY='your-api-key-here'\n\n"
                "Get an API key from: https://aistudio.google.com/apikey"
            )
        
        # Call the search_documentation function from ask-docs-agent module
        result = await search_documentation(
            api_key=api_key,
            target=input_data.target,
            query=input_data.query,
            include_chunks=input_data.include_chunks,
            top_k=input_data.top_k,
            response_format=input_data.format,
            metadata_filter=input_data.metadata_filter
        )
        
        return result
        
    except Exception as e:
        error_msg = format_error(e, "searching documentation")
        logger.error(error_msg)
        return error_msg


# ============================================================================
# Server Entry Point
# ============================================================================

async def main():
    """Run the MCP server using stdio transport."""
    logger.info("Starting Context Tools MCP Server")
    
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
