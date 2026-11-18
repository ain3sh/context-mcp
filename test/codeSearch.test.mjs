import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("code_search over stdio", async t => {
  const root = await mkdtemp(join(tmpdir(), "code-search-test-"));
  const sub = join(root, "nested");
  const scratch = join(root, "tmp");
  const morph = join(root, "morph");
  const remote = join(root, "remote.git");
  const url = "https://github.com/example/widgets";
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(sub), mkdir(scratch)]);
  await writeFile(join(root, "source"), "workspace");
  await writeFile(join(sub, "source"), "uncommitted");
  const env = {
    PATH: `${root}:/usr/bin:/bin`, HOME: root, TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: url,
  };
  // Real shallow clones, served from a deterministic two-branch repository without network or credentials.
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote], { env });
  const commit = (branch, value) => `commit refs/heads/${branch}
committer Fixture <fixture@example.invalid> 1 +0000
data 0
M 100644 inline source
data ${value.length}
${value}

`;
  execFileSync("git", ["-C", remote, "fast-import", "--quiet"], {
    env, input: commit("main", "main") + commit("feature/auth", "branch") + "done\n",
  });
  execFileSync("git", ["-C", remote, "tag", "release", "main"], { env });
  await writeFile(morph, `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const args = process.argv.slice(2), query = args.at(-1);
if (args[0] !== "search" || !args.includes("--json") || args.at(-2) !== "--") process.exit(2);
if (query === "wait") require("node:net").connect(process.env.HOME + "/active.sock");
else if (query === "invalid") console.log("not JSON");
else if (query === "oversize") console.log("x".repeat(300000));
else if (query === "failure") { console.log(JSON.stringify({success:false,error:"Search quota exhausted"})); process.exitCode = 1; }
else {
  const file = resolve(args[args.indexOf("--repo") + 1], "source");
  console.log(JSON.stringify({success:true,summary:query,contexts:[{file,lines:"1-1",content:readFileSync(file,"utf8")}]}));
}
`, { mode: 0o700 });

  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    cwd: root, env, stderr: "pipe",
  }));
  t.after(() => client.close());
  const call = (query, reference, options) =>
    client.callTool({ name: "code_search", arguments: { query, reference } }, undefined, options);

  await t.test("advertises one optional reference and its actual default before search", async () => {
    const { tools } = await client.listTools();
    const { inputSchema } = tools.find(tool => tool.name === "code_search");
    assert.deepEqual(inputSchema.required, ["query"]);
    assert.ok(inputSchema.properties.reference.description.includes(root));
    assert.ok(tools.some(tool => tool.name === "fetch_docs"));
  });

  await t.test("each reference searches the selected checkout and returns relative evidence", async () => {
    const query = "--help; $(not-a-command)";
    for (const [reference, resolved, source] of [
      [undefined, root, "workspace"], [".", root, "workspace"],
      ["nested", sub, "uncommitted"], [sub, sub, "uncommitted"],
      [url, url, "main"], [`${url}/tree/feature/auth`, `${url}/tree/feature/auth`, "branch"],
    ]) {
      const result = await call(query, reference);
      assert.deepEqual(result.structuredContent, {
        reference: resolved, summary: query, contexts: [{ file: "source", lines: "1-1", content: source }],
      }, result.content[0].text);
      assert.ok(result.content[0].text.includes(`source:1-1\n${source}`));
    }
    assert.deepEqual(await readdir(scratch), []);
  });

  await t.test("reports wrong targets and CLI failures without returning partial evidence", async () => {
    for (const [query, reference, error] of [
      ["find", "example/widgets", /ENOENT/], ["find", "source", /Not a directory/],
      ["find", `${url}/blob/main/source`, /Expected https/], ["find", `${url}/tree/missing`, /not found/i],
      ["find", `${url}/tree/release`, /Not a branch|not found/i], ["find", "", /invalid/i],
      ["invalid", ".", /valid search JSON/], ["oversize", ".", /exceeded/], ["failure", ".", /quota exhausted/],
    ]) {
      const result = await call(query, reference);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, error);
    }
    assert.deepEqual(await readdir(scratch), []);
  });

  await t.test("MCP cancellation terminates the active Morph process", { timeout: 5000 }, async () => {
    const listener = createServer().listen(join(root, "active.sock"));
    try {
      const ready = once(listener, "connection");
      const controller = new AbortController();
      const request = call("wait", ".", { signal: controller.signal });
      const [socket] = await ready;
      const stopped = once(socket, "close");
      controller.abort();
      await assert.rejects(request);
      await stopped;
    } finally { listener.close(); }
  });

  await t.test("the server stays available without Morph", async () => {
    await rename(morph, `${morph}.disabled`);
    const result = await call("find");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Install the Morph CLI/);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
      "code_search", "code_wiki", "fetch_docs", "paper_read", "paper_search",
    ]);
  });
});
