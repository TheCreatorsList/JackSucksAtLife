// Minimal, fast, pretty. Only shows channels.
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

function cardHTML(c) {
  const title = c.title || c.handle || c.id || "Channel";
  const handle = c.handle || "";
  const pfp = c.pfp || "https://i.stack.imgur.com/l60Hf.png"; // tiny fallback
  return `
    <li class="card" tabindex="0">
      <a href="${linkFor(c)}" target="_blank" rel="noopener" class="link" aria-label="${title}">
        <img class="pfp" loading="lazy" decoding="async" src="${pfp}" alt="${title} profile picture">
        <div class="meta">
          <div class="title" title="${title}">${title}</div>
          <div class="handle">${handle}</div>
        </div>
      </a>
    </li>
  `;
}

function render(list) {
  // sort
  list.sort((a, b) => {
    const A = (a.title || a.handle || a.id || "").toLowerCase();
    const B = (b.title || b.handle || b.id || "").toLowerCase();
    return sortAZ ? A.localeCompare(B) : B.localeCompare(A);
  });

  // draw
  $grid.innerHTML = list.map(cardHTML).join("");

  // empty state
  $empty.hidden = list.length > 0;

  // reveal animation
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

    // show timestamp
    const t = json.generatedAt ? new Date(json.generatedAt) : null;
    $updated.textContent = t ? `Last update: ${t.toLocaleString()}` : "";

    render(filtered);
  } catch (e) {
    $updated.textContent = "Could not load data.json";
    console.error(e);
  }
}

// events
$search.addEventListener("input", applyFilter);
$sort.addEventListener("click", () => {
  sortAZ = !sortAZ;
  $sort.textContent = sortAZ ? "A → Z" : "Z → A";
  render(filtered);
});

boot();
