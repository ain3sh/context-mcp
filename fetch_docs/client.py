"""
Context7 API client with httpx.

Handles communication with the Context7 API, including:
- Library search
- Documentation retrieval
- Version-specific fetching

All I/O is async via httpx.
"""

import httpx
from typing import List, Optional

from .models import (
    CONTEXT7_API_KEY,
    LibraryInfo,
    DocumentChunk,
    DocumentationResult,
    Context7APIError,
)


# Constants
BASE_URL = "https://context7.com/api/v1"
DEFAULT_TIMEOUT = 30.0  # seconds


class Context7Client:
    """
    Async client for Context7 API.
    
    Provides methods for searching libraries and fetching documentation.
    Uses optional API key for higher rate limits and private libraries.
    """
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Context7 client.
        
        Args:
            api_key: Optional API key. Falls back to CONTEXT7_API_KEY env var.
                     If not provided, uses free tier (lower rate limits).
        """
        self._api_key = api_key or CONTEXT7_API_KEY
        self._headers = {}
        
        if self._api_key:
            self._headers["Authorization"] = f"Bearer {self._api_key}"
    
    async def search(self, query: str) -> List[LibraryInfo]:
        """
        Search for libraries matching a query.
        
        Args:
            query: Library name to search for (e.g., "react", "pytorch")
            
        Returns:
            List of matching LibraryInfo objects (up to 50 results)
            
        Raises:
            Context7APIError: If API returns an error
        """
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(
                f"{BASE_URL}/search",
                params={"query": query},
                headers=self._headers
            )
            
            if response.status_code != 200:
                raise Context7APIError(
                    response.status_code,
                    self._extract_error_message(response)
                )
            
            data = response.json()
            results = data.get("results", [])
            
            return [self._parse_library_info(lib) for lib in results]
    
    async def get_context(
        self,
        library_id: str,
        topic: Optional[str] = None,
        tokens: int = 10000,
        version: Optional[str] = None
    ) -> DocumentationResult:
        """
        Fetch documentation for a library.
        
        Args:
            library_id: Library ID in format "/owner/repo"
            topic: Optional topic to focus results (e.g., "routing", "hooks")
            tokens: Maximum token count (100-100000, default 10000)
            version: Optional specific version tag
            
        Returns:
            DocumentationResult with chunks and metadata
            
        Raises:
            Context7APIError: If API returns an error
        """
        # Build URL - strip leading slash from library_id
        clean_id = library_id.lstrip("/")
        
        if version:
            url = f"{BASE_URL}/{clean_id}/{version}"
        else:
            url = f"{BASE_URL}/{clean_id}"
        
        # Build query params
        params = {
            "type": "json",  # Always get JSON for structured parsing
            "tokens": tokens
        }
        
        if topic:
            params["topic"] = topic
        
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(
                url,
                params=params,
                headers=self._headers
            )
            
            if response.status_code != 200:
                raise Context7APIError(
                    response.status_code,
                    self._extract_error_message(response)
                )
            
            data = response.json()
            return self._parse_documentation_result(data)
    
    def _parse_library_info(self, data: dict) -> LibraryInfo:
        """Parse API response into LibraryInfo object."""
        return LibraryInfo(
            id=data.get("id", ""),
            title=data.get("title", ""),
            description=data.get("description", ""),
            stars=data.get("stars", 0),
            total_tokens=data.get("totalTokens", 0),
            trust_score=data.get("trustScore", 0),
            benchmark_score=data.get("benchmarkScore", 0.0),
            versions=data.get("versions", []),
            branch=data.get("branch", ""),
            state=data.get("state", "finalized")
        )
    
    def _parse_documentation_result(self, data: dict) -> DocumentationResult:
        """Parse API response into DocumentationResult object."""
        chunks = []
        
        # API returns 'snippets' not 'chunks'
        for snippet in data.get("snippets", []):
            # Build content from available fields
            content_parts = []
            
            if snippet.get("codeDescription"):
                content_parts.append(snippet["codeDescription"])
            
            # codeList contains the actual code/content
            code_list = snippet.get("codeList", [])
            if code_list:
                code_lang = snippet.get("codeLanguage", "")
                for code_item in code_list:
                    if code_lang:
                        content_parts.append(f"```{code_lang}\n{code_item}\n```")
                    else:
                        content_parts.append(code_item)
            
            chunks.append(DocumentChunk(
                title=snippet.get("codeTitle", snippet.get("pageTitle", "")),
                content="\n\n".join(content_parts),
                source=snippet.get("pageTitle", ""),
                url=snippet.get("codeId", "")  # codeId is actually a URL
            ))
        
        # Calculate total tokens from snippets
        total_tokens = sum(s.get("codeTokens", 0) for s in data.get("snippets", []))
        
        return DocumentationResult(
            library_id=data.get("library", ""),
            version=data.get("version", ""),
            topic=data.get("topic"),
            tokens=total_tokens,
            chunks=chunks
        )
    
    def _extract_error_message(self, response: httpx.Response) -> str:
        """Extract error message from API response."""
        try:
            data = response.json()
            return data.get("message", data.get("error", response.text))
        except Exception:
            return response.text or f"HTTP {response.status_code}"
