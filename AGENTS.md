# Working in context-mcp

Keep each tool's registration, schema, and agent-facing instructions together
in `src/tools/`. Put retrieval code under `src/sources/` by subject (`code/`,
`docs/`, or `papers/`), not at the root. `src/index.ts` wires the tools to stdio.

Use the Node version in `.nvmrc`. Run `npm test` before shipping code: it
cleans `dist/`, builds TypeScript, and runs the MCP tests against that build.
Keep local MCP credentials out of the repository.

## Pushing

`origin` is the personal HTTPS repository `ain3sh/context-mcp`. When a push
is authorized, switch GitHub CLI to `ain3sh` for the push, then restore the
work account even if the push fails. For `main`, run from the repository root:

```sh
(
  gh auth switch --hostname github.com --user ain3sh || exit 1
  trap 'gh auth switch --hostname github.com --user factory-ain3sh' EXIT
  git push origin main
)
```

Keep the HTTPS remote and the configured Git commit identity unchanged.
