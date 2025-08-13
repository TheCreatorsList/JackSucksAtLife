// scripts/fetch.js
// Subs from YouTube (/about); Views & Videos from Social Blade PROFILE header (Uploads / Video Views).
// Robust, no API keys.

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
      // helps skip YT consent interstitial on server side
      cookie: "CONSENT=YES+1",
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

/* ---------- Social Blade PROFILE: “Uploads” (videos) & “Video Views” (lifetime) ---------- */

// Turn HTML into a flat text flow so label→number proximity is reliable
function stripToText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}

// Find the FIRST good-looking number within N characters AFTER the label in PLAIN TEXT.
function numberNearLabelText(text, label, windowSize=160){
  const i = text.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return null;
  const slice = text.slice(i, i + windowSize);

  // Prefer suffixed K/M/B, then grouped 1,234,567, then plain >=4 digits
  const suff = slice.match(/\b(\d+(?:\.\d+)?\s*[KMB])\b/i);
  if (suff) return parseCount(suff[1]);
  const grp = slice.match(/\b(\d{1,3}(?:[,\s]\d{3}){1,7})\b/);
  if (grp) return parseCount(grp[1]);
  const plain = slice.match(/\b(\d{4,})\b/);
  if (plain) return parseCount(plain[1]);
  return null;
}

async function getSBProfileCounts(x){
  const html = await fetchText(sbMainUrl(x), { referer: "https://socialblade.com/" });
  const text = stripToText(html);

  // Canonical header labels
  let videos = numberNearLabelText(text, "Uploads", 160);
  let views  = numberNearLabelText(text, "Video Views", 160);

  // Some pages show lowercase variants
  if (videos == null) videos = numberNearLabelText(text, "videos", 160);
  if (views  == null) views  = numberNearLabelText(text, "views", 160);

  // Heuristic: uploads shouldn't be insanely large; if > 1,000,000 it's probably wrong.
  if (videos != null && videos > 1_000_000) videos = null;

  // Also read subscribers as an emergency fallback (we still prefer YT for subs)
  const subs = numberNearLabelText(text, "Subscribers", 160);

  return { videos, views, subs };
}

// Last-resort realtime page (labels vary)
async function getSBRealtimeCounts(x){
  const html = await fetchText(sbRealtimeUrl(x), { referer: "https://socialblade.com/" });
  const text = stripToText(html);
  let videos = numberNearLabelText(text, "Videos", 200) ?? numberNearLabelText(text, "Uploads", 200);
  let views  = numberNearLabelText(text, "Video Views", 200) ?? numberNearLabelText(text, "views", 200);
  if (videos != null && videos > 1_000_000) videos = null;
  const subs = numberNearLabelText(text, "Subscribers", 200);
  return { videos, views, subs };
}

async function getSBCounts(x, attempt=1){
  try{
    const p = await getSBProfileCounts(x);
    if (p.videos == null || p.views == null){
      try{
        const r = await getSBRealtimeCounts(x);
        p.videos = p.videos ?? r.videos;
        p.views  = p.views  ?? r.views;
        // subs kept just as an emergency fallback
        p.subs   = p.subs   ?? r.subs;
      }catch{}
    }
    return p;
  }catch(e){
    if (attempt < 2){ await sleep(1200*attempt); return getSBCounts(x, attempt+1); }
    try{ return await getSBRealtimeCounts(x); } catch { return { videos:null, views:null, subs:null }; }
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

    // YouTube basics (subs, title, pfp, verified, id/handle)
    const yt = await getYouTubeBasics(item);

    // Social Blade for lifetime views & total uploads
    const sb = await getSBCounts(yt.handle || yt.id || item);

    // Final values
    const subs   = yt.subs ?? sb.subs ?? null;   // prefer YT; SB only if YT failed
    const views  = sb.views ?? null;             // PROFILE "Video Views" only
    const videos = sb.videos ?? null;            // PROFILE "Uploads" only

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
