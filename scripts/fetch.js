// scripts/fetch.js
// Pull subs, total videos, and lifetime views directly from the YouTube /about page text.
// - Force English via ?hl=en&gl=US so labels are "subscribers", "videos", "views".
// - Parse K/M/B & grouped numbers. Tight windows right after each label.
// - No external APIs, no Social Blade.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const channelsPath = path.join(__dirname, "..", "channels.json");
const outDir = path.join(__dirname, "..", "web");
const outFile = path.join(outDir, "data.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const LANG = "en-US,en;q=0.9";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isId = (s) => /^UC[A-Za-z0-9_-]{22}$/.test(s || "");
const isHandle = (s) => /^@/.test(s || "");

/* ---------- URL helpers ---------- */
function normalizeInput(s) {
  const t = (s || "").trim();
  if (!/^https?:\/\//i.test(t)) return t; // already @handle or UC…
  try {
    const u = new URL(t);
    const mId = u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/);
    if (mId) return mId[1];
    const mH = u.pathname.match(/\/@([^/?#]+)/);
    if (mH) return "@" + mH[1];
    return t; // keep legacy /user/... as-is
  } catch {
    return t;
  }
}
function ytBase(x) {
  if (/^https?:\/\//i.test(x)) return x.replace(/\/+$/, "");
  if (isHandle(x)) return `https://www.youtube.com/${x}`;
  if (isId(x)) return `https://www.youtube.com/channel/${x}`;
  return `https://www.youtube.com/@${x.replace(/^@/, "")}`;
}
function withHLGL(u) {
  const url = new URL(u);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "US");
  url.searchParams.set("persist_hl", "1");
  url.searchParams.set("persist_gl", "1");
  return url.toString();
}
const ytAboutUrl = (x) => withHLGL(ytBase(x) + "/about");

/* ---------- Fetch + plain-text ---------- */
async function fetchHTML(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      cookie: "CONSENT=YES+1" // skip EU consent wall
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- Number parsing ---------- */
function parseCountToken(tok) {
  if (!tok) return null;
  const t = String(tok).replace(/[,\s]/g, "").toUpperCase();
  const m = t.match(/^([\d.]+)([KMB])?$/) || t.match(/^(\d{1,15})$/);
  if (!m) return null;
  const n = parseFloat(m[1]); const u = m[2];
  if (u === "K") return Math.round(n * 1e3);
  if (u === "M") return Math.round(n * 1e6);
  if (u === "B") return Math.round(n * 1e9);
  return Math.round(n);
}
function collectNumbers(str) {
  const out = [];
  const patterns = [
    /\b\d+(?:\.\d+)?\s*[KMB]\b/gi,                // 4.5M / 12K
    /\b\d{1,3}(?:[,\s]\d{3}){1,7}\b/g,            // 45,203,487 / 1 234 567
    /\b\d{2,}\b/g                                 // 207 / 322 (avoid lone "1")
  ];
  for (const re of patterns) {
    const m = str.match(re) || [];
    for (const s of m) {
      const n = parseCountToken(s);
      if (n != null) out.push(n);
    }
  }
  return out;
}

/* ---------- Extract just after label ---------- */
function numberNearLabel(text, label, windowChars = 220) {
  const i = text.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return [];
  const slice = text.slice(i, i + windowChars);
  return collectNumbers(slice);
}

/* ---------- Parse one channel from /about ---------- */
async function parseAbout(input) {
  const html = await fetchHTML(ytAboutUrl(input));
  const text = htmlToText(html);

  // Basics (title/handle/id/pfp/verified) from simple meta — optional
  const title = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || "";
  const pfp = (html.match(/<link rel="image_src" href="([^"]+)"/) || [])[1] || "";
  let handle = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) || [])[1] || "";
  const id = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/) || [])[1] || "";
  const verified = /BADGE_STYLE_TYPE_VERIFIED|\"Verified\"/i.test(html);

  // Force handle to start with "@"
  if (handle && !handle.startsWith("@")) {
    const m = handle.match(/@[^/?#]+/);
    if (m) handle = m[0];
  }

  // Collect candidates near each label (tight windows)
  let subCands   = numberNearLabel(text, "subscribers", 160);
  let videoCands = numberNearLabel(text, "videos",      200);
  let viewCands  = numberNearLabel(text, "views",       220);

  // Heuristics:
  // - Subscribers: pick the LARGEST candidate near "subscribers".
  // - Views:       pick the LARGEST candidate near "views".
  // - Videos:      pick the SMALLEST plausible candidate near "videos".
  //   (uploads are the small one; avoid grabbing views/subs by mistake)
  const subs  = subCands.length  ? Math.max(...subCands) : null;
  const views = viewCands.length ? Math.max(...viewCands) : null;

  // Filter video candidates:
  videoCands = videoCands.filter(n =>
    n >= 0 &&
    n <= 1_000_000 &&            // uploads won't be crazy-high
    (!subs  || n !== subs) &&    // avoid equal-to-subs
    (!views || n !== views)      // avoid equal-to-views
  );
  const videos = videoCands.length ? Math.min(...videoCands) : null;

  return { title, pfp, handle, id, verified, subs, views, videos };
}

/* ---------- Build all ---------- */
async function main() {
  const raw = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    if (i > 0) await sleep(700 + Math.random() * 400);

    try {
      const m = await parseAbout(item);
      rows.push({
        input: item,
        id: m.id || (isId(item) ? item : null),
        handle: m.handle || (isHandle(item) ? item : ""),
        title: m.title || m.handle || m.id || "Channel",
        pfp: m.pfp || "",
        verified: !!m.verified,
        subs: m.subs ?? null,
        videos: m.videos ?? null,
        views: m.views ?? null,
        hiddenSubs: m.subs == null
      });
      console.log(`[${i + 1}/${inputs.length}] ${rows.at(-1).title} — subs:${m.subs ?? "—"} videos:${m.videos ?? "—"} views:${m.views ?? "—"}`);
    } catch (e) {
      console.error(`Failed for ${item}:`, e.message);
      rows.push({
        input: item,
        id: isId(item) ? item : null,
        handle: isHandle(item) ? item : "",
        title: isHandle(item) ? item : (isId(item) ? item : "Channel"),
        pfp: "",
        verified: false,
        subs: null, videos: null, views: null,
        hiddenSubs: true
      });
    }
  }

  // Sort A→Z
  rows.sort((a, b) =>
    (a.title || a.handle || a.id || "").localeCompare(
      b.title || b.handle || b.id || "",
      undefined,
      { sensitivity: "base" }
    )
  );

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2), "utf8");
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
