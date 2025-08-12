// scripts/fetch.js — YouTube-first (no API), SocialBlade fallback.
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
const isId = x => /^UC[A-Za-z0-9_-]{22}$/.test(x);

const ytAboutUrl = input => {
  const base = input.startsWith("@")
    ? `https://www.youtube.com/${input}/about`
    : `https://www.youtube.com/channel/${input}/about`;
  return `${base}?hl=en&gl=US&persist_hl=1&persist_gl=1`;
};
const sbRealtimeUrl = input => {
  if (input.startsWith("@")) return `https://socialblade.com/youtube/handle/${input.slice(1)}/realtime`;
  if (isId(input)) return `https://socialblade.com/youtube/channel/${input}/realtime`;
  return `https://socialblade.com/youtube/handle/${input.replace(/^@/,"")}/realtime`;
};

async function fetchHTML(url, extra={}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept-language": LANG,
      "accept": "text/html,*/*",
      // avoids EU consent interstitial on YouTube server-side
      "cookie": "CONSENT=YES+1",
      ...extra
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}
const ex = (html, re) => (html.match(re) || [])[1] || null;

function parseCount(s) {
  if (!s) return null;
  const t = String(s).replace(/[,\s]/g, "").toUpperCase(); // remove spaces+commas
  const m = t.match(/^([\d.]+)([KMB])?$/) || t.match(/^(\d{1,15})$/);
  if (!m) return null;
  const n = parseFloat(m[1]); const suf = m[2];
  if (suf === "K") return Math.round(n * 1_000);
  if (suf === "M") return Math.round(n * 1_000_000);
  if (suf === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

/* ---------- YouTube parse (title, pfp, id, handle, counts) ---------- */
function parseYouTube(html){
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

  // counts often available on About page JSON
  const subsTxt =
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    ex(html, /"subscriberCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const subs = subsTxt ? parseCount(subsTxt.replace(/[^0-9KMB.,]/gi,"")) : null;

  const vidsTxt =
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    ex(html, /"videoCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const videos = vidsTxt ? parseCount(vidsTxt.replace(/[^0-9KMB.,]/gi,"")) : null;

  const viewsTxt =
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+?)"\s*\}/) ||
    ex(html, /"viewCountText"\s*:\s*\{[^}]*"runs"\s*:\s*\[\s*\{[^}]*"text"\s*:\s*"([^"]+?)"/);
  const views = viewsTxt ? parseCount(viewsTxt.replace(/[^0-9KMB.,]/gi,"")) : null;

  return { title, pfp, handle, id, subs, videos, views };
}

async function getYouTube(input, attempt=1){
  try {
    const html = await fetchHTML(ytAboutUrl(input));
    return parseYouTube(html);
  } catch (e) {
    if (attempt < 3) { await sleep(800*attempt); return getYouTube(input, attempt+1); }
    return { title:"", pfp:"", handle: input.startsWith("@")?input:"", id: isId(input)?input:null, subs:null, videos:null, views:null, error:String(e) };
  }
}

/* ---------- Social Blade fallback (subs/views/videos) ---------- */
function nearestNumberAfter(html, label){
  const i = html.toLowerCase().indexOf(label);
  if (i < 0) return null;
  const slice = html.slice(i, i+800);
  const candidates = slice.match(/(\d[\d\s,\.]*\s*[KMB]?)/gi) || [];
  for (const c of candidates){
    const n = parseCount(c);
    if (n != null) return n;
  }
  return null;
}
async function getSB(input, attempt=1){
  try{
    const html = await fetchHTML(sbRealtimeUrl(input), { referer: "https://socialblade.com/" });
    return {
      subs:  nearestNumberAfter(html, "subscribers"),
      views: nearestNumberAfter(html, "views"),
      videos:nearestNumberAfter(html, "videos")
    };
  }catch(e){
    if (attempt < 3) { await sleep(1000*attempt); return getSB(input, attempt+1); }
    return { subs:null, views:null, videos:null, error:String(e) };
  }
}

/* ---------- Main ---------- */
async function main(){
  const list = JSON.parse(await fs.readFile(channelsPath, "utf8")).map(s=>s.trim()).filter(Boolean);
  const unique = Array.from(new Set(list));
  const out = [];

  for (let i=0;i<unique.length;i++){
    const item = unique[i];
    if (i>0) await sleep(700 + Math.random()*400);

    const yt = await getYouTube(item);
    let subs = yt.subs, views = yt.views, videos = yt.videos;

    if (subs == null || views == null || videos == null) {
      const sb = await getSB(yt.handle || yt.id || item);
      subs   = subs   ?? sb.subs;
      views  = views  ?? sb.views;
      videos = videos ?? sb.videos;
    }

    const row = {
      input: item,
      id: yt.id || (isId(item)?item:null),
      handle: yt.handle || (item.startsWith("@") ? item : ""),
      title: yt.title || "",
      pfp: yt.pfp || "",
      subs, views, videos,
      hiddenSubs: subs == null
    };
    out.push(row);
    console.log(`[${i+1}/${unique.length}] ${row.title || row.handle || row.id} — subs:${subs ?? "?"} views:${views ?? "?"} vids:${videos ?? "?"}`);
  }

  out.sort((a,b)=> (b.subs??-1)-(a.subs??-1) || (a.title||"").localeCompare(b.title||""));
  await fs.mkdir(outDir, { recursive:true });
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), channels: out }, null, 2), "utf8");
  console.log(`Wrote ${out.length} channels → ${path.relative(process.cwd(), outFile)}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
