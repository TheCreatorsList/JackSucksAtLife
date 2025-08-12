// scripts/fetch.js
// Build channel directory with stats (title, handle, id, pfp, verified, subs, videos, views)
// No API keys. Prefers YouTube (/about, root, /videos); SB profile/realtime only as last fallback.

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
const ex = (html, re) => (html.match(re) || [])[1] || null;

function parseCount(s) {
  if (!s) return null;
  const t = String(s).replace(/[,\s]/g, "").toUpperCase();
  const m = t.match(/^([\d.]+)([KMB])?$/) || t.match(/^(\d{1,15})$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  if (u === "K") return Math.round(n * 1e3);
  if (u === "M") return Math.round(n * 1e6);
  if (u === "B") return Math.round(n * 1e9);
  return Math.round(n);
}

/* ---------- inputs & urls ---------- */
function normalizeInput(s) {
  const t = (s || "").trim();
  if (!/^https?:\/\//i.test(t)) return t; // already @handle or UC…
  try {
    const u = new URL(t);
    const mId = u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/);
    if (mId) return mId[1];
    const mH = u.pathname.match(/\/@([^/?#]+)/);
    if (mH) return "@" + mH[1];
    // legacy /user/... — keep as URL; we’ll still fetch it
    return t;
  } catch {
    return t;
  }
}

function ytUrlBase(x) {
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

const ytAboutUrl = (x) => withHLGL(ytUrlBase(x) + "/about");
const ytRootUrl = (x) => withHLGL(ytUrlBase(x));
const ytVideosUrl = (x) => withHLGL(ytUrlBase(x) + "/videos");

// Social Blade: prefer main profile page (stable "Uploads"/"Video Views"). Fallback to /realtime.
const sbMainUrl = (x) =>
  isHandle(x)
    ? `https://socialblade.com/youtube/handle/${x.slice(1)}`
    : isId(x)
    ? `https://socialblade.com/youtube/channel/${x}`
    : `https://socialblade.com/youtube/handle/${x.replace(/^@/, "")}`;
const sbRealtimeUrl = (x) =>
  isHandle(x)
    ? `https://socialblade.com/youtube/handle/${x.slice(1)}/realtime`
    : isId(x)
    ? `https://socialblade.com/youtube/channel/${x}/realtime`
    : `https://socialblade.com/youtube/handle/${x.replace(/^@/, "")}/realtime`;

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      // skip EU consent interstitial for YT
      cookie: "CONSENT=YES+1",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/* ---------- YouTube parsing ---------- */
// Title, pfp, handle, id (from any page)
function parseChannelBasics(html) {
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

  const id = ex(
    html,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/
  );

  const verified =
    /"metadataBadgeRenderer"\s*:\s*\{[^}]*"style"\s*:\s*"BADGE_STYLE_TYPE_VERIFIED"/i.test(
      html
    ) || /"tooltip"\s*:\s*"Verified"/i.test(html);

  return { title, pfp, handle, id, verified };
}

// Robust count extraction from YouTube HTML JSON blobs
function parseYouTubeCounts(html) {
  // Subscribers (if present)
  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const subs = subsTxt ? parseCount(subsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  // Lifetime views (About/Root)
  const viewsTxt =
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const views = viewsTxt ? parseCount(viewsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  // Total videos: YouTube uses BOTH videoCountText and videosCountText in different places.
  const vidsTxt =
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videosCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videosCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const videos = vidsTxt ? parseCount(vidsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  return { subs, views, videos };
}

async function getYouTubeAll(x) {
  // Try about → root → videos until we fill everything
  let basic = {};
  let subs = null, views = null, videos = null;

  // 1) About
  try {
    const html = await fetchText(ytAboutUrl(x));
    basic = { ...parseChannelBasics(html), ...basic };
    const c = parseYouTubeCounts(html);
    subs = subs ?? c.subs;
    views = views ?? c.views;
    videos = videos ?? c.videos;
  } catch { /* ignore */ }

  // 2) Root
  if (subs == null || views == null || videos == null) {
    try {
      const html = await fetchText(ytRootUrl(x));
      basic = { ...basic, ...parseChannelBasics(html) };
      const c = parseYouTubeCounts(html);
      subs = subs ?? c.subs;
      views = views ?? c.views;
      videos = videos ?? c.videos;
    } catch { /* ignore */ }
  }

  // 3) /videos
  if (videos == null) {
    try {
      const html = await fetchText(ytVideosUrl(x));
      basic = { ...basic, ...parseChannelBasics(html) };
      const c = parseYouTubeCounts(html);
      videos = videos ?? c.videos;
      // views/subs rarely present here, but fill if found
      subs = subs ?? c.subs;
      views = views ?? c.views;
    } catch { /* ignore */ }
  }

  return { ...basic, subs, views, videos };
}

/* ---------- SocialBlade helpers (profile-first, realtime fallback) ---------- */
// Prefer K/M/B forms, then grouped ints, then plain big ints (>=4 digits).
function pickBestNumberAfter(html, label) {
  const i = html.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return null;
  const slice = html.slice(i, i + 2500);
  const suffixed = slice.match(/\b(\d+(?:\.\d+)?\s*[KMB])\b/gi);
  if (suffixed && suffixed[0]) return parseCount(suffixed[0]);
  const grouped = slice.match(/\b(\d{1,3}(?:[,\s]\d{3}){1,7})\b/g);
  if (grouped && grouped[0]) return parseCount(grouped[0]);
  const plain = slice.match(/\b(\d{4,})\b/);
  if (plain && plain[1]) return parseCount(plain[1]);
  return null;
}

async function getSBFromProfile(x) {
  const html = await fetchText(sbMainUrl(x), { referer: "https://socialblade.com/" });
  const uploads = pickBestNumberAfter(html, "Uploads");
  const subs = pickBestNumberAfter(html, "Subscribers");
  const views = pickBestNumberAfter(html, "Video Views");
  return { uploads, subs, views };
}

async function getSBFromRealtime(x) {
  const html = await fetchText(sbRealtimeUrl(x), { referer: "https://socialblade.com/" });
  const videos = pickBestNumberAfter(html, "Videos") ?? pickBestNumberAfter(html, "Uploads");
  const subs = pickBestNumberAfter(html, "Subscribers");
  const views = pickBestNumberAfter(html, "Video Views");
  return { uploads: videos, subs, views };
}

async function getSBCounts(x, attempt = 1) {
  try {
    const p = await getSBFromProfile(x);
    if (p.uploads == null || p.subs == null || p.views == null) {
      try {
        const r = await getSBFromRealtime(x);
        p.uploads = p.uploads ?? r.uploads;
        p.subs = p.subs ?? r.subs;
        p.views = p.views ?? r.views;
      } catch { /* ignore */ }
    }
    return { subs: p.subs ?? null, videos: p.uploads ?? null, views: p.views ?? null };
  } catch (e) {
    if (attempt < 2) {
      await sleep(1200 * attempt);
      return getSBCounts(x, attempt + 1);
    }
    try {
      const r = await getSBFromRealtime(x);
      return { subs: r.subs ?? null, videos: r.uploads ?? null, views: r.views ?? null };
    } catch {
      return { subs: null, videos: null, views: null };
    }
  }
}

/* ---------- main ---------- */
async function main() {
  const raw = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    if (i > 0) await sleep(900 + Math.random() * 500); // gentle pacing

    // Try YouTube (about + root + videos)
    let yt = await getYouTubeAll(item);

    // Fill gaps with Social Blade (Uploads → videos, Video Views → views)
    let { subs, views, videos } = yt;
    if (subs == null || views == null || videos == null) {
      const sb = await getSBCounts(yt.handle || yt.id || item);
      subs = subs ?? sb.subs;
      views = views ?? sb.views;
      videos = videos ?? sb.videos;
    }

    // Build row
    rows.push({
      input: item,
      id: yt.id || (isId(item) ? item : null),
      handle: yt.handle || (isHandle(item) ? item : ""),
      title: yt.title || yt.handle || yt.id || "Channel",
      pfp: yt.pfp || "",
      verified: !!yt.verified,
      subs,
      views,   // lifetime
      videos,  // total uploads
      hiddenSubs: subs == null,
    });

    console.log(
      `[${i + 1}/${inputs.length}] ${rows.at(-1).title} — subs:${subs ?? "?"} views:${views ?? "?"} vids:${videos ?? "?"}`
    );
  }

  // Sort A→Z (frontend can still re-sort)
  rows.sort((a, b) =>
    (a.title || a.handle || a.id || "").localeCompare(
      b.title || b.handle || b.id || "",
      undefined,
      { sensitivity: "base" }
    )
  );

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
