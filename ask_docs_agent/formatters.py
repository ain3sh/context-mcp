"""
Response formatting for semantic search results.

Converts Gemini API responses into structured SearchResult objects,
then formats them as markdown or JSON for MCP clients.
"""

import json
from typing import Any, List
from .types import ChunkData, SearchParams, SearchResult

# Constants
CHUNK_CHAR_LIMIT = 500  # Truncate chunk previews to this length
CHARACTER_LIMIT = 25000  # Maximum total response length


def parse_grounding_metadata(grounding: Any, top_k: int) -> SearchResult:
    """
    Parse Gemini grounding metadata into structured SearchResult.
    
    This is the single source of truth for extracting data from the
    Gemini API response. Both format_markdown and format_json use this.
    
    Args:
        grounding: Grounding metadata from Gemini response
        top_k: Maximum number of chunks to include
        
    Returns:
        SearchResult with parsed response text, sources, and chunks
    """
    chunks_raw = getattr(grounding, 'grounding_chunks', []) or []
    
    # Extract unique source titles
    sources = set()
    for chunk in chunks_raw:
        retrieved_ctx = getattr(chunk, 'retrieved_context', None)
        if retrieved_ctx:
            title = getattr(retrieved_ctx, 'title', None)
            if title:
                sources.add(title)
    
    # Extract and truncate chunks
    chunks: List[ChunkData] = []
    for i, chunk in enumerate(chunks_raw[:top_k]):
        retrieved_ctx = getattr(chunk, 'retrieved_context', None)
        if retrieved_ctx:
            title = getattr(retrieved_ctx, 'title', '')
            text = getattr(retrieved_ctx, 'text', '')
            
            original_length = len(text)
            truncated_text = text[:CHUNK_CHAR_LIMIT] if len(text) > CHUNK_CHAR_LIMIT else text
            
            chunks.append(ChunkData(
                title=title,
                text=truncated_text,
                truncated=len(text) > CHUNK_CHAR_LIMIT,
                original_length=original_length
            ))
    
    # Get main response text
    # Try different attributes the response might be under
    response_text = ""
    if hasattr(grounding, 'text'):
        response_text = grounding.text or ""
    
    return SearchResult(
        response_text=response_text if response_text else "No response generated",
        sources=sorted(sources),
        chunks=chunks
    )


def format_markdown(result: SearchResult, params: SearchParams) -> str:
    """
    Format SearchResult as markdown for human-readable output.
    
    Args:
        result: Parsed search result
        params: Original search parameters
        
    Returns:
        Markdown-formatted string
    """
    output: List[str] = []
    
    output.append(f"# Search Results: {params.target}\n\n")
    output.append(f"**Query**: {params.query}\n\n")
    output.append(f"**Response**:\n{result.response_text}\n\n")
    
    # Add sources section
    output.append("---\n\n")
    output.append(f"**Sources** ({len(result.sources)} files):\n")
    for source in result.sources:
        output.append(f"  - {source}\n")
    
    # Optionally add chunk previews
    if params.include_chunks and result.chunks:
        output.append("\n---\n\n")
        output.append("## Retrieved Context Chunks\n\n")
        
        for i, chunk in enumerate(result.chunks, 1):
            output.append(f"### [{i}] {chunk.title}\n\n")
            output.append(f"{chunk.text}\n")
            
            if chunk.truncated:
                chars_omitted = chunk.original_length - len(chunk.text)
                output.append(f"\n... [truncated, {chars_omitted} chars omitted]\n")
            
            output.append("\n---\n\n")
    
    response = ''.join(output)
    
    # Check character limit
    if len(response) > CHARACTER_LIMIT:
        truncated = response[:CHARACTER_LIMIT]
        response = (
            f"{truncated}\n\n"
            f"[TRUNCATED - Response exceeds {CHARACTER_LIMIT} characters. "
            f"Original length: {len(response)}. "
            f"Try reducing top_k or disabling include_chunks.]"
        )
    
    return response


def format_json(result: SearchResult, params: SearchParams) -> str:
    """
    Format SearchResult as JSON for programmatic consumption.
    
    Args:
        result: Parsed search result
        params: Original search parameters
        
    Returns:
        JSON-formatted string
    """
    output_dict = {
        "query": params.query,
        "target": params.target,
        "response": result.response_text,
        "sources": result.sources
    }
    
    # Optionally include chunks
    if params.include_chunks:
        output_dict["chunks"] = [
            {
                "title": chunk.title,
                "text": chunk.text,
                "truncated": chunk.truncated,
                "original_length": chunk.original_length
            }
            for chunk in result.chunks
        ]
    
    json_str = json.dumps(output_dict, indent=2)
    
    # Check character limit
    if len(json_str) > CHARACTER_LIMIT:
        # For JSON, we can't easily truncate, so just add a warning
        warning = {
            "warning": f"Response exceeds {CHARACTER_LIMIT} characters",
            "original_length": len(json_str),
            "suggestion": "Try reducing top_k or disabling include_chunks"
        }
        output_dict["_truncation_warning"] = warning
        json_str = json.dumps(output_dict, indent=2)
    
    return json_str
