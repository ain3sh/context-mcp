"""
Library matching with 3-tier cascade algorithm.

Provides intelligent matching from user's library guess to Context7 library ID.
Uses a fast-to-thorough cascade:
1. Exact match (case-insensitive)
2. Partial match (substring containment via RapidFuzz)
3. Semantic match (fuzzy weighted ratio)

All matching uses RapidFuzz for speed - no heavy embedding models needed
for short library name matching.
"""

from typing import List, Optional
from rapidfuzz import fuzz, process

from .models import (
    LibraryInfo,
    MatchResult,
    SEMANTIC_FLOOR,
)


class LibraryMatcher:
    """
    Matches user input to Context7 library IDs using 3-tier cascade.
    
    The cascade goes from fastest/strictest to slowest/fuzziest:
    1. Exact match on title (case-insensitive)
    2. Partial match using partial_ratio (substring containment)
    3. Semantic match using WRatio (weighted fuzzy matching)
    
    This approach is 100x+ faster than embedding-based matching
    while being sufficient for short library name strings.
    """
    
    def __init__(self, libraries: List[LibraryInfo]):
        """
        Initialize matcher with candidate libraries.
        
        Args:
            libraries: List of LibraryInfo from Context7 search results
        """
        self._libraries = libraries
        
        # Pre-compute lowercase versions for fast exact matching
        self._title_to_lib = {
            lib.title.lower(): lib for lib in libraries
        }
        
        # Also index by repo name (last part of ID)
        self._repo_to_lib = {}
        for lib in libraries:
            repo_name = lib.id.split("/")[-1].lower() if "/" in lib.id else lib.id.lower()
            self._repo_to_lib[repo_name] = lib
    
    def find_best(self, target: str) -> MatchResult:
        """
        Find the best matching library for the given target.
        
        Uses 3-tier cascade:
        1. Exact match (instant, perfect confidence)
        2. Partial match (fast, high confidence)
        3. Semantic match (thorough, variable confidence)
        
        Args:
            target: User's library guess (e.g., "react", "next.js", "pytorch")
            
        Returns:
            MatchResult with matched library (or None), score, tier, and candidates
        """
        if not self._libraries:
            return MatchResult(
                library=None,
                score=0.0,
                tier="none",
                candidates=[]
            )
        
        target_lower = target.lower().strip()
        
        # Tier 1: Exact match
        result = self._try_exact_match(target_lower)
        if result:
            return result
        
        # Tier 2: Semantic match (WRatio handles fuzzy/token matching)
        return self._try_semantic_match(target_lower)
    
    def get_top_candidates(self, n: int = 5) -> List[tuple]:
        """
        Get top N candidates by benchmark score for suggestions.
        
        Args:
            n: Number of candidates to return
            
        Returns:
            List of (LibraryInfo, score) tuples sorted by benchmark score
        """
        sorted_libs = sorted(
            self._libraries,
            key=lambda lib: lib.benchmark_score,
            reverse=True
        )
        return [(lib, lib.benchmark_score) for lib in sorted_libs[:n]]
    
    def _try_exact_match(self, target: str) -> Optional[MatchResult]:
        """
        Tier 1: Try exact match on title or repo name.
        
        Args:
            target: Lowercase target string
            
        Returns:
            MatchResult if exact match found, None otherwise
        """
        # Check title
        if target in self._title_to_lib:
            return MatchResult(
                library=self._title_to_lib[target],
                score=100.0,
                tier="exact"
            )
        
        # Check repo name (e.g., "next.js" matches "/vercel/next.js")
        if target in self._repo_to_lib:
            return MatchResult(
                library=self._repo_to_lib[target],
                score=100.0,
                tier="exact"
            )
        
        return None
    
    def _try_semantic_match(self, target: str) -> MatchResult:
        """
        Tier 2: Semantic matching with weighted fuzzy ratio.
        
        Uses RapidFuzz WRatio which applies multiple strategies
        (ratio, partial_ratio, token_sort_ratio, etc.) and returns
        the best score. Handles word order and partial matches well.
        
        Args:
            target: Lowercase target string
            
        Returns:
            MatchResult with best match if above floor, or with candidates
        """
        # Build choices list with titles, repo names, and full IDs
        choices = []
        choice_to_lib = {}
        
        for lib in self._libraries:
            # Add title
            choices.append(lib.title)
            choice_to_lib[lib.title] = lib
            
            # Add repo name as alternative
            repo_name = lib.id.split("/")[-1] if "/" in lib.id else lib.id
            if repo_name != lib.title:
                choices.append(repo_name)
                choice_to_lib[repo_name] = lib
            
            # Add full ID path (e.g., "/mongodb/docs" for matching "mongodb")
            if lib.id not in choice_to_lib:
                choices.append(lib.id)
                choice_to_lib[lib.id] = lib
        
        # Get top matches using ratio (stricter than WRatio, avoids substring false positives)
        results = process.extract(
            target,
            choices,
            scorer=fuzz.ratio,
            limit=5
        )
        
        if not results:
            return MatchResult(
                library=None,
                score=0.0,
                tier="semantic",
                candidates=[]
            )
        
        # Best match
        best_choice, best_score, _ = results[0]
        best_lib = choice_to_lib[best_choice]
        
        # Build candidates list (deduplicated by library ID)
        seen_ids = set()
        candidates = []
        for choice, score, _ in results:
            lib = choice_to_lib[choice]
            if lib.id not in seen_ids:
                seen_ids.add(lib.id)
                candidates.append((lib, score))
        
        # Check if best match meets threshold
        if best_score >= SEMANTIC_FLOOR:
            return MatchResult(
                library=best_lib,
                score=best_score,
                tier="semantic",
                candidates=candidates
            )
        
        # No confident match - return candidates for error message
        return MatchResult(
            library=None,
            score=best_score,
            tier="semantic",
            candidates=candidates
        )
