#!/usr/bin/env python3
"""
Integration test for fetch_docs module.

This is a REAL test that actually calls the Context7 API with real inputs.
No API key required - Context7 has a free tier.

Run with: python3 test_fetch_docs.py
"""

import asyncio
import json
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from fetch_docs import fetch_documentation


async def test_basic_fetch():
    """
    Test basic documentation fetch with a well-known library.
    """
    print("🧪 Test 1: Basic Fetch (Next.js)")
    print("-" * 50)
    
    try:
        result = await fetch_documentation(
            target="next.js",
            depth="low"
        )
        
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        # Should contain documentation or search results
        if "# Documentation:" in result:
            print("✅ PASS: Got documentation")
            print(f"   Result length: {len(result)} characters")
            return True
        
        if "Error" in result or "No Match" in result:
            print(f"⚠️  WARN: Got error response")
            print(f"   {result[:300]}...")
            return False
        
        print("❌ FAIL: Unexpected response format")
        print(f"   Got: {result[:200]}...")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Exception: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_with_tag():
    """
    Test fetching with a tag filter.
    """
    print("\n🧪 Test 2: Fetch with Tag (React + hooks)")
    print("-" * 50)
    
    try:
        result = await fetch_documentation(
            target="react",
            topic="hooks",  # Internal API still uses 'topic'
            depth="low"
        )
        
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        if "# Documentation:" in result:
            print("✅ PASS: Got documentation with tag filter")
            print(f"   Result length: {len(result)} characters")
            return True
        
        print("⚠️  WARN: Unexpected response")
        print(f"   Got: {result[:200]}...")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Exception: {type(e).__name__}: {e}")
        return False


async def test_browse_index():
    """
    Test browse_index mode returns search results.
    """
    print("\n🧪 Test 3: Browse Index (Search Results)")
    print("-" * 50)
    
    try:
        result = await fetch_documentation(
            target="mongo",
            unsure=True  # Internal API still uses 'unsure'
        )
        
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        if "Library Search Results" in result or "matching libraries" in result:
            print("✅ PASS: Got search results in browse mode")
            print(f"   Result length: {len(result)} characters")
            return True
        
        print("⚠️  WARN: Expected search results")
        print(f"   Got: {result[:200]}...")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Exception: {type(e).__name__}: {e}")
        return False


async def test_basic_fastapi():
    """
    Test fetching fastapi docs.
    """
    print("\n🧪 Test 4: Basic Fetch (FastAPI)")
    print("-" * 50)
    
    try:
        result = await fetch_documentation(
            target="fastapi",
            depth="low"
        )
        
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        if "# Documentation:" in result:
            print("✅ PASS: Got documentation")
            print(f"   Result length: {len(result)} characters")
            return True
        
        print("⚠️  WARN: Unexpected response")
        print(f"   Got: {result[:200]}...")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Exception: {type(e).__name__}: {e}")
        return False


async def test_nonexistent_library():
    """
    Test handling of nonexistent library.
    """
    print("\n🧪 Test 5: Nonexistent Library")
    print("-" * 50)
    
    try:
        result = await fetch_documentation(
            target="xyznonexistent12345"
        )
        
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        if "No Results" in result or "No Match" in result:
            print("✅ PASS: Got helpful error for nonexistent library")
            return True
        
        print("⚠️  WARN: Expected error message")
        print(f"   Got: {result[:200]}...")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Exception: {type(e).__name__}: {e}")
        return False


async def main():
    """Run all tests and report results."""
    print("=" * 50)
    print("Fetch-Docs Integration Tests")
    print("=" * 50)
    print()
    
    tests = [
        test_basic_fetch,
        test_with_tag,
        test_browse_index,
        test_basic_fastapi,
        test_nonexistent_library,
    ]
    
    results = []
    for test in tests:
        result = await test()
        results.append(result)
    
    print("\n" + "=" * 50)
    print("Test Summary")
    print("=" * 50)
    
    passed = sum(1 for r in results if r is True)
    failed = sum(1 for r in results if r is False)
    
    print(f"✅ Passed:  {passed}")
    print(f"❌ Failed:  {failed}")
    print()
    
    if failed > 0:
        print("💡 Some tests failed. Review and fix the issues.")
        sys.exit(1)
    else:
        print("🎉 All tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
