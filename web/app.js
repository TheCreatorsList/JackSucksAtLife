// 1
(function () {
  const $ = (id)=>document.getElementById(id);
  const $grid=$("grid"), $empty=$("empty"), $search=$("search"), $sort=$("sort"), $updated=$("updated");
  const $modal=$("modal"), $mClose=$("m-close"), $mTitle=$("m-title"), $mHandle=$("m-handle");
  const $mPfp=$("m-pfp"), $mSubs=$("m-subs"), $mVideos=$("m-videos"), $mViews=$("m-views"), $mLink=$("m-link");

  if ($modal) $modal.hidden = true;

  let channels=[]; let filtered=[]; let sortAZ=true;

  function linkFor(c){ return c.id ? `https://www.youtube.com/channel/${c.id}` :
                       c.handle ? `https://www.youtube.com/${c.handle.replace(/^\s*@/,"@")}` : "#"; }

  const verifiedSVG = '<svg class="badge" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.39 2.39 3.38-.54 1.17 3.26 3.06 1.76-1.76 3.06.54 3.38-3.26 1.17-1.76 3.06-3.38-.54L12 22l-2.39-2.39-3.38.54-1.17-3.26L2 14.87l1.76-3.06-.54-3.38 3.26-1.17 1.76-3.06 3.38.54L12 2zm-1.2 12.6l5-5-1.4-1.4-3.6 3.6-1.6-1.6-1.4 1.4 3 3z"></path></svg>';

  function cardHTML(c){
    const title=c.title||c.handle||c.id||"Channel";
    const handle=c.handle||"";
    const pfp=c.pfp||"https://i.stack.imgur.com/l60Hf.png";
    const badge=c.verified?verifiedSVG:"";
    const dataAttrs=[
      `data-id="${c.id||""}"`,
      `data-handle="${(handle||"").replace(/"/g,"&quot;")}"`,
      `data-title="${(title||"").replace(/"/g,"&quot;")}"`,
      `data-pfp="${pfp}"`,
      `data-subs="${c.subs ?? ""}"`,
      `data-views="${c.views ?? ""}"`,
      `data-videos="${c.videos ?? ""}"`
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
      </li>`;
  }

  function render(list){
    if (!$grid) return;
    list.sort((a,b)=> {
      const A=(a.title||a.handle||a.id||"").toLowerCase();
      const B=(b.title||b.handle||b.id||"").toLowerCase();
      return sortAZ ? A.localeCompare(B) : B.localeCompare(A);
    });
    $grid.innerHTML = list.map(cardHTML).join("");
    if ($empty) $empty.hidden = list.length>0;

    if ("IntersectionObserver" in window){
      const obs=new IntersectionObserver(es=>{ for(const e of es){ if(e.isIntersecting){ e.target.classList.add("in"); obs.unobserve(e.target);} } },{rootMargin:"80px"});
      document.querySelectorAll(".card").forEach(el=>obs.observe(el));
    }
  }

  function applyFilter(){
    const q=($search?.value||"").trim().toLowerCase();
    filtered = !q ? [...channels] : channels.filter(c =>
      (c.title||"").toLowerCase().includes(q) || (c.handle||"").toLowerCase().includes(q));
    render(filtered);
  }

  function fmt(n){
    if (n==null || n==="") return "—";
    const x=Number(n); if(!Number.isFinite(x)) return "—";
    if (x>=1e9) return (x/1e9).toFixed(2)+"B";
    if (x>=1e6) return (x/1e6).toFixed(2)+"M";
    if (x>=1e3) return (x/1e3).toFixed(1)+"K";
    return x.toLocaleString();
  }

  function openModal(){ if ($modal){ $modal.hidden=false; document.body.style.overflow="hidden"; } }
  function closeModal(){ if ($modal){ $modal.hidden=true; document.body.style.overflow=""; } }

  if ($modal){
    $modal.addEventListener("click", e=>{ if (e.target===$modal) closeModal(); });
    const $mClose=$("m-close"); $mClose && $mClose.addEventListener("click", closeModal);
    window.addEventListener("keydown", e=>{ if(e.key==="Escape" && !$modal.hidden) closeModal(); });
  }

  $grid && $grid.addEventListener("click", (e)=>{
    const a=e.target.closest?.("a.link");
    const li=e.target.closest?.("li.card");
    if (!li || !a) return;
    if (e.metaKey||e.ctrlKey) return; 
    e.preventDefault();

    const title=li.dataset.title || "Channel";
    const handle=li.dataset.handle || "";
    const id=li.dataset.id || "";
    const pfp=li.dataset.pfp || "";
    const subs=li.dataset.subs || "";
    const views=li.dataset.views || "";
    const videos=li.dataset.videos || "";

    $("m-title").textContent = title;
    $("m-handle").textContent = handle || id || "";
    const img=$("m-pfp"); img.src = pfp; img.alt = `${title} profile picture`;
    $("m-subs").textContent   = fmt(subs);
    $("m-views").textContent  = fmt(views);
    $("m-videos").textContent = fmt(videos);
    const link=$("m-link");
    link.href = id ? `https://www.youtube.com/channel/${id}` :
               handle ? `https://www.youtube.com/${handle.replace(/^\s*@/,"@")}` : "#";

    openModal();
  });

  $search && $search.addEventListener("input", applyFilter);
  $sort && $sort.addEventListener("click", ()=>{ sortAZ=!sortAZ; $sort.textContent = sortAZ ? "A → Z" : "Z → A"; render(filtered); });

  (async function boot(){
    try{
      const r=await fetch("./data.json",{cache:"no-store"});
      const j=await r.json();
      channels=j.channels||[]; filtered=[...channels];
      $updated && ($updated.textContent = j.generatedAt ? `Last update: ${new Date(j.generatedAt).toLocaleString()}` : "");
      render(filtered);
    }catch(err){
      $updated && ($updated.textContent="Could not load data.json");
      console.error(err); render([]);
    }
  })();
})();
