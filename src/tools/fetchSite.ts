import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

import axios from "axios";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import sharp from "sharp";

const CHARACTER_LIMIT = 25_000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_SITE_TIMEOUT_MS ?? 12_000);
const MAX_REDIRECTS = Number(process.env.FETCH_SITE_MAX_REDIRECTS ?? 3);
const MAX_HTML_BYTES = Number(
  process.env.FETCH_SITE_MAX_HTML_BYTES ?? 2_000_000,
);
const MAX_IMAGE_BYTES = Number(
  process.env.FETCH_SITE_MAX_IMAGE_BYTES ?? 10_000_000,
);
const DEFAULT_CONTENT_DIR = "./context";
const DISABLE_SSRF_GUARD = process.env.FETCH_SITE_DISABLE_SSRF_GUARD === "1";

export interface FetchSiteParams {
  url: string | string[];
  images: boolean;
  refresh: boolean;
}

interface ImageInfo {
  src: string;
  alt: string;
  data?: Buffer;
  filename?: string;
}

interface ExtractedContent {
  markdown: string;
  images: ImageInfo[];
  title?: string;
  description?: string;
}

interface CacheEntry {
  directory: string;
  title: string;
  fetched: string;
  contentPath: string;
  contentHash: string;
  imageCount: number;
  charCount: number;
}

interface CacheManifest {
  version: string;
  entries: Record<string, CacheEntry>;
}

let cacheManifest: CacheManifest = { version: "3.0", entries: {} };
let cacheManifestPath = "";

function isPrivateIP(ip: string): boolean {
  if (!net.isIP(ip)) return false;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

async function validateUrlSafety(rawUrl: string): Promise<void> {
  if (DISABLE_SSRF_GUARD) return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }

  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("Access to localhost is blocked by SSRF guard");
  }

  const addresses = await dns.lookup(host, { all: true });
  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new Error(
        `Access to private IP ${addr.address} is blocked by SSRF guard`,
      );
    }
  }
}

function sanitizeDirname(title: string, url: string): string {
  let dirname = title || extractDirnameFromUrl(url);
  dirname = dirname
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (dirname.length > 100) dirname = dirname.slice(0, 100);
  if (!dirname) dirname = `untitled-${Date.now()}`;
  return dirname;
}

function extractDirnameFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
    if (pathname) {
      const parts = pathname.split("/");
      const last = parts[parts.length - 1].replace(/\.[^.]+$/, "");
      return last || url.hostname;
    }
    return url.hostname;
  } catch {
    return "untitled";
  }
}

function generateContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

async function loadCacheManifest(manifestPath: string): Promise<void> {
  cacheManifestPath = manifestPath;
  try {
    const data = await fs.readFile(manifestPath, "utf-8");
    cacheManifest = JSON.parse(data) as CacheManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cacheManifest = { version: "3.0", entries: {} };
    } else {
      console.warn("Failed to load cache manifest:", error);
      cacheManifest = { version: "3.0", entries: {} };
    }
  }
}

async function saveCacheManifest(): Promise<void> {
  if (!cacheManifestPath) return;
  try {
    const dir = path.dirname(cacheManifestPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      cacheManifestPath,
      JSON.stringify(cacheManifest, null, 2),
      "utf-8",
    );
  } catch (error) {
    console.warn("Failed to save cache manifest:", error);
  }
}

function getCacheEntry(url: string): CacheEntry | undefined {
  return cacheManifest.entries[url];
}

async function setCacheEntry(url: string, entry: CacheEntry): Promise<void> {
  cacheManifest.entries[url] = entry;
  await saveCacheManifest();
}

function generateFrontmatter(metadata: {
  url: string;
  title: string;
  description?: string;
  fetched: string;
  cached?: boolean;
}): string {
  const lines = [
    "---",
    `url: ${metadata.url}`,
    `title: ${metadata.title}`,
  ];
  if (metadata.description) {
    lines.push(`description: ${metadata.description}`);
  }
  lines.push(`fetched: ${metadata.fetched}`);
  if (metadata.cached) lines.push("cached: true");
  lines.push("---", "");
  return lines.join("\n");
}

async function writeMarkdownWithFrontmatter(
  outputPath: string,
  content: string,
  metadata: { url: string; title: string; description?: string; fetched: string },
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = generateFrontmatter(metadata);
  await fs.writeFile(outputPath, frontmatter + content, "utf-8");
}

async function fetchWithLimits(url: string): Promise<{
  html: string;
  contentType: string | null;
  finalUrl: string;
}> {
  await validateUrlSafety(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = url;
    let redirects = 0;
    let response: Awaited<ReturnType<typeof axios.get<any>>> | null = null;

    while (redirects <= MAX_REDIRECTS) {
      const res = await axios.get(currentUrl, {
        responseType: "arraybuffer",
        maxContentLength: MAX_HTML_BYTES,
        validateStatus: (status) => status >= 200 && status < 400,
        signal: controller.signal,
      });

      response = res;

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, currentUrl).toString();
        await validateUrlSafety(next);
        currentUrl = next;
        redirects += 1;
        continue;
      }

      break;
    }

    if (!response) {
      throw new Error("No response received");
    }

    const contentType = (response!.headers["content-type"] as string | undefined) ?? null;
    const buf: Buffer = Buffer.from(response!.data as any);
    if (buf.length > MAX_HTML_BYTES) {
      throw new Error("HTML payload exceeds maximum allowed size");
    }
    const html = buf.toString("utf-8");
    const finalUrl =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((response!.request as any)?.res?.responseUrl as string | undefined) ??
      currentUrl;
    return { html, contentType, finalUrl };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkRobotsTxt(url: string): Promise<void> {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await axios.get(robotsUrl, {
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return;
    const text: string = typeof res.data === "string" ? res.data : String(res.data);
    const lines = text.split(/\r?\n/);
    let appliesToAll = false;
    let disallowAll = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [field, valueRaw] = trimmed.split(":", 2);
      const fieldLower = field.toLowerCase();
      const value = (valueRaw ?? "").trim();
      if (fieldLower === "user-agent") {
        appliesToAll = value === "*";
      } else if (fieldLower === "disallow" && appliesToAll) {
        if (value === "/") {
          disallowAll = true;
          break;
        }
      }
    }
    if (disallowAll) {
      throw new Error(
        "Access disallowed by robots.txt for autonomous agents (Disallow: /)",
      );
    }
  } catch {
    // treat robots errors as no restrictions
  }
}

function isHtmlContent(html: string, contentType: string | null): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) return true;
  return /<html[\s>]/i.test(html) || /<!doctype html>/i.test(html);
}

function extractContent(html: string, url: string): ExtractedContent {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const turndown = new TurndownService();
  const markdown = article ? turndown.turndown(article.content) : turndown.turndown(html);

  const images: ImageInfo[] = [];
  const doc = dom.window.document;
  const imgEls = Array.from(doc.querySelectorAll("img"));
  for (const img of imgEls) {
    const src = img.getAttribute("src") || "";
    if (!src) continue;
    const alt = img.getAttribute("alt") || "";
    const urlObj = new URL(src, url);
    const filename = path.basename(urlObj.pathname) || "image";
    images.push({ src: urlObj.toString(), alt, filename });
  }

  return {
    markdown,
    images,
    title: article?.title ?? dom.window.document.title ?? "",
    description: article?.excerpt ?? undefined,
  };
}

async function fetchImage(url: string, referer: string): Promise<Buffer | null> {
  try {
    await validateUrlSafety(url);
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Referer: referer },
      maxContentLength: MAX_IMAGE_BYTES,
      timeout: FETCH_TIMEOUT_MS,
    });
    const buf: Buffer = Buffer.from(response.data);
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

async function processSingleUrl(
  url: string,
  images: boolean,
  refresh: boolean,
  maxLength: number,
  contentDir: string,
): Promise<{ success: boolean; message: string; title?: string; contentPath?: string; fromCache?: boolean; imageCount?: number; url: string }>
{
  try {
    const manifestPath = path.join(contentDir, "manifest.json");
    await loadCacheManifest(manifestPath);

    if (!refresh) {
      const cached = getCacheEntry(url);
      if (cached) {
        try {
          const content = await fs.readFile(
            path.join(cached.contentPath, "CONTENT.md"),
            "utf-8",
          );
          return {
            success: true,
            message: content,
            title: cached.title,
            contentPath: cached.contentPath,
            fromCache: true,
            imageCount: cached.imageCount,
            url,
          };
        } catch {
          // fall through to re-fetch
        }
      }
    }

    await checkRobotsTxt(url);
    const { html, contentType, finalUrl } = await fetchWithLimits(url);
    if (!isHtmlContent(html, contentType)) {
      const content = `Content type ${contentType ?? "unknown"} cannot be converted to markdown.\n\nRaw content:\n${html.slice(0, maxLength)}`;
      return {
        success: true,
        message: content,
        title: "",
        contentPath: "",
        fromCache: false,
        imageCount: 0,
        url,
      };
    }

    const extracted = extractContent(html, finalUrl);
    let content = extracted.markdown;
    if (content.length > maxLength) {
      const remaining = content.length - maxLength;
      content = `${content.slice(0, maxLength)}\n\n[... Content truncated. ${remaining} characters remaining ...]`;
    }

    let imageCount = 0;
    if (images && extracted.images.length) {
      const tasks = extracted.images.map(async (img) => {
        const data = await fetchImage(img.src, finalUrl);
        if (!data) return null;
        const processed = await sharp(data)
          .resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        return { ...img, data: processed } as ImageInfo;
      });
      const results = await Promise.all(tasks);
      const filtered = results.filter((r): r is ImageInfo => !!r && !!r.data);
      imageCount = filtered.length;
      extracted.images = filtered;
    }

    const dirname = sanitizeDirname(extracted.title ?? "", url);
    const dirPath = path.join(contentDir, dirname);
    const contentPath = path.join(dirPath, "CONTENT.md");
    const fetchedTimestamp = new Date().toISOString();

    await writeMarkdownWithFrontmatter(contentPath, content, {
      url,
      title: extracted.title || "Untitled",
      description: extracted.description,
      fetched: fetchedTimestamp,
    });

    if (imageCount > 0) {
      const imagesDir = path.join(dirPath, "images");
      await fs.mkdir(imagesDir, { recursive: true });
      for (let i = 0; i < extracted.images.length; i++) {
        const img = extracted.images[i];
        if (!img.data) continue;
        const filename = `${i}_${img.filename ?? "image.jpg"}`;
        await fs.writeFile(path.join(imagesDir, filename), img.data);
      }
    }

    await setCacheEntry(url, {
      directory: dirname,
      title: extracted.title || "Untitled",
      fetched: fetchedTimestamp,
      contentPath: dirPath,
      contentHash: generateContentHash(content),
      imageCount,
      charCount: content.length,
    });

    return {
      success: true,
      message: content,
      title: extracted.title || "Untitled",
      contentPath: dirPath,
      fromCache: false,
      imageCount,
      url,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      url,
    } as any;
  }
}

export async function fetchSite(params: FetchSiteParams): Promise<string> {
  const urls = Array.isArray(params.url) ? params.url : [params.url];
  if (urls.length > 10) {
    return (
      "Error: Maximum 10 URLs per batch.\n\n" +
      `You provided ${urls.length} URLs. Please split into smaller batches.`
    );
  }

  const contentDir = DEFAULT_CONTENT_DIR;
  const maxLength = CHARACTER_LIMIT;

  if (urls.length === 1) {
    const result = await processSingleUrl(
      urls[0],
      params.images,
      params.refresh,
      maxLength,
      contentDir,
    );

    if (!result.success) {
      return `Error fetching ${result.url}:\n\n${result.message}`;
    }

    const parts: string[] = [];
    parts.push(`# ${result.title ?? ""}`);
    parts.push("");
    parts.push(result.message);
    parts.push("");
    parts.push("---");
    if (result.contentPath) {
      parts.push(`📁 Saved to: ${result.contentPath}`);
    }
    if (result.fromCache) {
      parts.push(
        "⚡ Served from cache (use refresh=true to re-fetch)",
      );
    }
    if (result.imageCount && result.imageCount > 0) {
      parts.push(`🖼️ ${result.imageCount} images saved`);
    }
    return parts.join("\n");
  }

  const results = await Promise.all(
    urls.map((u) =>
      processSingleUrl(u, params.images, params.refresh, maxLength, contentDir),
    ),
  );

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const out: string[] = [];
  out.push("## Batch Fetch Complete\n\n");
  out.push(`**Total:** ${urls.length} URLs`);
  out.push(`**Successful:** ${successful.length}`);
  if (failed.length) {
    out.push(`**Failed:** ${failed.length}`);
  }
  out.push("\n### Results:\n\n");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.success) {
      const cacheNote = r.fromCache ? " (cached)" : "";
      out.push(
        `${i + 1}. ✓ **${r.title ?? ""}** → \`${r.contentPath ?? ""}\`${cacheNote}`,
      );
    } else {
      out.push(`${i + 1}. ✗ ${r.url}: ${r.message}`);
    }
  }

  const totalImages = successful.reduce(
    (sum, r) => sum + (r.imageCount ?? 0),
    0,
  );
  if (totalImages > 0) {
    out.push("", `**Total images:** ${totalImages}`);
  }

  return out.join("\n");
}
