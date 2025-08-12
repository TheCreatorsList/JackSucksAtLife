// 2
// Build channel directory with stats (title, handle, id, pfp, verified, subs, videos, views)
// No API keys. Prefers YouTube /about; falls back to SocialBlade profile (Uploads/Video Views) with /realtime as backup.

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
    // legacy /user/... — keep as URL; we'll still fetch it
    return t;
  } catch {
    return t;
  }
}

function ytAboutUrl(x) {
  if (/^https?:\/\//i.test(x)) {
    const u = new URL(x);
    if (!/\/about\/?$/.test(u.pathname))
      u.pathname = u.pathname.replace(/\/$/, "") + "/about";
    u.searchParams.set("hl", "en");
    u.searchParams.set("gl", "US");
    u.searchParams.set("persist_hl", "1");
    u.searchParams.set("persist_gl", "1");
    return u.toString();
  }
  if (isHandle(x))
    return `https://www.youtube.com/${x}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
  if (isId(x))
    return `https://www.youtube.com/channel/${x}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
  return `https://www.youtube.com/@${x.replace(
    /^@/,
    ""
  )}/about?hl=en&gl=US&persist_hl=1&persist_gl=1`;
}

// Social Blade: prefer main profile page (stable "Uploads"/"Video Views" labels). Fallback to /realtime.
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
    : `https://socialblade.com/youtube/handle/${x.replace(
        /^@/,
        ""
      )}/realtime`;

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      // helps bypass YT consent interstitial in server-side requests
      cookie: "CONSENT=YES+1",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/* ---------- YouTube /about (preferred) ---------- */
function parseYouTube(html) {
  const title =
    ex(html, /<meta property="og:title" content="([^"]+)"/) ||
    ex(html, /"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/) ||
    "";

  const pfp =
    ex(html, /<link rel="image_src" href="([^"]+)"/) ||
    ex(
      html,
      /"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/
    ) ||
    "";

  const handle =
    ex(html, /"canonicalChannelUrl"\s*:\s*"\/(@[^"]+)"/) ||
    ex(
      html,
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/
    ) ||
    "";

  const id = ex(
    html,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/
  );

  const verified =
    /"metadataBadgeRenderer"\s*:\s*\{[^}]*"style"\s*:\s*"BADGE_STYLE_TYPE_VERIFIED"/i.test(
      html
    ) || /"tooltip"\s*:\s*"Verified"/i.test(html);

  // counts (if present on About page)
  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(
      html,
      /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/
    );
  const subs = subsTxt ? parseCount(subsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  const vidsTxt =
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(
      html,
      /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/
    );
  const videos = vidsTxt ? parseCount(vidsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  const viewsTxt =
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(
      html,
      /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/
    );
  const views = viewsTxt ? parseCount(viewsTxt.replace(/[^0-9KMB.,]/g, "")) : null;

  return { title, pfp, handle, id, verified, subs, videos, views };
}

async function getYouTube(x, attempt = 1) {
  try {
    const html = await fetchText(ytAboutUrl(x));
    return parseYouTube(html);
  } catch (e) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return getYouTube(x, attempt + 1);
    }
    return {
      title: "",
      pfp: "",
      handle: isHandle(x) ? x : "",
      id: isId(x) ? x : null,
      verified: false,
      subs: null,
      videos: null,
      views: null,
    };
  }
}

/* ---------- SocialBlade helpers (profile-first, realtime fallback) ---------- */

// Prefer K/M/B forms, then grouped ints, then plain big ints (>=4 digits).
function pickBestNumberAfter(html, label) {
  const i = html.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return null;

  const slice = html.slice(i, i + 2500);

  // 1) Suffixed like "4.62M"
  const suffixed = slice.match(/\b(\d+(?:\.\d+)?\s*[KMB])\b/gi);
  if (suffixed && suffixed[0]) return parseCount(suffixed[0]);

  // 2) Grouped integers like "1,110,686,437" or with spaces
  const grouped = slice.match(/\b(\d{1,3}(?:[,\s]\d{3}){1,7})\b/g);
  if (grouped && grouped[0]) return parseCount(grouped[0]);

  // 3) Plain big ints (>= 4 digits)
  const plain = slice.match(/\b(\d{4,})\b/);
  if (plain && plain[1]) return parseCount(plain[1]);

  return null;
}

// Try SocialBlade main page first (has "Uploads", "Subscribers", "Video Views")
async function getSBFromProfile(x) {
  const html = await fetchText(sbMainUrl(x), { referer: "https://socialblade.com/" });
  const uploads = pickBestNumberAfter(html, "Uploads");
  const subs = pickBestNumberAfter(html, "Subscribers");
  const views = pickBestNumberAfter(html, "Video Views");
  return { uploads, subs, views };
}

// If profile page fails/blocked, try realtime page labels ("Subscribers", "Videos", "Video Views")
async function getSBFromRealtime(x) {
  const html = await fetchText(sbRealtimeUrl(x), { referer: "https://socialblade.com/" });
  // Some realtime pages say "Videos", others say "Uploads"; try both.
  const videos = pickBestNumberAfter(html, "Videos") ?? pickBestNumberAfter(html, "Uploads");
  const subs = pickBestNumberAfter(html, "Subscribers");
  const views = pickBestNumberAfter(html, "Video Views");
  return { uploads: videos, subs, views };
}

async function getSBCounts(x, attempt = 1) {
  try {
    // 1) Profile page (preferred)
    const p = await getSBFromProfile(x);
    // 2) If any missing, patch from realtime
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
    // final fallback: try realtime only
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
    if (i > 0) await sleep(900 + Math.random() * 500); // be gentle

    const yt = await getYouTube(item);

    // Use YT counts when present; SB fills gaps (Uploads->videos, Video Views->views)
    let { subs, views, videos } = yt;
    if (subs == null || views == null || videos == null) {
      const sb = await getSBCounts(yt.handle || yt.id || item);
      subs = subs ?? sb.subs;
      views = views ?? sb.views;     // lifetime "Video Views"
      videos = videos ?? sb.videos;  // "Uploads"
    }

    rows.push({
      input: item,
      id: yt.id || (isId(item) ? item : null),
      handle: yt.handle || (isHandle(item) ? item : ""),
      title: yt.title || yt.handle || yt.id || "Channel",
      pfp: yt.pfp || "",
      verified: !!yt.verified,
      subs,
      views,
      videos,
      hiddenSubs: subs == null,
    });

    console.log(
      `[${i + 1}/${inputs.length}] ${rows.at(-1).title} — subs:${subs ?? "?"} views:${views ?? "?"} vids:${videos ?? "?"}`
    );
  }

  // A → Z by title/handle/id (frontend can still re-sort)
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
