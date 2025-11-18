"""
Gemini File Search client with store caching.

Handles communication with the Gemini API, including:
- Store discovery and caching
- Semantic search execution
- Response formatting

Note: Google GenAI Python SDK is synchronous, so we wrap blocking calls
with asyncio.to_thread() to prevent blocking the event loop.
"""

import asyncio
import time
from typing import Dict, Optional
from google import genai
from google.genai import types

from .types import SearchParams
from .formatters import parse_grounding_metadata, format_markdown, format_json

# Constants
MODEL_NAME = "gemini-2.5-flash"
CACHE_TTL_SECONDS = 300  # 5 minutes


class StoreNotFoundError(Exception):
    """
    Raised when a requested store doesn't exist.
    
    Attributes:
        store: The requested store name
        available: List of available store names
    """
    def __init__(self, store: str, available: list[str]):
        self.store = store
        self.available = available
        super().__init__(f"Store '{store}' not found")


class GeminiSearchClient:
    """
    Client for semantic search over Gemini File Search stores.
    
    Manages store caching and provides high-level search interface.
    Cache is instance-specific and has a 5-minute TTL.
    """
    
    def __init__(self, api_key: str):
        """
        Initialize Gemini search client.
        
        Args:
            api_key: Gemini API key for authentication
        """
        self._client = genai.Client(api_key=api_key)
        self._store_cache: Optional[Dict[str, str]] = None  # displayName -> name mapping
        self._cache_timestamp: float = 0.0
    
    def _fetch_stores_sync(self) -> Dict[str, str]:
        """
        Fetch all file search stores from Gemini API (synchronous).
        
        This is a sync method because the Google GenAI SDK is synchronous.
        Call via asyncio.to_thread() from async contexts.
        
        Returns:
            Dictionary mapping display names to store names
        """
        stores_dict: Dict[str, str] = {}
        
        # List all stores - the Pager object is directly iterable
        for store in self._client.file_search_stores.list(config={'page_size': 20}):
            display_name = getattr(store, 'display_name', None)
            store_name = getattr(store, 'name', None)
            
            if display_name and store_name:
                stores_dict[display_name] = store_name
        
        return stores_dict
    
    async def _get_stores(self, force_refresh: bool = False) -> Dict[str, str]:
        """
        Get file search stores with caching (async wrapper).
        
        Args:
            force_refresh: If True, bypass cache and fetch fresh data
            
        Returns:
            Dictionary mapping display names to store names
        """
        current_time = time.time()
        cache_age = current_time - self._cache_timestamp
        
        # Use cache if valid and not forcing refresh
        if not force_refresh and self._store_cache is not None and cache_age < CACHE_TTL_SECONDS:
            return self._store_cache
        
        # Fetch fresh data in thread pool (Google SDK is sync)
        self._store_cache = await asyncio.to_thread(self._fetch_stores_sync)
        self._cache_timestamp = current_time
        
        return self._store_cache
    
    async def search(self, params: SearchParams) -> str:
        """
        Perform semantic search over a file search store.
        
        Args:
            params: Search parameters including store, query, format options
            
        Returns:
            Formatted search results as markdown or JSON string
            
        Raises:
            StoreNotFoundError: If the requested store doesn't exist
            Exception: For other API or processing errors
        """
        # Get stores (with caching)
        stores = await self._get_stores()
        
        # Validate target exists
        if params.target not in stores:
            available_stores = sorted(stores.keys())
            raise StoreNotFoundError(params.target, available_stores)
        
        store_name = stores[params.target]
        
        # Build Gemini API request
        config = types.GenerateContentConfig(
            tools=[
                types.Tool(
                    file_search=types.FileSearch(
                        file_search_store_names=[store_name],
                        metadata_filter=params.metadata_filter if params.metadata_filter else None
                    )
                )
            ],
            temperature=0.0  # Deterministic for consistent results
        )
        
        # Execute search in thread pool (Google SDK is sync)
        def _generate_content():
            return self._client.models.generate_content(
                model=MODEL_NAME,
                contents=params.query,
                config=config
            )
        
        response = await asyncio.to_thread(_generate_content)
        
        # Check if we got results
        if not response.candidates or not response.candidates[0].grounding_metadata:
            # Format helpful error message
            if params.response_format == "json":
                import json
                return json.dumps({
                    "query": params.query,
                    "target": params.target,
                    "response": "No results found",
                    "sources": [],
                    "suggestion": "The query may not match content in this target. Try rephrasing or use a different target."
                }, indent=2)
            else:
                return (
                    f"No results found in target '{params.target}' for query: {params.query}\n\n"
                    "**Why this happened:** The query may not match any content in this documentation target.\n\n"
                    "**Try:**\n"
                    "  - Rephrasing your question with different keywords\n"
                    "  - Being more specific or more general\n"
                    "  - Searching a different documentation target"
                )
        
        # Extract grounding metadata
        grounding = response.candidates[0].grounding_metadata
        
        # Parse grounding into structured result
        search_result = parse_grounding_metadata(grounding, params.top_k)
        
        # Get response text from the actual response
        if response.text:
            search_result.response_text = response.text
        
        # Format based on requested format
        if params.response_format == "json":
            return format_json(search_result, params)
        else:
            return format_markdown(search_result, params)
