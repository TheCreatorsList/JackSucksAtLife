// scripts/fetch.js
// Subs from YouTube (/about, fallback SB). Views & Videos from Social Blade PROFILE header.
// Robust: collect multiple candidates near the label, then choose (max for views, min for uploads).

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
const ytAboutUrl = x => withHLGL(ytBase(x) + "/about");

// Social Blade PROFILE (preferred) and realtime (last resort)
const sbMainUrl = x =>
  isHandle(x) ? `https://socialblade.com/youtube/handle/${x.slice(1)}`
  : isId(x)   ? `https://socialblade.com/youtube/channel/${x}`
              : `https://socialblade.com/youtube/handle/${x.replace(/^@/,"")}`;
const sbRealtimeUrl = x =>
  isHandle(x) ? `https://socialblade.com/youtube/handle/${x.slice(1)}/realtime`
  : isId(x)   ? `https://socialblade.com/youtube/channel/${x}/realtime`
              : `https://socialblade.com/youtube/handle/${x.replace(/^@/,"")}/realtime`;

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

/* ---------- YouTube (/about) for: title, pfp, handle, id, verified, subs ---------- */
function parseYouTubeAbout(html){
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

  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"/) ||
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const subs = subsTxt ? parseCount(subsTxt.replace(/[^0-9KMB.,]/g,"")) : null;

  return { title, pfp, handle, id, verified, subs };
}
async function getYouTubeBasics(x, attempt=1){
  try{ const html = await fetchText(ytAboutUrl(x)); return parseYouTubeAbout(html); }
  catch(e){ if (attempt<3){ await sleep(800*attempt); return getYouTubeBasics(x, attempt+1); }
    return { title:"", pfp:"", handle:isHandle(x)?x:"", id:isId(x)?x:null, verified:false, subs:null };
  }
}

/* ---------- Social Blade PROFILE parsing ---------- */
// Convert HTML to plain text flow (remove tags/scripts/styles)
function stripToText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}

// Return ALL numeric candidates near a label in TEXT (tight window)
function numbersNearLabel(text, label, windowSize){
  const i = text.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return [];
  const slice = text.slice(i, i + windowSize);

  const cands = new Set();

  // 1) suffixed (K/M/B)
  (slice.match(/\b\d+(?:\.\d+)?\s*[KMB]\b/gi) || []).forEach(s => {
    const n = parseCount(s); if (n != null) cands.add(n);
  });

  // 2) grouped 1,234,567 (comma or space)
  (slice.match(/\b\d{1,3}(?:[,\s]\d{3}){1,7}\b/g) || []).forEach(s => {
    const n = parseCount(s); if (n != null) cands.add(n);
  });

  // 3) plain integers (>=2 digits to avoid stray "1")
  (slice.match(/\b\d{2,}\b/g) || []).forEach(s => {
    const n = parseCount(s); if (n != null) cands.add(n);
  });

  return Array.from(cands);
}

async function parseSBProfile(html, knownSubs){
  const text = stripToText(html);

  // Tight windows right after the header labels
  let vidsCands  = numbersNearLabel(text, "Uploads", 200);
  let viewsCands = numbersNearLabel(text, "Video Views", 220);

  // Some pages use lower-case variants near header
  if (vidsCands.length === 0)  vidsCands  = numbersNearLabel(text, "videos", 200);
  if (viewsCands.length === 0) viewsCands = numbersNearLabel(text, "views", 220);

  // Subscribers as fallback (for when YT subs didn't parse)
  let subsCands = numbersNearLabel(text, "Subscribers", 200);

  // Filter out bad candidates:
  const subs = knownSubs ?? (subsCands.length ? Math.max(...subsCands) : null);

  // For uploads: plausible range [0..1e6], and definitely not equal to subs (when subs is big)
  vidsCands = vidsCands.filter(n => n >= 0 && n <= 1_000_000 && !(subs && n === subs && subs > 1000));
  // For views: should be large (>= 1k). Remove values equal to subs as a guard.
  viewsCands = viewsCands.filter(n => n >= 1000 && !(subs && n === subs && subs > 1000));

  // Choose: uploads = MIN candidate; views = MAX candidate (lifetime total is biggest near the header)
  const videos = vidsCands.length ? Math.min(...vidsCands) : null;
  const views  = viewsCands.length ? Math.max(...viewsCands) : null;

  // Subs fallback (only if YT failed)
  const subsFallback = (subs && !knownSubs) ? subs : null;

  return { videos, views, subsFallback };
}

async function getSBCounts(x, knownSubs, attempt=1){
  try{
    const html = await fetchText(sbMainUrl(x), { referer: "https://socialblade.com/" });
    let { videos, views, subsFallback } = await parseSBProfile(html, knownSubs);

    if (videos == null || views == null){
      // Try realtime page if profile parsing didn’t yield both
      try{
        const rhtml = await fetchText(sbRealtimeUrl(x), { referer: "https://socialblade.com/" });
        const r = await parseSBProfile(rhtml, knownSubs);
        videos = videos ?? r.videos;
        views  = views  ?? r.views;
        subsFallback = subsFallback ?? r.subsFallback;
      }catch{}
    }
    return { videos, views, subsFallback };
  }catch(e){
    if (attempt < 2){ await sleep(1200*attempt); return getSBCounts(x, knownSubs, attempt+1); }
    return { videos:null, views:null, subsFallback:null };
  }
}

/* ---------- main ---------- */
async function main(){
  const raw = JSON.parse(await fs.readFile(channelsPath,"utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i=0;i<inputs.length;i++){
    const item = inputs[i];
    if (i>0) await sleep(900 + Math.random()*500); // gentle pacing

    // 1) YouTube basics (subs, title, pfp, verified, id/handle)
    const yt = await getYouTubeBasics(item);

    // 2) Social Blade for lifetime views & total uploads (with candidate selection)
    const sb = await getSBCounts(yt.handle || yt.id || item, yt.subs);

    const subs   = yt.subs ?? sb.subsFallback ?? null;  // prefer YT, fallback SB
    const views  = sb.views ?? null;                    // lifetime
    const videos = sb.videos ?? null;                   // total uploads

    rows.push({
      input: item,
      id: yt.id || (isId(item)?item:null),
      handle: yt.handle || (isHandle(item)?item:""),
      title: yt.title || yt.handle || yt.id || "Channel",
      pfp: yt.pfp || "",
      verified: !!yt.verified,
      subs, views, videos,
      hiddenSubs: subs == null
    });

    console.log(`[${i+1}/${inputs.length}] ${rows.at(-1).title} — subs:${subs ?? "?"} views:${views ?? "?"} vids:${videos ?? "?"}`);
  }

  // Sort A→Z (frontend can re-sort)
  rows.sort((a,b)=> (a.title||a.handle||a.id||"").localeCompare(b.title||b.handle||b.id||"", undefined, {sensitivity:"base"}));

  await fs.mkdir(outDir,{recursive:true});
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2), "utf8");
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
