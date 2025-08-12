(async function () {
  const res = await fetch("./data.json", { cache: "no-store" });
  const { generatedAt, channels } = await res.json();

  const gen = document.getElementById("generatedAt");
  gen.textContent = new Date(generatedAt).toLocaleString();

  const tbody = document.querySelector("#tbl tbody");
  const search = document.getElementById("search");

  function fmt(n) {
    if (n == null) return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    if (x >= 1_000_000_000) return (x / 1_000_000_000).toFixed(2) + "B";
    if (x >= 1_000_000) return (x / 1_000_000).toFixed(2) + "M";
    if (x >= 1_000) return (x / 1_000).toFixed(1) + "K";
    return x.toLocaleString();
  }

  let current = [...channels];
  let sortKey = "subs";
  let sortDir = -1;

  function render() {
    tbody.innerHTML = "";
    for (const c of current) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <a class="chan" href="https://www.youtube.com/${c.id ? "channel/" + c.id : c.handle}" target="_blank" rel="noopener">
            <img class="pfp" src="${c.pfp || ""}" alt="${c.title || c.handle || c.id || "channel"} pfp" />
            <div class="meta">
              <div class="title">${c.title || "Unknown"}</div>
              <div class="handle">${c.handle || ""}</div>
            </div>
          </a>
        </td>
        <td>${c.hiddenSubs ? "Hidden" : fmt(c.subs)}</td>
        <td>${fmt(c.videos)}</td>
        <td>${fmt(c.views)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function applySort() {
    current.sort((a, b) => {
      const va = sortKey === "name" ? (a.title || "").toLowerCase() : a[sortKey] ?? -1;
      const vb = sortKey === "name" ? (b.title || "").toLowerCase() : b[sortKey] ?? -1;
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
  }

  function applyFilter(q) {
    const s = q.trim().toLowerCase();
    current = channels.filter(c =>
      (c.title || "").toLowerCase().includes(s) ||
      (c.handle || "").toLowerCase().includes(s)
    );
  }

  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (key === sortKey) sortDir *= -1;
      else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
      applySort(); render();
    });
  });

  search.addEventListener("input", (e) => { applyFilter(e.target.value); applySort(); render(); });

  applyFilter(""); applySort(); render();
})();
