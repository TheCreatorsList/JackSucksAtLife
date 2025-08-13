// scripts/fetch.js
// YouTube-only scraper: subs, videos, views from each channel's /about page (EN).
// 1) Parse ytInitialData JSON for subscriberCountText, videosCountText/videoCountText, viewCountText.
// 2) Fallback to plain text patterns: "<number> subscribers", "<number> videos", "<number> views".
// Includes cache-busting + page-mismatch guard to avoid cross-channel mixups.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
 
const channelsPath = path.join(__dirname, "..", "channels.json");
const outDir  = path.join(__dirname, "..", "web");
const outFile = path.join(outDir, "data.json");

const UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const LANG = "en-US,en;q=0.9";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

const isId     = s => /^UC[A-Za-z0-9_-]{22}$/.test(s||"");
const isHandle = s => /^@/.test(s||"");

// ---------- URL helpers ----------
function normalizeInput(s){
  const t=(s||"").trim();
  if (!/^https?:\/\//i.test(t)) return t;
  try{
    const u=new URL(t);
    const mId=u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/); if (mId) return mId[1];
    const mH =u.pathname.match(/\/@([^/?#]+)/);                 if (mH) return "@"+mH[1];
    return t; // keep /user/... as-is
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
  url.searchParams.set("hl","en");
  url.searchParams.set("gl","US");
  url.searchParams.set("persist_hl","1");
  url.searchParams.set("persist_gl","1");
  return url;
}
function aboutUrl(x, bust){
  const url = withHLGL(ytBase(x) + "/about");
  url.searchParams.set("_cb", String(bust ?? Date.now()));
  return url.toString();
}

// ---------- fetch ----------
async function fetchHTML(url){
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      "referer": "https://www.youtube.com/",
      cookie: "CONSENT=YES+1"
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// ---------- basic meta ----------
function extractBasics(html){
  const title = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || "";
  const pfp   = (html.match(/<link rel="image_src" href="([^"]+)"/) || [])[1] || "";
  let handle  = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) || [])[1] || "";
  const id    = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/) || [])[1] || "";
  const verified = /BADGE_STYLE_TYPE_VERIFIED|\"Verified\"/i.test(html);
  if (handle && !handle.startsWith("@")) {
    const m = handle.match(/@[^/?#]+/); if (m) handle = m[0];
  }
  return { title, pfp, handle, id, verified };
}
function inputMatchesPage(input, basics){
  if (isHandle(input) && basics.handle) return input.toLowerCase() === basics.handle.toLowerCase();
  if (isId(input) && basics.id) return input === basics.id;
  return Boolean(basics.handle || basics.id);
}

// ---------- numeric helpers ----------
function parseCountToken(tok){
  if (!tok) return null;
  const t = String(tok).replace(/[,\s]/g,"").toUpperCase();
  const m = t.match(/^([\d.]+)([KMB])?$/) || t.match(/^(\d{1,15})$/);
  if (!m) return null;
  const n = parseFloat(m[1]); const u = m[2];
  if (u==="K") return Math.round(n*1e3);
  if (u==="M") return Math.round(n*1e6);
  if (u==="B") return Math.round(n*1e9);
  return Math.round(n);
}
function textFrom(obj){
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || "").join("");
  return "";
}
function firstNumberToken(s){
  if (!s) return null;
  const m = String(s).match(/\b\d+(?:[\s,]\d{3})+\b|\b\d+(?:\.\d+)?\s*[KMB]\b|\b\d+\b/i);
  return m ? m[0] : null;
}

// ---------- ytInitialData extraction (balanced object) ----------
function extractJSONAfter(html, marker){
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0, inStr = false, q = "", prev = "";
  for (let j=start; j<html.length; j++){
    const c = html[j];
    if (inStr){
      if (c === q && prev !== "\\") inStr = false;
      prev = c; continue;
    }
    if (c === '"' || c === "'"){ inStr = true; q = c; prev = c; continue; }
    if (c === "{") depth++;
    else if (c === "}"){
      depth--;
      if (depth === 0) return html.slice(start, j+1);
    }
    prev = c;
  }
  return null;
}
function getYtInitialData(html){
  const markers = [
    "var ytInitialData = ",
    "window[\"ytInitialData\"] = ",
    "window['ytInitialData'] = ",
    "\"ytInitialData\":"
  ];
  for (const m of markers){
    const txt = extractJSONAfter(html, m);
    if (txt){
      try { return JSON.parse(txt); } catch { /* try next */ }
    }
  }
  return null;
}

// ---------- deep search helpers ----------
function deepFind(node, predicate){
  const stack = [node];
  while (stack.length){
    const cur = stack.pop();
    if (cur && typeof cur === "object"){
      if (predicate(cur)) return cur;
      for (const k in cur){
        const v = cur[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return null;
}
function getCountsFromInitialData(data){
  let subs = null, views = null, videos = null;

  // Prefer header renderer if present
  const header =
    data?.header?.c4TabbedHeaderRenderer ||
    data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.c4TabbedHeaderRenderer;

  if (header){
    subs   = subs   ?? parseCountToken(firstNumberToken(textFrom(header.subscriberCountText)));
    videos = videos ?? parseCountToken(firstNumberToken(textFrom(header.videosCountText || header.videoCountText)));
  }

  // About renderer for lifetime views (and sometimes videos)
  const about = deepFind(data, x => x.channelAboutFullMetadataRenderer);
  if (about?.channelAboutFullMetadataRenderer){
    const ar = about.channelAboutFullMetadataRenderer;
    views  = views  ?? parseCountToken(firstNumberToken(textFrom(ar.viewCountText)));
    videos = videos ?? parseCountToken(firstNumberToken(textFrom(ar.videosCountText || ar.videoCountText)));
  }

  // Fallback: if still missing, grab first sensible fields anywhere
  if (subs == null){
    const anyWithSubs = deepFind(data, x => x.subscriberCountText);
    subs = anyWithSubs ? parseCountToken(firstNumberToken(textFrom(anyWithSubs.subscriberCountText))) : null;
  }
  if (videos == null){
    const anyWithVideos = deepFind(data, x => x.videosCountText || x.videoCountText);
    videos = anyWithVideos ? parseCountToken(firstNumberToken(textFrom(anyWithVideos.videosCountText || anyWithVideos.videoCountText))) : null;
  }
  if (views == null){
    const anyWithViews = deepFind(data, x => x.viewCountText && /views/i.test(textFrom(x.viewCountText)||""));
    views = anyWithViews ? parseCountToken(firstNumberToken(textFrom(anyWithViews.viewCountText))) : null;
  }

  return { subs, views, videos };
}

// ---------- plain-text fallback ----------
function htmlToText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function numberBeforeLabel(text, label, allowSuffix=true){
  const num = allowSuffix
    ? "(?:\\d+(?:\\.\\d+)?\\s*[KMB]|\\d{1,3}(?:[\\s,]\\d{3})+|\\d+)"
    : "(?:\\d{1,3}(?:[\\s,]\\d{3})+|\\d+)";
  const re = new RegExp(`\\b(${num})\\s+${label}\\b`, "i");
  const m = text.match(re);
  return m ? parseCountToken(m[1]) : null;
}

// ---------- parse one channel from /about ----------
async function fetchChannelFromAbout(input){
  for (let attempt=1; attempt<=2; attempt++){
    const html = await fetchHTML(aboutUrl(input, Date.now()+attempt));
    const basics = extractBasics(html);

    // ensure the page matches the input (prevents cross-channel caching)
    if (!inputMatchesPage(input, basics)){
      if (attempt === 1){ await sleep(500); continue; }
      return {
        title: basics.title || (isHandle(input)?input:(isId(input)?input:"Channel")),
        pfp: basics.pfp || "",
        handle: basics.handle || (isHandle(input)?input:""),
        id: basics.id || (isId(input)?input:""),
        verified: !!basics.verified,
        subs: null, views: null, videos: null
      };
    }

    // 1) Try ytInitialData JSON
    const data = getYtInitialData(html);
    let subs = null, views = null, videos = null;
    if (data){
      ({ subs, views, videos } = getCountsFromInitialData(data));
    }

    // 2) Fallback to plain text patterns if needed
    if (subs == null || views == null || videos == null){
      const text = htmlToText(html);
      subs  = subs  ?? numberBeforeLabel(text, "subscribers", true);
      views = views ?? numberBeforeLabel(text, "views",       true);
      let vids = videos ?? numberBeforeLabel(text, "videos", false);
      if (vids == null) vids = numberBeforeLabel(text, "videos", true);
      // sanity for videos
      if (vids != null){
        if ((subs && vids === subs) || (views && vids === views) || vids > 1_000_000) vids = null;
      }
      videos = videos ?? vids;
    }

    return { ...basics, subs, views, videos };
  }
  // should not reach
  return { title:"", pfp:"", handle:isHandle(input)?input:"", id:isId(input)?input:"", verified:false, subs:null, views:null, videos:null };
}

// ---------- main ----------
async function main(){
  const raw = JSON.parse(await fs.readFile(channelsPath,"utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i=0;i<inputs.length;i++){
    const item = inputs[i];
    if (i>0) await sleep(700 + Math.random()*400);

    try{
      const m = await fetchChannelFromAbout(item);
      rows.push({
        input: item,
        id: m.id || (isId(item)?item:null),
        handle: m.handle || (isHandle(item)?item:""),
        title: m.title || m.handle || m.id || "Channel",
        pfp: m.pfp || "",
        verified: !!m.verified,
        subs: m.subs ?? null,
        videos: m.videos ?? null,
        views: m.views ?? null,
        hiddenSubs: m.subs == null
      });
      console.log(`[${i+1}/${inputs.length}] ${rows.at(-1).title} — subs:${m.subs ?? "—"} videos:${m.videos ?? "—"} views:${m.views ?? "—"}`);
    }catch(e){
      console.error(`Failed for ${item}:`, e.message);
      rows.push({
        input: item,
        id: isId(item)?item:null,
        handle: isHandle(item)?item:"",
        title: isHandle(item)?item:(isId(item)?item:"Channel"),
        pfp:"",
        verified:false,
        subs:null, videos:null, views:null,
        hiddenSubs:true
      });
    }
  }

  rows.sort((a,b)=> (a.title||a.handle||a.id||"").localeCompare(b.title||b.handle||b.id||"", undefined, {sensitivity:"base"}));

  await fs.mkdir(outDir,{recursive:true});
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2), "utf8");
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
