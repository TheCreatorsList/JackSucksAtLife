// scripts/fetch.js
// No API keys. Pull title + pfp from YouTube About page,
// and subs/views/videos from Social Blade's realtime page.

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

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function isId(x){ return /^UC[A-Za-z0-9_-]{22}$/.test(x); }

function ytAboutUrl(input){
  const base = input.startsWith("@")
    ? `https://www.youtube.com/${input}/about`
    : `https://www.youtube.com/channel/${input}/about`;
  // Force EN/US and try to skip consent wall
  return `${base}?hl=en&gl=US&persist_hl=1&persist_gl=1`;
}

function sbRealtimeUrl(input){
  if (input.startsWith("@")) return `https://socialblade.com/youtube/handle/${input.slice(1)}/realtime`;
  if (isId(input)) return `https://socialblade.com/youtube/channel/${input}/realtime`;
  // if user pasted a full https URL, try to normalize
  return input.includes("/channel/")
    ? `https://socialblade.com/youtube/channel/${input.split("/channel/")[1].split(/[/?#]/)[0]}/realtime`
    : `https://socialblade.com/youtube/handle/${input.replace(/^@/,"")}/realtime`;
}

async function fetchHTML(url, extraHeaders = {}){
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      // Helps avoid YouTube consent wall server-side:
      "cookie": "CONSENT=YES+1",
      ...extraHeaders
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

function parseCount(str){
  if (!str) return null;
  const s = String(str).replace(/[, ]+/g,"").toUpperCase();
  const m = s.match(/^([\d.]+)([KMB])?$/) || s.match(/^(\d{4,})$/); // allow plain big ints
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suf = m[2];
  if (suf === "K") return Math.round(n * 1_000);
  if (suf === "M") return Math.round(n * 1_000_000);
  if (suf === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

/* ---------------- YouTube meta (title & pfp & stable IDs) ---------------- */
function extract(html, re){ const m = html.match(re); return m ? m[1] : null; }

function parseYouTubeMeta(html){
  const title =
    extract(html, /<meta property="og:title" content="([^"]+)"/) ||
    extract(html, /"title"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/) ||
    "";

  const pfp =
    extract(html, /<link rel="image_src" href="([^"]+)"/) ||
    extract(html, /"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/) ||
    "";

  const handle =
    extract(html, /"canonicalChannelUrl"\s*:\s*"\/(@[^"]+)"/) ||
    extract(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"\/]+)\/?"/) ||
    "";

  const id =
    extract(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{24})/);

  return { title, pfp, handle, id };
}

async function getYouTubeMeta(input, attempt=1){
  try{
    const html = await fetchHTML(ytAboutUrl(input));
    return parseYouTubeMeta(html);
  }catch(e){
    if (attempt < 3){ await sleep(1000*attempt); return getYouTubeMeta(input, attempt+1); }
    return { title:"", pfp:"", handle: input.startsWith("@") ? input : "", id: isId(input) ? input : null, error: String(e) };
  }
}

/* ---------------- Social Blade realtime (subs/views/videos) ---------------- */
function nearestNumberAfter(html, label){
  const i = html.toLowerCase().indexOf(label);
  if (i < 0) return null;
  const slice = html.slice(i, i+800); // look a bit ahead
  // collect candidates like 4.62M / 1,110,686,437 / 1 110 686 437 etc.
  const candidates = slice.match(/(\d[\d\s,\.]*\s*[KMB]?)/gi) || [];
  // normalize spaces in digit groups
  const cleaned = candidates.map(s => s.replace(/\s+(?=\d)/g, ""));
  // pick the first that parses into a reasonable number
  for (const c of cleaned){
    const n = parseCount(c);
    if (n != null) return n;
  }
  return null;
}

async function getSBStats(input, attempt=1){
  try{
    const html = await fetchHTML(sbRealtimeUrl(input), { referer: "https://socialblade.com/" });
    const subs  = nearestNumberAfter(html, "subscribers");
    const views = nearestNumberAfter(html, "views");
    const videos= nearestNumberAfter(html, "videos");
    return { subs, views, videos };
  }catch(e){
    if (attempt < 3){ await sleep(1000*attempt); return getSBStats(input, attempt+1); }
    return { subs:null, views:null, videos:null, error: String(e) };
  }
}

/* ---------------- Main ---------------- */
async function main(){
  const inputList = JSON.parse(await fs.readFile(channelsPath, "utf8"))
    .map(s => s.trim()).filter(Boolean);
  const unique = Array.from(new Set(inputList));

  const out = [];
  for (let i=0;i<unique.length;i++){
    const item = unique[i];
    if (i>0) await sleep(700 + Math.random()*400); // be polite
    const yt = await getYouTubeMeta(item);
    const sb = await getSBStats(yt.handle || (isId(item) ? item : item));
    const row = {
      input: item,
      id: yt.id || (isId(item) ? item : null),
      handle: yt.handle || (item.startsWith("@") ? item : ""),
      title: yt.title || "",
      pfp: yt.pfp || "",
      subs: sb.subs,
      views: sb.views,
      videos: sb.videos,
      hiddenSubs: sb.subs == null // if SB couldn't get it, treat as hidden/unknown
    };
    out.push(row);
    console.log(`[${i+1}/${unique.length}] ${row.title || row.handle || row.id || item} — subs:${row.subs ?? "?"} views:${row.views ?? "?"} vids:${row.videos ?? "?"}`);
  }

  // Sort by subs (desc), then title
  out.sort((a,b)=> (b.subs??-1)-(a.subs??-1) || (a.title||"").localeCompare(b.title||""));

  await fs.mkdir(outDir, {recursive:true});
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: out }, null, 2), "utf8");
  console.log(`Wrote ${out.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
