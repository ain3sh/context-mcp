"""
Fetch Docs - Single-call Context7 documentation retrieval.

Public API for fetching library documentation with smart matching.
Provides a one-shot interface that handles library resolution internally,
eliminating the need for two-step search-then-fetch workflows.
"""

from typing import Literal, Optional

from .client import Context7Client
from .matcher import LibraryMatcher
from .formatters import (
    format_documentation,
    format_search_results,
    format_no_match,
    format_no_results,
    format_api_error,
)
from .models import (
    FetchParams,
    Context7APIError,
    NoMatchFoundError,
)

__all__ = ['fetch_documentation', 'Context7APIError', 'NoMatchFoundError']


async def fetch_documentation(
    target: str,
    topic: Optional[str] = None,
    depth: Literal["low", "medium", "high"] = "medium",
    version: Optional[str] = None,
    unsure: bool = False,
    response_format: Literal["markdown", "json"] = "markdown",
    api_key: Optional[str] = None
) -> str:
    """
    Fetch library documentation from Context7 with smart matching.
    
    This is the main entry point for the fetch-docs module. It handles
    all the complexity of library matching, API calls, and response formatting.
    
    Args:
        target: Library name guess (e.g., "react", "next.js", "pytorch")
        topic: Optional focus area (e.g., "routing", "hooks", "authentication")
        depth: Token amount - "low" (5k), "medium" (15k), "high" (50k)
        version: Optional specific version tag (e.g., "v15.1.8")
        unsure: If True, return search results instead of fetching docs
        response_format: Output format - "markdown" or "json"
        api_key: Optional Context7 API key (higher rate limits, private libs)
        
    Returns:
        Formatted documentation or search results as string
        
    Example:
        >>> # Simple fetch
        >>> result = await fetch_documentation("react", topic="hooks")
        >>> print(result)
        
        >>> # Deep dive with specific version
        >>> result = await fetch_documentation(
        ...     "next.js",
        ...     topic="routing",
        ...     depth="high",
        ...     version="v15.1.8"
        ... )
        
        >>> # Unsure mode - just search
        >>> result = await fetch_documentation("mongo", unsure=True)
    """
    # Build params object
    params = FetchParams(
        target=target,
        topic=topic,
        depth=depth,
        version=version,
        unsure=unsure,
        response_format=response_format
    )
    
    # Initialize client
    client = Context7Client(api_key=api_key)
    
    try:
        # Step 1: Search for libraries
        libraries = await client.search(target)
        
        if not libraries:
            return format_no_results(target, response_format)
        
        # Step 2: If unsure, just return search results
        if unsure:
            return format_search_results(libraries, target, response_format)
        
        # Step 3: Smart match to find best library
        matcher = LibraryMatcher(libraries)
        match_result = matcher.find_best(target)
        
        if not match_result.library:
            return format_no_match(target, match_result.candidates, response_format)
        
        # Step 4: Fetch documentation
        docs = await client.get_context(
            library_id=match_result.library.id,
            topic=topic,
            tokens=params.tokens,
            version=version
        )
        
        # Step 5: Format and return
        return format_documentation(docs, params)
        
    except Context7APIError as e:
        return format_api_error(e.status_code, e.message, response_format)
