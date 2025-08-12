// Minimal, fast, pretty. Only shows channels (+ verified badge).
const $grid = document.getElementById("grid");
const $empty = document.getElementById("empty");
const $search = document.getElementById("search");
const $sort = document.getElementById("sort");
const $updated = document.getElementById("updated");

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
  const pfp = c.pfp || "https://i.stack.imgur.com/l60Hf.png"; // tiny fallback
  const badge = c.verified ? verifiedSVG : "";
  return `
    <li class="card" tabindex="0">
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

$search.addEventListener("input", applyFilter);
$sort.addEventListener("click", () => {
  sortAZ = !sortAZ;
  $sort.textContent = sortAZ ? "A → Z" : "Z → A";
  render(filtered);
});

boot();
