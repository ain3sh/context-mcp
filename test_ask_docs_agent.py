#!/usr/bin/env python3
"""
Integration test for ask-docs-agent module.

This is a REAL test that actually calls the code with real inputs.
It will fail if GEMINI_API_KEY is not set or if there are no stores available.

Run with: python test_integration.py
"""

import asyncio
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from ask_docs_agent import search_documentation, StoreNotFoundError


async def test_basic_search():
    """
    Test basic search functionality.
    
    This test actually calls the Gemini API and expects real results.
    """
    print("🧪 Test 1: Basic Search")
    print("-" * 50)
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("❌ FAIL: GEMINI_API_KEY environment variable not set")
        print("   Set it with: export GEMINI_API_KEY='your-key-here'")
        return False
    
    try:
        # Test with a real query using an actual target
        result = await search_documentation(
            api_key=api_key,
            target="openai",
            query="What is GPT-4?",
            include_chunks=False,
            top_k=3,
            response_format="markdown"
        )
        
        # Verify we got a non-empty result
        if not result:
            print("❌ FAIL: Got empty result")
            return False
        
        # Verify it contains expected sections
        if "Search Results:" not in result:
            print("❌ FAIL: Result doesn't contain 'Search Results:' header")
            print(f"Got: {result[:200]}...")
            return False
        
        if "Sources" not in result:
            print("❌ FAIL: Result doesn't contain 'Sources' section")
            print(f"Got: {result[:200]}...")
            return False
        
        print("✅ PASS: Got valid search result")
        print(f"   Result length: {len(result)} characters")
        print(f"   Preview: {result[:150]}...")
        return True
        
    except StoreNotFoundError as e:
        print(f"❌ FAIL: Store not found: {e.store}")
        print(f"   Available stores: {e.available}")
        print("   Update the test with a valid store name")
        return False
        
    except Exception as e:
        print(f"❌ FAIL: Unexpected error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_store_not_found():
    """
    Test that StoreNotFoundError is raised correctly.
    
    This tests error handling - expecting a failure is still a test!
    """
    print("\n🧪 Test 2: Store Not Found Error")
    print("-" * 50)
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("⏭️  SKIP: GEMINI_API_KEY not set")
        return None
    
    try:
        result = await search_documentation(
            api_key=api_key,
            target="nonexistent-store-12345",
            query="test query",
            response_format="markdown"
        )
        
        print("❌ FAIL: Should have raised StoreNotFoundError")
        return False
        
    except StoreNotFoundError as e:
        # This is what we expect!
        print(f"✅ PASS: Correctly raised StoreNotFoundError for '{e.store}'")
        print(f"   Available stores: {len(e.available)} found")
        return True
        
    except Exception as e:
        print(f"❌ FAIL: Wrong exception type: {type(e).__name__}: {e}")
        return False


async def test_json_format():
    """
    Test JSON response format.
    """
    print("\n🧪 Test 3: JSON Response Format")
    print("-" * 50)
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("⏭️  SKIP: GEMINI_API_KEY not set")
        return None
    
    try:
        result = await search_documentation(
            api_key=api_key,
            target="openai",
            query="What is semantic search?",
            response_format="json"
        )
        
        # Try to parse as JSON
        import json
        try:
            data = json.loads(result)
            
            # Verify expected fields
            required_fields = ["query", "target", "response", "sources"]
            missing = [f for f in required_fields if f not in data]
            
            if missing:
                print(f"❌ FAIL: Missing fields in JSON: {missing}")
                return False
            
            print("✅ PASS: Got valid JSON response")
            print(f"   Query: {data['query']}")
            print(f"   Sources: {len(data['sources'])} files")
            return True
            
        except json.JSONDecodeError as e:
            print(f"❌ FAIL: Result is not valid JSON: {e}")
            print(f"   Got: {result[:200]}...")
            return False
        
    except StoreNotFoundError as e:
        print(f"⏭️  SKIP: Store '{e.store}' not found")
        return None
        
    except Exception as e:
        print(f"❌ FAIL: Unexpected error: {type(e).__name__}: {e}")
        return False


async def main():
    """Run all tests and report results."""
    print("=" * 50)
    print("Context Tools Integration Tests")
    print("=" * 50)
    print()
    
    tests = [
        test_basic_search,
        test_store_not_found,
        test_json_format
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
    skipped = sum(1 for r in results if r is None)
    
    print(f"✅ Passed:  {passed}")
    print(f"❌ Failed:  {failed}")
    print(f"⏭️  Skipped: {skipped}")
    print()
    
    if failed > 0:
        print("💡 Some tests failed. This is okay! Failures give us information.")
        print("   Fix the issues and run again.")
        sys.exit(1)
    elif passed == 0:
        print("⚠️  No tests passed. Check your setup:")
        print("   1. Is GEMINI_API_KEY set?")
        print("   2. Do you have any file search stores?")
        print("   3. Update test_basic_search with your actual store name")
        sys.exit(1)
    else:
        print("🎉 All tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
