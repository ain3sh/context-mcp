"""
Internal types for ask-docs-agent module.

These types are used internally after validation has already occurred
at the MCP boundary (server.py). They are simpler dataclasses without
validation logic.
"""

from dataclasses import dataclass
from typing import List, Literal, Optional


@dataclass
class SearchParams:
    """
    Parameters for documentation search.
    
    These have already been validated by Pydantic in server.py,
    so we use simple dataclasses here for internal passing.
    """
    target: str  # Documentation store/target to search
    query: str
    include_chunks: bool = False
    top_k: int = 3
    response_format: Literal["markdown", "json"] = "markdown"
    metadata_filter: Optional[str] = None


@dataclass
class ChunkData:
    """
    Represents a single retrieved document chunk.
    
    Attributes:
        title: Document title/filename
        text: Chunk text (may be truncated)
        truncated: Whether the text was truncated
        original_length: Length of original text before truncation
    """
    title: str
    text: str
    truncated: bool
    original_length: int


@dataclass
class SearchResult:
    """
    Structured search result from Gemini API.
    
    This is the parsed, format-agnostic representation of the search response.
    Formatters convert this to markdown or JSON.
    
    Attributes:
        response_text: AI-generated answer to the query
        sources: List of source document titles (deduplicated and sorted)
        chunks: Retrieved document chunks with metadata
    """
    response_text: str
    sources: List[str]
    chunks: List[ChunkData]
