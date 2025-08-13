// scripts/fetch.js
// Channel directory with reliable stats, no API keys.
// - Subs + lifetime views: YouTube /about (only)
// - Total videos: YouTube root or /videos (videosCountText/videoCountText)
// - SB used ONLY as last-resort fallback for videos (Uploads) — never for subs/views.

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

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const isId = s => /^UC[A-Za-z0-9_-]{22}$/.test(s||"");
const isHandle = s => /^@/.test(s||"");
const ex = (html, re) => (html.match(re) || [])[1] || null;

function parseCount(s){
  if (!s) return null;
  const t = String(s).replace(/[,\s]/g,"").toUpperCase();
  const m = t.match(/^([\d.]+)([KMB])?$/) || t.match(/^(\d{1,15})$/);
  if (!m) return null;
  const n = parseFloat(m[1]); const u = m[2];
  if (u==="K") return Math.round(n*1e3);
  if (u==="M") return Math.round(n*1e6);
  if (u==="B") return Math.round(n*1e9);
  return Math.round(n);
}

/* ---------- inputs & urls ---------- */
function normalizeInput(s){
  const t=(s||"").trim();
  if (!/^https?:\/\//i.test(t)) return t; // already @handle or UC…
  try{
    const u=new URL(t);
    const mId=u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/); if (mId) return mId[1];
    const mH =u.pathname.match(/\/@([^/?#]+)/);                 if (mH) return "@"+mH[1];
    return t; // legacy /user/... kept as URL
  }catch{ return t; }
}
function ytBase(x){
  if (/^https?:\/\//i.test(x)) return x.replace(/\/+$/,"");
  if (isHandle(x)) return `https://www.youtube.com/${x}`;
  if (isId(x))     return `https://www.youtube.com/channel/${x}`;
  return `https://www.youtube.com/@${x.replace(/^@/,"")}`;
}
function withHLGL(u){
  const url = new URL(u);
  url.searchParams.set("hl","en"); url.searchParams.set("gl","US");
  url.searchParams.set("persist_hl","1"); url.searchParams.set("persist_gl","1");
  return url.toString();
}
const ytAboutUrl  = x => withHLGL(ytBase(x) + "/about");
const ytRootUrl   = x => withHLGL(ytBase(x));
const ytVideosUrl = x => withHLGL(ytBase(x) + "/videos");

// Social Blade (videos fallback only)
const sbMainUrl = x =>
  isHandle(x) ? `https://socialblade.com/youtube/handle/${x.slice(1)}`
  : isId(x)   ? `https://socialblade.com/youtube/channel/${x}`
              : `https://socialblade.com/youtube/handle/${x.replace(/^@/,"")}`;

async function fetchText(url, extraHeaders={}){
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      cookie: "CONSENT=YES+1", // skip YT consent interstitial
      ...extraHeaders
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/* ---------- YouTube parsing ---------- */
function parseBasics(html){
  const title =
    ex(html, /<meta property="og:title" content="([^"]+)"/) ||
    ex(html, /"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/) || "";

  const pfp =
    ex(html, /<link rel="image_src" href="([^"]+)"/) ||
    ex(html, /"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/) || "";

  const handle =
    ex(html, /"canonicalChannelUrl"\s*:\s*"\/(@[^"]+)"/) ||
    ex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) || "";

  const id =
    ex(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/);

  const verified =
    /"metadataBadgeRenderer"\s*:\s*\{[^}]*"style"\s*:\s*"BADGE_STYLE_TYPE_VERIFIED"/i.test(html) ||
    /"tooltip"\s*:\s*"Verified"/i.test(html);

  return { title, pfp, handle, id, verified };
}

function parseAboutCounts(html){
  // Strictly from /about
  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const subs  = subsTxt ? parseCount(subsTxt.replace(/[^0-9KMB.,]/g,"")) : null;

  const viewsTxt =
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const views = viewsTxt ? parseCount(viewsTxt.replace(/[^0-9KMB.,]/g,"")) : null;

  return { subs, views };
}

function parseVideosCount(html){
  // YouTube may use either "videosCountText" or "videoCountText"
  const vidsTxt =
    ex(html, /"videosCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videosCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const videos = vidsTxt ? parseCount(vidsTxt.replace(/[^0-9KMB.,]/g,"")) : null;
  return { videos };
}

async function getYouTubeAll(x){
  let basics = {};
  let subs = null, views = null, videos = null;

  // 1) /about → subs + views + basics
  try{
    const aboutHTML = await fetchText(ytAboutUrl(x));
    basics = { ...basics, ...parseBasics(aboutHTML) };
    const c = parseAboutCounts(aboutHTML);
    subs  = c.subs ?? subs;
    views = c.views ?? views;
  }catch{}

  // 2) root → videos
  if (videos == null){
    try{
      const rootHTML = await fetchText(ytRootUrl(x));
      basics = { ...basics, ...parseBasics(rootHTML) };
      const v = parseVideosCount(rootHTML);
      videos = v.videos ?? videos;
    }catch{}
  }

  // 3) /videos → videos (backup)
  if (videos == null){
    try{
      const vidsHTML = await fetchText(ytVideosUrl(x));
      basics = { ...basics, ...parseBasics(vidsHTML) };
      const v = parseVideosCount(vidsHTML);
      videos = v.videos ?? videos;
    }catch{}
  }

  return { ...basics, subs, views, videos };
}

/* ---------- Social Blade (videos fallback only) ---------- */
function stripToText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function numbersNearLabel(text, label, windowSize){
  const i = text.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return [];
  const slice = text.slice(i, i + windowSize);
  const out = new Set();
  (slice.match(/\b\d+(?:\.\d+)?\s*[KMB]\b/gi)||[]).forEach(s=>{ const n=parseCount(s); if(n!=null) out.add(n);});
  (slice.match(/\b\d{1,3}(?:[,\s]\d{3}){1,7}\b/g)||[]).forEach(s=>{ const n=parseCount(s); if(n!=null) out.add(n);});
  (slice.match(/\b\d{2,}\b/g)||[]).forEach(s=>{ const n=parseCount(s); if(n!=null) out.add(n);});
  return Array.from(out);
}
async function getSBVideosFallback(x){
  try{
    const html = await fetchText(sbMainUrl(x), { referer: "https://socialblade.com/" });
    const text = stripToText(html);
    let vids = numbersNearLabel(text, "Uploads", 200);
    if (!vids.length) vids = numbersNearLabel(text, "videos", 200);
    // plausible uploads range
    vids = vids.filter(n => n >= 0 && n <= 1_000_000);
    return vids.length ? Math.min(...vids) : null;
  }catch{ return null; }
}

/* ---------- main ---------- */
async function main(){
  const raw = JSON.parse(await fs.readFile(channelsPath,"utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i=0;i<inputs.length;i++){
    const item = inputs[i];
    if (i>0) await sleep(800 + Math.random()*400); // gentle pacing

    // Get YT data
    const yt = await getYouTubeAll(item);

    // Fallback: if videos missing, try SB "Uploads" (never use SB for subs/views)
    let videos = yt.videos;
    if (videos == null) {
      videos = await getSBVideosFallback(yt.handle || yt.id || item);
    }

    rows.push({
      input: item,
      id: yt.id || (isId(item)?item:null),
      handle: yt.handle || (isHandle(item)?item:""),
      title: yt.title || yt.handle || yt.id || "Channel",
      pfp: yt.pfp || "",
      verified: !!yt.verified,
      subs: yt.subs ?? null,     // strictly from YT /about
      views: yt.views ?? null,   // strictly from YT /about
      videos: videos ?? null,    // from YT; SB only if YT failed
      hiddenSubs: yt.subs == null
    });

    console.log(`[${i+1}/${inputs.length}] ${rows.at(-1).title} — subs:${yt.subs ?? "?"} views:${yt.views ?? "?"} vids:${videos ?? "?"}`);
  }

  // Sort A→Z (frontend can re-sort)
  rows.sort((a,b)=> (a.title||a.handle||a.id||"").localeCompare(b.title||b.handle||b.id||"", undefined, {sensitivity:"base"}));

  await fs.mkdir(outDir,{recursive:true});
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2), "utf8");
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
