"""
Response formatting for fetch-docs results.

Converts API responses and match results into markdown or JSON
for MCP client consumption.
"""

import json
from typing import List

from .models import (
    FetchParams,
    LibraryInfo,
    DocumentationResult,
    MatchResult,
    CHARACTER_LIMIT,
)


def format_documentation(
    result: DocumentationResult,
    params: FetchParams
) -> str:
    """
    Format successful documentation fetch as markdown or JSON.
    
    Args:
        result: Documentation result from Context7
        params: Original fetch parameters
        
    Returns:
        Formatted string in requested format
    """
    if params.response_format == "json":
        return _format_docs_json(result, params)
    return _format_docs_markdown(result, params)


def format_search_results(
    libraries: List[LibraryInfo],
    query: str,
    response_format: str = "markdown"
) -> str:
    """
    Format search results for unsure mode.
    
    Args:
        libraries: List of matching libraries
        query: Original search query
        response_format: "markdown" or "json"
        
    Returns:
        Formatted search results
    """
    if response_format == "json":
        return _format_search_json(libraries, query)
    return _format_search_markdown(libraries, query)


def format_no_match(
    target: str,
    candidates: List[tuple],
    response_format: str = "markdown"
) -> str:
    """
    Format error when no confident match is found.
    
    Args:
        target: Original search target
        candidates: List of (LibraryInfo, score) tuples
        response_format: "markdown" or "json"
        
    Returns:
        Formatted error with suggestions
    """
    if response_format == "json":
        return _format_no_match_json(target, candidates)
    return _format_no_match_markdown(target, candidates)


def format_no_results(target: str, response_format: str = "markdown") -> str:
    """
    Format error when search returns no results.
    
    Args:
        target: Original search target
        response_format: "markdown" or "json"
        
    Returns:
        Formatted error message
    """
    if response_format == "json":
        return json.dumps({
            "error": "no_results",
            "target": target,
            "message": f"No libraries found matching '{target}'",
            "suggestion": "Try a different search term or check spelling"
        }, indent=2)
    
    return f"""# No Results Found

**Target:** "{target}"

No libraries found matching this search term.

**Suggestions:**
- Check the spelling of the library name
- Try the official name (e.g., "Next.js" instead of "nextjs")
- Use `fetch_docs(target="{target}", unsure=true)` to see partial matches
"""


def format_api_error(
    status_code: int,
    message: str,
    response_format: str = "markdown"
) -> str:
    """
    Format Context7 API error.
    
    Args:
        status_code: HTTP status code
        message: Error message
        response_format: "markdown" or "json"
        
    Returns:
        Formatted error message
    """
    if response_format == "json":
        return json.dumps({
            "error": "api_error",
            "status_code": status_code,
            "message": message
        }, indent=2)
    
    suggestions = []
    if status_code == 401:
        suggestions.append("Check your CONTEXT7_API_KEY if using authentication")
    elif status_code == 404:
        suggestions.append("The library may not exist in Context7's index")
        suggestions.append("Try searching with `unsure=true` to see available libraries")
    elif status_code == 429:
        suggestions.append("You've hit the rate limit - wait a moment and try again")
        suggestions.append("Set CONTEXT7_API_KEY for higher rate limits")
    
    suggestion_text = "\n".join(f"- {s}" for s in suggestions) if suggestions else "- Try again later"
    
    return f"""# API Error

**Status:** {status_code}
**Message:** {message}

**Suggestions:**
{suggestion_text}
"""


# ============================================================================
# Private Formatting Functions
# ============================================================================

def _format_docs_markdown(result: DocumentationResult, params: FetchParams) -> str:
    """Format documentation as markdown."""
    output = []
    
    # Header with metadata
    lib_name = result.library_id.split("/")[-1] if "/" in result.library_id else result.library_id
    output.append(f"# Documentation: {lib_name}\n")
    output.append(f"**Library:** {result.library_id}\n")
    output.append(f"**Version:** {result.version}\n")
    
    if result.topic:
        output.append(f"**Topic:** {result.topic}\n")
    
    output.append(f"**Tokens:** {result.tokens:,} / {params.tokens:,} requested\n")
    output.append("\n---\n\n")
    
    # Documentation chunks
    for chunk in result.chunks:
        if chunk.title:
            output.append(f"## {chunk.title}\n\n")
        
        output.append(f"{chunk.content}\n\n")
        
        if chunk.url:
            source_text = chunk.source if chunk.source else "Source"
            output.append(f"[{source_text}]({chunk.url})\n\n")
        
        output.append("---\n\n")
    
    response = "".join(output)
    return _truncate_if_needed(response)


def _format_docs_json(result: DocumentationResult, params: FetchParams) -> str:
    """Format documentation as JSON."""
    data = {
        "library": result.library_id,
        "version": result.version,
        "topic": result.topic,
        "tokens_used": result.tokens,
        "tokens_requested": params.tokens,
        "chunks": [
            {
                "title": chunk.title,
                "content": chunk.content,
                "source": chunk.source,
                "url": chunk.url
            }
            for chunk in result.chunks
        ]
    }
    return json.dumps(data, indent=2)


def _format_search_markdown(libraries: List[LibraryInfo], query: str) -> str:
    """Format search results as markdown table."""
    output = []
    output.append("# Library Search Results\n\n")
    output.append(f"**Query:** \"{query}\"\n\n")
    output.append(f"Found {len(libraries)} matching libraries:\n\n")
    
    # Table header
    output.append("| Library | Stars | Quality | Tokens | Description |\n")
    output.append("|---------|-------|---------|--------|-------------|\n")
    
    for lib in libraries[:15]:  # Limit to top 15
        stars = _format_number(lib.stars)
        quality = f"{lib.benchmark_score:.1f}" if lib.benchmark_score else "N/A"
        tokens = _format_number(lib.total_tokens)
        desc = lib.description[:50] + "..." if len(lib.description) > 50 else lib.description
        
        output.append(f"| {lib.id} | {stars} | {quality} | {tokens} | {desc} |\n")
    
    if len(libraries) > 15:
        output.append(f"\n*...and {len(libraries) - 15} more results*\n")
    
    output.append(f"\n**To fetch:** Use `fetch_docs(target=\"{libraries[0].id if libraries else '/owner/repo'}\")`\n")
    
    return "".join(output)


def _format_search_json(libraries: List[LibraryInfo], query: str) -> str:
    """Format search results as JSON."""
    data = {
        "query": query,
        "count": len(libraries),
        "libraries": [
            {
                "id": lib.id,
                "title": lib.title,
                "description": lib.description,
                "stars": lib.stars,
                "total_tokens": lib.total_tokens,
                "benchmark_score": lib.benchmark_score,
                "versions": lib.versions[:5] if lib.versions else []
            }
            for lib in libraries[:20]  # Limit to top 20
        ]
    }
    return json.dumps(data, indent=2)


def _format_no_match_markdown(target: str, candidates: List[tuple]) -> str:
    """Format no match error as markdown."""
    output = []
    output.append("# No Match Found\n\n")
    output.append(f"**Target:** \"{target}\"\n\n")
    output.append("No library found with sufficient confidence.\n\n")
    
    if candidates:
        output.append("**Did you mean?**\n")
        for lib, score in candidates[:5]:
            output.append(f"  - {lib.id} (score: {score:.1f})\n")
        output.append("\n")
    
    output.append(f"**Tip:** Try `fetch_docs(target=\"{target}\", unsure=true)` to see all search results.\n")
    
    return "".join(output)


def _format_no_match_json(target: str, candidates: List[tuple]) -> str:
    """Format no match error as JSON."""
    data = {
        "error": "no_confident_match",
        "target": target,
        "message": "No library found with sufficient confidence",
        "candidates": [
            {"id": lib.id, "title": lib.title, "score": score}
            for lib, score in candidates[:5]
        ],
        "suggestion": f"Try fetch_docs(target=\"{target}\", unsure=true) to see all results"
    }
    return json.dumps(data, indent=2)


def _format_number(n: int) -> str:
    """Format large numbers with K/M suffix."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _truncate_if_needed(content: str) -> str:
    """Truncate content if it exceeds character limit."""
    if len(content) <= CHARACTER_LIMIT:
        return content
    
    truncated = content[:CHARACTER_LIMIT]
    return (
        f"{truncated}\n\n"
        f"[TRUNCATED - Response exceeds {CHARACTER_LIMIT:,} characters. "
        f"Original length: {len(content):,}. "
        f"Try using a lower depth or adding a topic filter.]"
    )
