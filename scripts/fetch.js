// scripts/fetch.js
// All stats from YouTube /about (no SB, no API):
// - Subscribers: subscriberCountText (simpleText / runs)
// - Views:       viewCountText      (simpleText / runs)
// - Videos:      videosCountText OR videoCountText OR plain "123 videos" text (from /about)
//
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

// pull the first numeric token (incl. K/M/B) from a string
function firstNumberToken(str) {
  if (!str) return null;
  const m =
    String(str).match(/\b\d+(?:[\s,]\d{3})+|\b\d+(?:\.\d+)?\s*[KMB]\b|\b\d+\b/i);
  return m ? m[0] : null;
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
    return t; // legacy /user/... kept as URL
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

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      cookie: "CONSENT=YES+1", // skip EU consent interstitial
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/* ---------- /about parsing ---------- */
function parseBasics(html) {
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

// subs + views from the JSON blobs on /about
function parseSubsViewsFromAbout(html) {
  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(
      html,
      /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/
    );
  const subs = subsTxt ? parseCount(firstNumberToken(subsTxt)) : null;

  const viewsTxt =
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(
      html,
      /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/
    );
  const views = viewsTxt ? parseCount(firstNumberToken(viewsTxt)) : null;

  return { subs, views };
}

// videos from /about — try multiple structures (videosCountText / videoCountText / plain text)
function parseVideosFromAbout(html) {
  // 1) videosCountText.simpleText might contain "322 videos"
  const v1 =
    ex(html, /"videosCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/i);
  if (v1) {
    const tok = firstNumberToken(v1);
    const n = parseCount(tok);
    if (n != null) return n;
  }

  // 2) videosCountText.runs e.g., [{"text":"322"},{"text":" videos"}]
  const v2 =
    ex(
      html,
      /"videosCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"(\d[\d,\s\.]*)"\s*\}\s*,\s*\{[^}]*"text"\s*:\s*"(?:\s*videos?\s*)"/i
    ) ||
    ex(
      html,
      /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"(\d[\d,\s\.]*)"\s*\}\s*,\s*\{[^}]*"text"\s*:\s*"(?:\s*videos?\s*)"/i
    );
  if (v2) {
    const n = parseCount(v2);
    if (n != null) return n;
  }

  // 3) videoCountText.simpleText may be just a number or "322 videos"
  const v3 =
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/i);
  if (v3) {
    const tok = firstNumberToken(v3);
    const n = parseCount(tok);
    if (n != null) return n;
  }

  // 4) very generic: "... 322 videos ..." anywhere in About page
  const v4 = ex(html, /(?:^|[^a-zA-Z])(\d[\d,\s\.]*)\s*videos?\b/i);
  if (v4) {
    const n = parseCount(v4);
    if (n != null) return n;
  }

  return null; // couldn't find videos in /about this run
}

async function getAboutAll(x, attempt = 1) {
  try {
    const html = await fetchText(ytAboutUrl(x));
    const basics = parseBasics(html);
    const { subs, views } = parseSubsViewsFromAbout(html);
    const videos = parseVideosFromAbout(html);
    return { ...basics, subs, views, videos };
  } catch (e) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return getAboutAll(x, attempt + 1);
    }
    return {
      title: "",
      pfp: "",
      handle: isHandle(x) ? x : "",
      id: isId(x) ? x : null,
      verified: false,
      subs: null,
      views: null,
      videos: null,
    };
  }
}

/* ---------- main ---------- */
async function main() {
  const raw = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    if (i > 0) await sleep(800 + Math.random() * 400); // be gentle

    const ch = await getAboutAll(item);

    rows.push({
      input: item,
      id: ch.id || (isId(item) ? item : null),
      handle: ch.handle || (isHandle(item) ? item : ""),
      title: ch.title || ch.handle || ch.id || "Channel",
      pfp: ch.pfp || "",
      verified: !!ch.verified,
      subs: ch.subs ?? null,   // /about
      views: ch.views ?? null, // /about
      videos: ch.videos ?? null, // /about (multiple patterns)
      hiddenSubs: ch.subs == null,
    });

    console.log(
      `[${i + 1}/${inputs.length}] ${rows.at(-1).title} — subs:${ch.subs ?? "—"} views:${ch.views ?? "—"} vids:${ch.videos ?? "—"}`
    );
  }

  // A→Z sort for consistency
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
    JSON.stringify(
      { generatedAt: new Date().toISOString(), channels: rows },
      null,
      2
    ),
    "utf8"
  );
  console.log(
    `Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
