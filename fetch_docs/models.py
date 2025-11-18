"""
Internal types for fetch-docs module.

These types are used internally after validation has already occurred
at the MCP boundary (server.py). They are simpler dataclasses without
validation logic.
"""

import os
from dataclasses import dataclass, field
from typing import List, Literal, Optional


# ============================================================================
# Configurable Constants
# ============================================================================

# Optional API key for higher rate limits and private libraries
CONTEXT7_API_KEY = os.getenv("CONTEXT7_API_KEY")

# Depth → Token mapping (configurable via environment variables)
DEPTH_TOKENS = {
    "low": int(os.getenv("FETCH_DOCS_LOW_TOKENS", "5000")),
    "medium": int(os.getenv("FETCH_DOCS_MEDIUM_TOKENS", "15000")),
    "high": int(os.getenv("FETCH_DOCS_HIGH_TOKENS", "50000"))
}

# Matching thresholds
PARTIAL_MATCH_THRESHOLD = int(os.getenv("FETCH_DOCS_PARTIAL_THRESHOLD", "90"))
SEMANTIC_FLOOR = int(os.getenv("FETCH_DOCS_SEMANTIC_FLOOR", "60"))

# API limits
MAX_SEARCH_RESULTS = 50
CHARACTER_LIMIT = 25000


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class FetchParams:
    """
    Parameters for documentation fetch.
    
    These have already been validated by Pydantic in server.py,
    so we use simple dataclasses here for internal passing.
    """
    target: str  # Library guess: "pytorch", "react", "next.js"
    topic: Optional[str] = None  # Focus area: "routing", "hooks"
    depth: Literal["low", "medium", "high"] = "medium"
    version: Optional[str] = None  # Specific version: "v15.1.8"
    unsure: bool = False  # Return search results if True
    response_format: Literal["markdown", "json"] = "markdown"
    
    @property
    def tokens(self) -> int:
        """Get token count based on depth setting."""
        return DEPTH_TOKENS[self.depth]


@dataclass
class LibraryInfo:
    """
    Information about a library from Context7 search results.
    
    Attributes:
        id: Library ID in format "/owner/repo"
        title: Display name of the library
        description: Short description
        stars: GitHub stars count
        total_tokens: Total tokens in documentation
        trust_score: Source reputation (0-10)
        benchmark_score: Quality indicator (0-100)
        versions: Available version tags
        branch: Git branch being tracked
        state: Processing state
    """
    id: str
    title: str
    description: str = ""
    stars: int = 0
    total_tokens: int = 0
    trust_score: int = 0
    benchmark_score: float = 0.0
    versions: List[str] = field(default_factory=list)
    branch: str = ""
    state: str = "finalized"


@dataclass
class DocumentChunk:
    """
    A single documentation chunk from Context7.
    
    Attributes:
        title: Title of the documentation section
        content: Documentation content
        source: Source file path in the repository
        url: URL to the original documentation
    """
    title: str
    content: str
    source: str = ""
    url: str = ""


@dataclass
class DocumentationResult:
    """
    Result from fetching documentation.
    
    Attributes:
        library_id: Library ID that was fetched
        version: Version of the library
        topic: Requested topic (if specified)
        tokens: Actual token count in response
        chunks: Documentation chunks with content
    """
    library_id: str
    version: str
    topic: Optional[str]
    tokens: int
    chunks: List[DocumentChunk]


@dataclass
class MatchResult:
    """
    Result of library matching attempt.
    
    Attributes:
        library: Matched library info (None if no match)
        score: Confidence score (0-100)
        tier: Which matching tier succeeded ("exact", "partial", "semantic")
        candidates: Top candidates if no confident match
    """
    library: Optional[LibraryInfo]
    score: float
    tier: str
    candidates: List[tuple] = field(default_factory=list)  # [(LibraryInfo, score), ...]


# ============================================================================
# Custom Exceptions
# ============================================================================

class NoMatchFoundError(Exception):
    """
    Raised when no library matches with sufficient confidence.
    
    Attributes:
        target: The search target that didn't match
        candidates: List of (LibraryInfo, score) tuples for suggestions
    """
    def __init__(self, target: str, candidates: List[tuple]):
        self.target = target
        self.candidates = candidates
        super().__init__(f"No match found for '{target}'")


class Context7APIError(Exception):
    """
    Raised when Context7 API returns an error.
    
    Attributes:
        status_code: HTTP status code
        message: Error message from API
    """
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"Context7 API error ({status_code}): {message}")
