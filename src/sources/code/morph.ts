import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const context = z.object({ file: z.string(), lines: z.string().optional(), content: z.string() });
export const searchContent = z.object({ summary: z.string(), contexts: z.array(context) });
const morphResult = searchContent.partial().extend({ success: z.literal(true) });
const githubUrl = /^https:\/\/github\.com\/([a-z\d-]+)\/([a-z\d._-]+)(?:\/tree\/([^?#\s]+?))?\/?$/i;

async function run(command: "morph" | "git", args: string[], cwd: string, signal: AbortSignal) {
  try {
    return (await exec(command, args, {
      cwd, signal, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })).stdout;
  } catch (err) {
    signal.throwIfAborted();
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error(`Install ${command === "morph" ? "the Morph CLI" : "Git"} on the MCP server's PATH.`);
    }
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`${command} output exceeded 256 KiB. Narrow the search; no partial result was returned.`);
    }
    // Morph writes search failures to JSON stdout, but setup errors to stderr.
    if (command === "morph" && e.stdout) {
      const failure = z.object({ success: z.literal(false), error: z.string() }).safeParse(
        parseMorphJson(e.stdout),
      );
      if (failure.success) throw new Error(failure.data.error.slice(0, 1500));
    }
    throw new Error(e.stderr?.trim().slice(-1500) || `${command} failed (${e.code ?? "terminated"}).`);
  }
}

function parseMorphJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new SyntaxError("Morph did not return valid search JSON.", { cause });
  }
}

async function search(query: string, dir: string, reference: string, signal: AbortSignal) {
  const raw = await run("morph", ["search", "--repo", dir, "--json", "--", query], dir, signal);
  const parsed = morphResult.safeParse(parseMorphJson(raw));
  if (!parsed.success) throw new Error("Morph returned an unexpected search result.");
  const { summary = "", contexts = [] } = parsed.data;
  return {
    reference, summary,
    contexts: contexts.map(c => ({ ...c, file: relative(dir, resolve(dir, c.file)) })),
  };
}

export async function codeSearch(query: string, reference: string, cwd: string, signal: AbortSignal) {
  if (!/^[a-z][\w+.-]*:\/\//i.test(reference)) {
    const dir = await realpath(resolve(cwd, reference));
    if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${dir}`);
    return search(query, dir, dir, signal);
  }

  const match = githubUrl.exec(reference);
  if (!match || /^\.+$/.test(match[2])) {
    throw new Error("Expected https://github.com/owner/repo or https://github.com/owner/repo/tree/branch.");
  }
  const [, owner, repo, tree] = match;
  const url = `https://github.com/${owner}/${repo}`;
  const branch = tree && decodeURIComponent(tree);
  // A fresh shallow checkout cannot resolve a deleted or slash-containing branch to a stale cache entry.
  const dir = await mkdtemp(join(tmpdir(), "context-mcp-github-"));
  try {
    await run("git", ["clone", "--quiet", "--depth=1", "--single-branch", "--no-tags",
      ...(branch ? ["--branch", branch] : []), "--", url, dir], dir, signal);
    // git clone --branch also accepts tags (detached HEAD); /tree/ must name an exact branch.
    if (branch && (await run("git", ["rev-parse", "--symbolic-full-name", "HEAD"], dir, signal)).trim() !== `refs/heads/${branch}`) {
      throw new Error(`Not a branch: ${branch}`);
    }
    return await search(query, dir, tree ? `${url}/tree/${tree}` : url, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
