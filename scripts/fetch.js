// scripts/fetch.js
// Read subs, videos, views from the exact "NUMBER label" patterns on YouTube /about.
// Example lines: "149K subscribers", "182 videos", "6,029,816 views".
// No API keys, no Social Blade.

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

// ----- helpers -----
function normalizeInput(s){
  const t=(s||"").trim();
  if (!/^https?:\/\//i.test(t)) return t;
  try{
    const u=new URL(t);
    const mId=u.pathname.match(/\/channel\/([A-Za-z0-9_-]{24})/); if (mId) return mId[1];
    const mH =u.pathname.match(/\/@([^/?#]+)/);                 if (mH) return "@"+mH[1];
    return t;
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
  return url.toString();
}
const ytAboutUrl = x => withHLGL(ytBase(x) + "/about");

async function fetchHTML(url){
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      cookie: "CONSENT=YES+1" // bypass consent wall server-side
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function htmlToText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse "12.3K", "45,203,487", "182"
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

// Grab the number right BEFORE a label (e.g., /(\d…)\s+subscribers/i)
function numberBeforeLabel(text, label, allowSuffix=true){
  // number can be: 12.3K, 1 234 567, 1,234,567, or plain 123
  const num =
    allowSuffix
      ? "(?:\\d+(?:\\.\\d+)?\\s*[KMB]|\\d{1,3}(?:[\\s,]\\d{3})+|\\d+)"
      : "(?:\\d{1,3}(?:[\\s,]\\d{3})+|\\d+)";
  const re = new RegExp(`\\b(${num})\\s+${label}\\b`, "i");
  const m = text.match(re);
  return m ? parseCountToken(m[1]) : null;
}

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

// ----- parse one channel strictly from /about text -----
async function parseAbout(input){
  const html = await fetchHTML(ytAboutUrl(input));
  const text = htmlToText(html);
  const basics = extractBasics(html);

  // EXACT patterns: "<number> subscribers", "<number> videos", "<number> views"
  const subs  = numberBeforeLabel(text, "subscribers", true);
  const views = numberBeforeLabel(text, "views", true);
  // videos generally not K/M/B, but allow just in case
  let videos  = numberBeforeLabel(text, "videos", false) ?? numberBeforeLabel(text, "videos", true);

  // sanity: videos shouldn't match subs/views; cap uploads to sensible range
  if (videos != null) {
    if ((subs && videos === subs) || (views && videos === views)) videos = null;
    if (videos > 1_000_000) videos = null;
  }

  return { ...basics, subs, views, videos };
}

// ----- main build -----
async function main(){
  const raw = JSON.parse(await fs.readFile(channelsPath,"utf8"));
  const inputs = Array.from(new Set(raw.map(normalizeInput).filter(Boolean)));

  const rows = [];
  for (let i=0;i<inputs.length;i++){
    const item = inputs[i];
    if (i>0) await sleep(600 + Math.random()*400);

    try{
      const m = await parseAbout(item);
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

  await fs.mkdir(outDir, { recursive:true });
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: rows }, null, 2), "utf8");
  console.log(`Wrote ${rows.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
