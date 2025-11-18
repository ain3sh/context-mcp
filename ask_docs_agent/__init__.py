"""
Ask Docs Agent - Semantic Documentation Search

Public API for searching documentation using Gemini File Search.
Provides a clean interface that hides implementation details.
"""

from typing import Literal, Optional
from .client import GeminiSearchClient, StoreNotFoundError
from .types import SearchParams

__all__ = ['search_documentation', 'StoreNotFoundError']


async def search_documentation(
    api_key: str,
    target: str,
    query: str,
    include_chunks: bool = False,
    top_k: int = 3,
    response_format: Literal["markdown", "json"] = "markdown",
    metadata_filter: Optional[str] = None
) -> str:
    """
    Perform semantic search over documentation using Gemini File Search.
    
    This is the main entry point for the ask-docs-agent module. It handles
    all the complexity of client initialization, caching, API calls, and
    response formatting.
    
    Args:
        api_key: Gemini API key for authentication
        target: Documentation target to search (e.g., "unstructured", "modelcontextprotocol")
        query: Natural language search query
        include_chunks: Whether to include document excerpts in response
        top_k: Number of document chunks to retrieve (1-20)
        response_format: Output format - "markdown" or "json"
        metadata_filter: Optional filter using List Filter syntax
        
    Returns:
        Formatted search results as markdown or JSON string
        
    Raises:
        StoreNotFoundError: If the requested target doesn't exist
        Exception: For API errors or other issues
        
    Example:
        >>> result = await search_documentation(
        ...     api_key="your-api-key",
        ...     target="unstructured",
        ...     query="How does async/await work?",
        ...     response_format="markdown"
        ... )
        >>> print(result)
    """
    # Create client and search parameters
    client = GeminiSearchClient(api_key)
    
    params = SearchParams(
        target=target,
        query=query,
        include_chunks=include_chunks,
        top_k=top_k,
        response_format=response_format,
        metadata_filter=metadata_filter
    )
    
    # Execute search and return formatted results
    return await client.search(params)
