// scripts/fetch.js
// Fetch channel info + subs and write to web/data.json
// Requires env: YT_API_KEY (set in GitHub repo → Settings → Secrets → Actions)

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.YT_API_KEY;
if (!API_KEY) {
  console.error("Missing YT_API_KEY env var.");
  process.exit(1);
}

const channelsPath = path.join(__dirname, "..", "channels.json");
const outDir = path.join(__dirname, "..", "web");
const outFile = path.join(outDir, "data.json");

// Resolve IDs or handles to IDs, then fetch stats+pfp in batches
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function resolveToIds(list) {
  const ids = [];
  const handles = [];

  for (const entry of list) {
    if (entry.startsWith("@")) handles.push(entry.slice(1));
    else ids.push(entry);
  }

  // Resolve handles -> channel IDs using search?  Better via "channels?forHandle"
  // (YouTube Data API v3 supports forHandle with part=snippet)
  if (handles.length) {
    const chunk = async (arr, n) => {
      for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
    };
    for await (const hs of chunk(handles, 40)) {
      const url =
        "https://www.googleapis.com/youtube/v3/channels" +
        `?part=snippet&forHandle=${encodeURIComponent(hs.join(","))}&key=${API_KEY}`;
      const data = await fetchJSON(url);
      for (const ch of data.items || []) {
        ids.push(ch.id);
      }
    }
  }
  return ids;
}

async function fetchChannelChunks(ids) {
  const results = [];
  // channels.list max 50 IDs per call
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url =
      "https://www.googleapis.com/youtube/v3/channels" +
      `?part=snippet,statistics&id=${batch.join(",")}&key=${API_KEY}`;
    const data = await fetchJSON(url);
    for (const item of data.items || []) {
      const { id, snippet, statistics } = item;
      results.push({
        id,
        title: snippet?.title ?? "",
        handle: snippet?.customUrl?.startsWith("@") ? snippet.customUrl : "",
        pfp: snippet?.thumbnails?.high?.url ||
             snippet?.thumbnails?.medium?.url ||
             snippet?.thumbnails?.default?.url ||
             "",
        subs: Number(statistics?.subscriberCount ?? 0),
        videos: Number(statistics?.videoCount ?? 0),
        views: Number(statistics?.viewCount ?? 0),
        hiddenSubs: statistics?.hiddenSubscriberCount === true
      });
    }
  }
  return results;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(channelsPath, "utf8"));
  const ids = await resolveToIds(raw);
  const data = await fetchChannelChunks(ids);

  // Sort by subs desc
  data.sort((a, b) => (b.subs || 0) - (a.subs || 0));

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), channels: data }, null, 2),
    "utf8"
  );

  console.log(`Wrote ${data.length} channels → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

