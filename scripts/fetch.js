// scripts/fetch.js
// Build a channel directory (title, handle, id, pfp, verified) — no API keys.
// Reads:  channels.json  (array of @handles, UC… IDs, or full YouTube URLs)
// Writes: web/data.json

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
const LANG = "en-US,en;q=0.9";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isId = (s) => /^UC[A-Za-z0-9_-]{22}$/.test(s || "");
const isHandle = (s) => /^@/.test(s || "");

// ---- helpers ----
function normalizeInput(s) {
  if (!s) return "";
  const t = s.trim();
  if (!/^https?:\/\//i.test(t)) return t; // already @handle or UC…
  try {
    const u = new URL(t);
    const mId = u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/);
    if (mId) return mId[1];
    const mHandle = u.pathname.match(/\/@([^/?#]+)/);
    if (mHandle) return "@" + mHandle[1];
    return t; // legacy /user/… — we’ll still fetch it
  } catch {
    return t;
  }
}

function toAboutURL(input) {
  if (/^https?:\/\//i.test(input)) {
    const u = new URL(input);
    if (!/\/about\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/$/, "") + "/about";
    u.searchParams.set("hl", "en");
    u.searchParams.set("gl", "US");
    u.searchParams.set("persist_hl", "1");
    u.searchParams.set("persist_gl", "1");
    return u.toString();
  }
  if (isHandle(input)) {
    return `https://www.youtube.com/${input}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
  }
  if (isId(input)) {
    return `https://www.youtube.com/channel/${input}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
  }
  return `https://www.youtube.com/@${input.replace(/^@/, "")}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      // helps skip YouTube consent wall in server-side requests
      cookie: "CONSENT=YES+1",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

const ex = (html, re) => (html.match(re) || [])[1] || null;

// Parse minimal metadata from the About page HTML
function parseChannel(html) {
  const title =
    ex(html, /<meta property="og:title" content="([^"]+)"/) ||
    ex(html, /"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/) ||
    "";

  const pfp =
    ex(html, /<link rel="image_src" href="([^"]+)"/) ||
    ex(html, /"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/) ||
    "";

  const handle =
    ex(html, /"canonicalChannelUrl"\s*:\s*"\/(@[^"]+)"/) ||
    ex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) ||
    "";

  const id =
    ex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/);

  // Verified badge appears in channel header JSON as a metadataBadgeRenderer
  const verified =
    /"metadataBadgeRenderer"\s*:\s*\{[^}]*"style"\s*:\s*"BADGE_STYLE_TYPE_VERIFIED"/i.test(html) ||
    /"tooltip"\s*:\s*"Verified"/i.test(html);

  return { title, pfp, handle, id, verified };
}

async function getChannelMeta(input, attempt = 1) {
  const url = toAboutURL(input);
  try {
    const html = await fetchHTML(url);
    return parseChannel(html);
  } catch (e) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return getChannelMeta(input, attempt + 1);
    }
    return {
      title: "",
      pfp: "",
      handle: isHandle(input) ? input : "",
      id: isId(input) ? input : null,
      verified: false,
      error: String(e),
    };
  }
}

// ---- main ----
async function main() {
  const raw = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  const inputs = raw.map(normalizeInput).filter(Boolean);
  const unique = Array.from(new Set(inputs));

  const rows = [];
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    if (i > 0) await sleep(500 + Math.random() * 300); // gentle pacing
    const meta = await getChannelMeta(item);
    const row = {
      input: item,
      id: meta.id || (isId(item) ? item : null),
      handle: meta.handle || (isHandle(item) ? item : ""),
      title: meta.title || meta.handle || meta.id || "Channel",
      pfp: meta.pfp || "",
      verified: !!meta.verified,
    };
    rows.push(row);
    console.log(
      `[${i + 1}/${unique.length}] ${row.title} — ${row.handle || row.id || ""} ${row.verified ? "(verified)" : ""}`
    );
  }

  // Sort A→Z by title/handle
  rows.sort((a, b) => {
    const A = (a.title || a.handle || a.id || "").toLowerCase();
    const B = (b.title || b.handle || b.id || "").toLowerCase();
    return A.localeCompare(B);
  });

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2),
    "utf8"
  );
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
