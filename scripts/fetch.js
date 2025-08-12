// scripts/fetch.js
// Scrapes YouTube channel pages (no API key) and writes web/data.json
// Inputs: channels.json with entries like "@JackSucksAtLife" or "UC4-79UOlP48-QNGgCko5p2g"

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const channelsPath = path.join(__dirname, "..", "channels.json");
const outDir = path.join(__dirname, "..", "web");
const outFile = path.join(outDir, "data.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toChannelAboutURL(idOrHandle) {
  return idOrHandle.startsWith("@")
    ? `https://www.youtube.com/${idOrHandle}/about`
    : `https://www.youtube.com/channel/${idOrHandle}/about`;
}

// Convert strings like "1,234", "1.2K", "3.4M" to numbers
function parseCount(str) {
  if (!str) return null;
  const s = String(str).replace(/[, ]/g, "").toUpperCase();
  const m = s.match(/^([\d.]+)([KMB])?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suf = m[2];
  if (suf === "K") return Math.round(n * 1_000);
  if (suf === "M") return Math.round(n * 1_000_000);
  if (suf === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

// Extract JSON by regex; YouTube embeds big JSON blobs.
// We look for keys commonly present on channel About pages.
function extractByRegex(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept-language": "en-US,en;q=0.9",
      "accept": "text/html,*/*"
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

// Parse minimal fields (title, pfp, subs, videos, views) from HTML
function parseChannel(html) {
  // Title via OG tags or metadata
  const title =
    extractByRegex(html, /<meta property="og:title" content="([^"]+)"/) ||
    extractByRegex(html, /"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/) ||
    extractByRegex(html, /"title"\s*:\s*"([^"]+)"/) ||
    "";

  // PFP from image_src or channelMetadataRenderer
  const pfp =
    extractByRegex(html, /<link rel="image_src" href="([^"]+)"/) ||
    extractByRegex(html, /"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/) ||
    "";

  // Subscriber count (if visible)
  // Examples in HTML JSON: "subscriberCountText":{"simpleText":"1.23M subscribers"}
  const subsText =
    extractByRegex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    extractByRegex(html, /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const subs = subsText ? parseCount(subsText.replace(/[^0-9KMB.,]/gi, "")) : null;
  const hiddenSubs = !subsText;

  // Video count sometimes appears as "videoCountText":{"runs":[{"text":"123"}," videos"...]}
  const videosText =
    extractByRegex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    extractByRegex(html, /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const videos = videosText ? parseCount(videosText.replace(/[^0-9KMB.,]/gi, "")) : null;

  // Channel total views (on About): "viewCountText":{"simpleText":"123,456,789 views"}
  const viewsText =
    extractByRegex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    extractByRegex(html, /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const views = viewsText ? parseCount(viewsText.replace(/[^0-9KMB.,]/gi, "")) : null;

  // Handle / vanity URL if present
  const handle =
    extractByRegex(html, /"canonicalChannelUrl"\s*:\s*"\/(@[^"]+)"/) ||
    extractByRegex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) ||
    "";

  // ID from canonical channel link (always present)
  const id =
    extractByRegex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/);

  return { title, pfp, subs, videos, views, hiddenSubs, handle, id };
}

async function fetchChannel(idOrHandle, attempt = 1) {
  const url = toChannelAboutURL(idOrHandle);
  try {
    const html = await fetchHTML(url);
    const data = parseChannel(html);
    return {
      input: idOrHandle,
      id: data.id || (idOrHandle.startsWith("@") ? null : idOrHandle),
      handle: data.handle || (idOrHandle.startsWith("@") ? idOrHandle : ""),
      title: data.title || "",
      pfp: data.pfp || "",
      subs: data.subs,
      videos: data.videos,
      views: data.views,
      hiddenSubs: data.hiddenSubs === true
    };
  } catch (e) {
    // Simple backoff on 429/5xx
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return fetchChannel(idOrHandle, attempt + 1);
    }
    return {
      input: idOrHandle,
      id: idOrHandle.startsWith("@") ? null : idOrHandle,
      handle: idOrHandle.startsWith("@") ? idOrHandle : "",
      title: "",
      pfp: "",
      subs: null,
      videos: null,
      views: null,
      hiddenSubs: true,
      error: String(e.message || e)
    };
  }
}

async function main() {
  const list = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  // Deduplicate
  const unique = Array.from(new Set(list.map(s => s.trim()).filter(Boolean)));

  const results = [];
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    // Gentle pacing to avoid 429s
    if (i > 0) await sleep(500 + Math.random() * 300);
    const data = await fetchChannel(item);
    results.push(data);
    console.log(`[${i + 1}/${unique.length}] ${item} ⇒ ${data.title || data.id || data.handle || "?"}`);
  }

  // Sort by subs desc when available, else by title
  results.sort((a, b) => {
    const as = a.subs ?? -1, bs = b.subs ?? -1;
    if (as !== bs) return bs - as;
    return (a.title || "").localeCompare(b.title || "");
  });

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), channels: results }, null, 2),
    "utf8"
  );

  console.log(`Wrote ${results.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
