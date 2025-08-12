// Channel directory with verified badge + on-click stats modal (no API key).
const $grid = document.getElementById("grid");
const $empty = document.getElementById("empty");
const $search = document.getElementById("search");
const $sort = document.getElementById("sort");
const $updated = document.getElementById("updated");

// Modal refs
const $modal = document.getElementById("modal");
const $mClose = document.getElementById("m-close");
const $mTitle = document.getElementById("m-title");
const $mHandle = document.getElementById("m-handle");
const $mPfp = document.getElementById("m-pfp");
const $mSubs = document.getElementById("m-subs");
const $mVideos = document.getElementById("m-videos");
const $mViews = document.getElementById("m-views");
const $mLink = document.getElementById("m-link");

let channels = [];
let filtered = [];
let sortAZ = true;

function linkFor(c) {
  if (c.id) return `https://www.youtube.com/channel/${c.id}`;
  if (c.handle) return `https://www.youtube.com/${c.handle.replace(/^\s*@/, "@")}`;
  return "#";
}

const verifiedSVG =
  '<svg class="badge" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.39 2.39 3.38-.54 1.17 3.26 3.06 1.76-1.76 3.06.54 3.38-3.26 1.17-1.76 3.06-3.38-.54L12 22l-2.39-2.39-3.38.54-1.17-3.26L2 14.87l1.76-3.06-.54-3.38 3.26-1.17 1.76-3.06 3.38.54L12 2zm-1.2 12.6l5-5-1.4-1.4-3.6 3.6-1.6-1.6-1.4 1.4 3 3z"></path></svg>';

function cardHTML(c) {
  const title = c.title || c.handle || c.id || "Channel";
  const handle = c.handle || "";
  const pfp = c.pfp || "https://i.stack.imgur.com/l60Hf.png";
  const badge = c.verified ? verifiedSVG : "";
  const dataAttrs = [
    `data-id="${c.id || ""}"`,
    `data-handle="${(c.handle || "").replace(/"/g, "&quot;")}"`,
    `data-title="${(title || "").replace(/"/g, "&quot;")}"`,
    `data-pfp="${pfp}"`
  ].join(" ");
  return `
    <li class="card" tabindex="0" ${dataAttrs}>
      <a href="${linkFor(c)}" target="_blank" rel="noopener" class="link" aria-label="${title}">
        <img class="pfp" loading="lazy" decoding="async" src="${pfp}" alt="${title} profile picture">
        <div class="meta">
          <div class="title" title="${title}">${title}${badge}</div>
          <div class="handle">${handle}</div>
        </div>
      </a>
    </li>
  `;
}

function render(list) {
  list.sort((a, b) => {
    const A = (a.title || a.handle || a.id || "").toLowerCase();
    const B = (b.title || b.handle || b.id || "").toLowerCase();
    return sortAZ ? A.localeCompare(B) : B.localeCompare(A);
  });
  $grid.innerHTML = list.map(cardHTML).join("");
  $empty.hidden = list.length > 0;

  // Reveal anim
  const obs = "IntersectionObserver" in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); }
        }
      }, { rootMargin: "80px" })
    : null;
  if (obs) document.querySelectorAll(".card").forEach(el => obs.observe(el));
}

function applyFilter() {
  const q = $search.value.trim().toLowerCase();
  filtered = !q
    ? [...channels]
    : channels.filter(c =>
        (c.title || "").toLowerCase().includes(q) ||
        (c.handle || "").toLowerCase().includes(q)
      );
  render(filtered);
}

async function boot() {
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    const json = await res.json();
    channels = json.channels || [];
    filtered = [...channels];
    const t = json.generatedAt ? new Date(json.generatedAt) : null;
    $updated.textContent = t ? `Last update: ${t.toLocaleString()}` : "";
    render(filtered);
  } catch (e) {
    $updated.textContent = "Could not load data.json";
    console.error(e);
  }
}

// ---------- Modal behavior ----------
function openModal() { $modal.hidden = false; document.body.style.overflow = "hidden"; }
function closeModal() { $modal.hidden = true; document.body.style.overflow = ""; }
$mClose.addEventListener("click", closeModal);
$modal.addEventListener("click", (e) => { if (e.target === $modal) closeModal(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$modal.hidden) closeModal(); });

function fmt(n) {
  if (n == null) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1_000_000_000) return (x/1_000_000_000).toFixed(2) + "B";
  if (x >= 1_000_000) return (x/1_000_000).toFixed(2) + "M";
  if (x >= 1_000) return (x/1_000).toFixed(1) + "K";
  return x.toLocaleString();
}

async function fetchStatsFor(c) {
  // Try Lemnos (no-key) – has CORS and is browser-friendly
  const idOrHandle = c.id ? `id=${c.id}` : `forHandle=${encodeURIComponent((c.handle || "").replace(/^@/, ""))}`;
  const url = `https://yt.lemnoslife.com/noKey/channels?part=snippet,statistics&${idOrHandle}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("stats fetch failed");
  const j = await r.json();
  const item = j?.items?.[0];
  if (!item) throw new Error("no stats item");
  const s = item.statistics || {};
  return {
    subs: s.hiddenSubscriberCount ? null : (s.subscriberCount ? Number(s.subscriberCount) : null),
    videos: s.videoCount ? Number(s.videoCount) : null,
    views: s.viewCount ? Number(s.viewCount) : null
  };
}

async function showDetailsFromCard(li) {
  const title = li.dataset.title || "Channel";
  const handle = li.dataset.handle || "";
  const id = li.dataset.id || "";
  const pfp = li.dataset.pfp || "";

  // Fill basic info immediately
  $mTitle.textContent = title;
  $mHandle.textContent = handle || id || "";
  $mPfp.src = pfp;
  $mPfp.alt = `${title} profile picture`;
  $mSubs.textContent = "…";
  $mVideos.textContent = "…";
  $mViews.textContent = "…";
  $mLink.href = id ? `https://www.youtube.com/channel/${id}` :
              handle ? `https://www.youtube.com/${handle.replace(/^\s*@/,"@")}` : "#";

  openModal();

  try {
    const stats = await fetchStatsFor({ id, handle });
    $mSubs.textContent = fmt(stats.subs);
    $mVideos.textContent = fmt(stats.videos);
    $mViews.textContent = fmt(stats.views);
  } catch (e) {
    console.warn("Stats fetch failed:", e);
    $mSubs.textContent = "—";
    $mVideos.textContent = "—";
    $mViews.textContent = "—";
  }
}

// Event delegation: click a card -> modal.
// Hold Cmd/Ctrl to open YouTube instead (default link).
$grid.addEventListener("click", (e) => {
  const a = e.target.closest("a.link");
  const li = e.target.closest("li.card");
  if (!li || !a) return;
  if (e.metaKey || e.ctrlKey) return; // let modified-click open link
  e.preventDefault();
  showDetailsFromCard(li);
});

$search.addEventListener("input", applyFilter);
$sort.addEventListener("click", () => {
  sortAZ = !sortAZ;
  $sort.textContent = sortAZ ? "A → Z" : "Z → A";
  render(filtered);
});

boot();
