import { lookup } from "node:dns";
import { Agent } from "node:https";
import { isIP } from "node:net";
import axios from "axios";
import ipaddr from "ipaddr.js";

// Publisher links and redirects come from third parties. Validate the actual
// address used by the socket, not a separate DNS lookup before the request.
const agent = new Agent({
  autoSelectFamily: false,
  lookup(host, options, cb) {
    lookup(host, { family: options.family, all: false }, (err, address, family) => {
      if (!err && ipaddr.process(address).range() !== "unicast")
        err = new Error("Non-public paper host");
      cb(err, address, family);
    });
  },
});

export async function download(href: string, signal: AbortSignal, unavailable: readonly number[] = []) {
  let url = new URL(href);
  for (let hop = 0; hop <= 5; hop++) {
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      !url.hostname.includes(".")
    ) {
      throw new Error("Paper retrieval requires a public HTTPS host.");
    }
    const r = await axios.get<Buffer>(url.href, {
      httpsAgent: agent,
      proxy: false,
      maxRedirects: 0,
      responseType: "arraybuffer",
      maxContentLength: 24 * 1024 * 1024,
      signal,
      validateStatus: () => true,
      headers: { "User-Agent": "context-mcp/1.0 (https://github.com/ain3sh/context-mcp)" },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url);
      // Older registries publish http Locations. Try the TLS endpoint, never cleartext.
      if (url.protocol === "http:") url.protocol = "https:";
      continue;
    }
    if (unavailable.includes(r.status)) return null;
    if (r.status !== 200) throw new Error(`${url.hostname} returned HTTP ${r.status}`);
    return { data: r.data, url: url.href, type: String(r.headers["content-type"] ?? "") };
  }
  throw new Error("Too many paper redirects.");
}

export async function json(href: string, signal: AbortSignal): Promise<unknown> {
  return JSON.parse((await download(href, signal))!.data.toString());
}
