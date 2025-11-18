# Agent Reminders 🤖💙

Hey there, future me! You're doing great. Here are some reminders to keep you on track:

## Core Principles

### 1. **No Hardcoding Ever** 🚫
- Don't hardcode API keys, paths, or magic numbers
- Use constants, environment variables, or config files
- If you're typing a literal string or number more than once, make it a constant

### 2. **Write Real Tests, Not Type Checking Theater** ✅
- Tests should **actually call your code** with real inputs
- Don't just check if functions exist or have the right signature
- Test behavior, not structure
- Example of GOOD test: `result = await search_documentation(api_key, "store", "query"); assert "Sources" in result`
- Example of BAD test: `assert callable(search_documentation)`

### 3. **Accept Test Failures Like a Pro** 💪
- If a test fails, **REPORT IT HONESTLY**
- Don't try to bypass, mock away, or "fix" tests by making them do nothing
- Failures are information - they tell you what's broken
- It's better to have 1 real failure than 100 fake passes

### 4. **Trust the Architecture** 🏗️
- You spent time thinking through the design - trust it
- Don't add "just in case" code
- Keep functions small and focused
- If something feels too complex, it probably is

### 5. **Async is Your Friend** ⚡
- All I/O should be async (API calls, file reads)
- Use `await` consistently
- Don't block the event loop

### 6. **Error Messages Are UX** 💬
- Users (LLMs) read your errors - make them helpful
- Include what went wrong, why, and what to try next
- Link to docs when relevant

### 7. **Read Your Own Code** 👀
- Before moving to next task, read what you just wrote
- Does it make sense? Is it clear?
- Would someone else understand it?

## Motivation Boosters 🎉

- **You're porting TypeScript to Python elegantly, not just translating**
- **Clean architecture now = easy debugging later**
- **Every async function is a gift to future scalability**
- **Type hints are documentation that runs**
- **You got this! The hard thinking is done, now it's just execution** 💪

## Quick Checklist Before Committing

- [ ] No hardcoded values?
- [ ] Tests actually run the code?
- [ ] Error messages are helpful?
- [ ] Functions have type hints?
- [ ] Async where it should be?
- [ ] Constants at top of file?
- [ ] Docstrings present?

---

*Remember: Code is read far more often than it's written. Be kind to future you!*

🌟 **You're doing amazing work. Keep going!** 🌟
