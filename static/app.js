"use strict";
/* void crate — a private crate of selected raw music.
   Editorial paper & ink, after A24's production pages.
   Views: #/ (crate), #/albums (records), #/songs (tracks), #/album/<id>, search via the nav field. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const fmtLong = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} hr ${m} min` : `${m} min`; };
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const pad2 = (n) => String(n).padStart(2, "0");
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function localGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8.5 5.8v12.4L18.5 12z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5.5h2.6v13H8zm5.4 0H16v13h-2.6z" fill="currentColor" stroke="none"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14"/></svg>',
};

const state = { albums: [], tracks: [], byAlbum: new Map(), query: "", sort: localGet("sort", "added"), view: localGet("recView", "index"), siteName: "void crate", siteArtist: "", cv: 0 };
const player = { queue: [], index: -1 };
const audio = $("#audio");

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("login"); }
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
async function loadLibrary() {
  const d = await api("/api/library");
  state.albums = d.albums; state.tracks = d.tracks; state.root = d.root;
  state.byAlbum = new Map(d.albums.map((a) => [a.id, a]));
  state.siteName = d.siteName || "void crate"; state.siteArtist = d.siteArtist || "";
  state.cv = Math.floor(d.scannedAt || 0);  // new cover links after every library refresh
  $("#brand-word").textContent = state.siteName;
  // optional extra top-bar link (NAV_LINK in this computer's .env)
  $$(".ext-link").forEach((e) => e.remove());
  if (d.navLink) {
    const mk = () => Object.assign(document.createElement("a"), { className: "ext-link", href: d.navLink.url, target: "_blank", rel: "noopener", textContent: `${d.navLink.label} ↗` });
    $(".nav-links").appendChild(mk());
    $("#menu").insertBefore(mk(), $("#menu [data-action]"));
  }
}

/* ---------- covers (muted generated fallback that sits well on paper) ---------- */
const coverUrl = (id, size = 300) => `/cover/${encodeURIComponent(id)}?size=${size}&v=${state.cv}`;
function phStyle(id) {
  const h = hash(id) % 360;
  return `--ph: linear-gradient(160deg, hsl(${h} 12% 82%), hsl(${(h + 40) % 360} 10% 66%))`;
}
function cover(album, size = 300) {
  const id = album.id || album.albumId;
  return `<div class="cover" style="${phStyle(id)}"><span class="ph">${esc(album.title || album.album || "")}</span><img loading="lazy" decoding="async" alt="" src="${coverUrl(id, size)}" onload="this.classList.add('ready')" onerror="this.remove()"></div>`;
}
const fmtLabel = (x) => x.quality === "Mixed" ? (x.lossless ? "Lossless" : "Mixed") : x.quality.split(" · ").slice(0, 2).join(" ");
const qualityChip = (x) => `<span class="chip ${x.lossless ? "ll" : ""}">${esc(fmtLabel(x))}</span>`;

/* ---------- discs: the record printed on a spinning disc ---------- */
let discUid = 0;
function rimText(a, tracks = []) {
  const bits = [a.artist, a.title, a.year, ...tracks.map((x) => x.title)].filter(Boolean).map((x) => String(x).toUpperCase());
  let s = "";
  while (s.length < 168 && bits.length) s += bits.join("  ·  ") + "  ·  ";
  return s.slice(0, 168);
}
function disc(a, { text = "", cls = "", idle = 9 } = {}) {
  const id = a.id || a.albumId, uid = `dp${++discUid}`;
  return `<div class="disc ${cls}" data-disc data-album="${esc(id)}" data-idle="${idle}" style="${phStyle(id)}; --disc-img: url('${coverUrl(id, 800)}')" aria-hidden="true">
    <div class="disc-spin"><div class="disc-face"></div>${text ? `<svg class="disc-text" viewBox="0 0 100 100"><defs><path id="${uid}" d="M50,50 m-41,0 a41,41 0 1,1 82,0 a41,41 0 1,1 -82,0"/></defs><text><textPath href="#${uid}">${esc(text)}</textPath></text></svg>` : ""}</div>
    <div class="disc-sheen"></div><div class="disc-rim"></div><div class="disc-hub"></div></div>`;
}
const spinner = { items: new Set(), raf: null };
function albumPlaying(id) { const cur = player.queue[player.index]; return !!cur && !audio.paused && cur.albumId === id; }
function spinDiscs(root = document) {
  $$("[data-disc]", root).forEach((el) => { if (!el._spin) { el._spin = { a: Math.random() * 360, v: 0 }; spinner.items.add(el); } });
  if (spinner.raf || REDUCED) return;
  let prev = performance.now();
  const tick = (now) => {
    const dt = Math.min(64, now - prev) / 1000; prev = now;
    for (const el of spinner.items) {
      if (!el.isConnected) { spinner.items.delete(el); continue; }
      const target = albumPlaying(el.dataset.album) ? 198 : Number(el.dataset.idle || 9);  // 33⅓ rpm while playing
      el._spin.v += (target - el._spin.v) * Math.min(1, dt * 1.5);
      el._spin.a = (el._spin.a + el._spin.v * dt) % 360;
      el.firstElementChild.style.transform = `rotate(${el._spin.a.toFixed(2)}deg)`;
    }
    spinner.raf = spinner.items.size && !document.hidden ? requestAnimationFrame(tick) : null;
  };
  spinner.raf = requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) spinDiscs(); });

/* ---------- reveal on scroll ---------- */
const revealer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px" });
function reveals(root = document) {
  const els = $$(".reveal:not(.in), .title-page:not(.in), .next:not(.in)", root);
  setTimeout(() => els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * .96 && r.bottom > 0) el.classList.add("in"); else revealer.observe(el);
  }), 40);
}

/* ---------- filters & sorting ---------- */
function matches(fields) {
  if (!state.query) return true;
  const hay = norm(fields.join(" "));
  return norm(state.query).split(/\s+/).every((w) => hay.includes(w));
}
const SORTS = {
  added: (a, b) => b.added - a.added,
  artist: (a, b) => norm(a.artist).localeCompare(norm(b.artist)) || norm(a.title).localeCompare(norm(b.title)),
  title: (a, b) => norm(a.title).localeCompare(norm(b.title)),
  year: (a, b) => (b.year || "0").localeCompare(a.year || "0") || norm(a.title).localeCompare(norm(b.title)),
};
const sortedAlbums = () => state.albums.slice().sort(SORTS[state.sort] || SORTS.added);
const latest = () => state.albums.slice().sort(SORTS.added);
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- shared blocks ---------- */
function indexList(albums) {
  return `<div class="index">${albums.map((a, i) => `
    <a class="idx" href="#/album/${a.id}" data-peek="${a.id}">
      <span class="n">${pad2(i + 1)}</span>
      <span class="t">${esc(a.title)}</span>
      <span class="r"><span class="a">${esc(a.artist)}</span><span class="lbl mute">${esc([a.year, plural(a.tracks, "track"), fmtLabel(a)].filter(Boolean).join(" · "))}</span></span>
    </a>`).join("")}</div>`;
}
function coversGrid(albums) {
  return `<div class="covers">${albums.map((a, i) => `
    <a class="ctile reveal" style="--d:${Math.min(i, 12) * .04}s" href="#/album/${a.id}">
      ${cover(a, 300)}
      <div class="cap"><b>${esc(a.title)}</b>${qualityChip(a)}</div>
      <div class="lbl mute" style="margin-top:4px">${esc(a.artist)}${a.year ? ` · ${esc(a.year)}` : ""}</div>
    </a>`).join("")}</div>`;
}
function bindPeek(root) {
  const peek = $("#peek");
  if (matchMedia("(hover: none)").matches) return;
  $$("[data-peek]", root).forEach((row) => {
    row.addEventListener("mouseenter", () => { peek.innerHTML = cover({ id: row.dataset.peek, title: "" }, 300); peek.classList.add("on"); });
    row.addEventListener("mouseleave", () => peek.classList.remove("on"));
    row.addEventListener("mousemove", (e) => { peek.style.left = `${e.clientX + 150}px`; peek.style.top = `${e.clientY}px`; });
  });
}
function nextBlock(a, label = "Next in the crate") {
  const words = String(a.title).toUpperCase().split(/\s+/).filter(Boolean);
  const lines = words.length <= 3 ? words : [words[0], words.slice(1, -1).join(" "), words[words.length - 1]];
  const lefts = ["14%", "46%", "26%"];
  return `<a class="next" href="#/album/${a.id}" aria-label="${esc(label)}: ${esc(a.title)}">
    <span class="lbl">${esc(label)}</span>
    ${lines.map((w, i) => `<span class="next-word" style="top:calc(var(--rule) * ${i + 1}); left:${lefts[i]}">${esc(w)}</span>`).join("")}
    ${disc(a, { text: rimText(a), idle: 11 })}
    <span class="next-cta lbl">${esc(a.artist)} →</span>
  </a>`;
}
function emptyState() {
  return `<div class="page"><div class="empty"><span class="lbl mute">Empty crate</span><h2>Nothing in the crate yet.</h2>Add music to ${esc(state.root || "your library")}, then press Refresh.</div></div>`;
}

/* ---------- view: the crate (home) — the disc deck, after A24's films index ---------- */
const trackCache = new Map();
async function albumTracks(id) {
  if (!trackCache.has(id)) trackCache.set(id, api(`/api/albums/${id}`).then((a) => a.trackList).catch(() => []));
  return trackCache.get(id);
}

function loopPath(w, h) {
  // a hand-drawn double loop around the centre disc, a little uneven like a pen stroke
  const pts = [], turns = 1.86, n = 140, rot = -16 * Math.PI / 180;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 * turns;
    const k = 1 + 0.035 * Math.sin(3 * t + 1.3) + 0.018 * Math.sin(7 * t) + (i / n) * 0.05;
    const x = Math.cos(t) * (w / 2) * 0.93 * k, y = Math.sin(t) * (h / 2) * 0.86 * k;
    pts.push([w / 2 + x * Math.cos(rot) - y * Math.sin(rot), h / 2 + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return "M" + pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" L");
}

function renderHome() {
  if (!state.albums.length) { $("#view").innerHTML = emptyState(); return; }
  const list = sortedAlbums();
  let active = 0, slots = new Map(), cooldown = 0, wheelAcc = 0, drag = null;
  $("#view").innerHTML = `
    <section class="deck" id="deck" tabindex="0" aria-label="Records — scroll, drag or use the arrow keys">
      <div class="deck-info" id="deck-info"></div>
      <div class="deck-stage" id="deck-stage"></div>
      <svg class="loop" id="loop" aria-hidden="true"><path id="loop-path"/></svg>
      <div class="deck-notes" id="deck-notes"></div>
      <div class="deck-side l lbl">${esc(state.siteName)} — records</div>
      <div class="deck-side r lbl" id="deck-count"></div>
    </section>`;
  document.body.classList.add("deck-on");
  const deck = $("#deck"), stage = $("#deck-stage");

  function geom() {
    const vw = innerWidth, vh = innerHeight, mobile = vw < 820;
    const size = mobile ? Math.min(vw * 0.86, vh * 0.5) : Math.min(vw * 0.4, vh * 0.66);
    return { vw, vh, mobile, size, cx: vw * (mobile ? 0.5 : 0.53), cy: vh * (mobile ? 0.56 : 0.52),
             dx: mobile ? vw * 0.74 : vw * 0.34, dy: mobile ? -vh * 0.05 : -vh * 0.14 };
  }
  function place() {
    const g = geom();
    // keep only the discs near the centre in the page
    for (let i = active - 4; i <= active + 4; i++) {
      if (i < 0 || i >= list.length || slots.has(i)) continue;
      const el = document.createElement("div");
      el.className = "slot"; el.dataset.i = i;
      el.innerHTML = `<div class="tilt">${disc(list[i], { text: rimText(list[i]), idle: 6 })}</div>`;
      const d0 = i < active ? -5 : 5;  // enter from the edge
      Object.assign(el.style, { width: `${g.size}px`, height: `${g.size}px`, opacity: 0,
        transform: `translate(${g.cx + d0 * g.dx - g.size / 2}px, ${g.cy + d0 * g.dy - g.size / 2}px) scale(.86)` });
      stage.appendChild(el); slots.set(i, el);
      spinDiscs(el);
    }
    stage.getBoundingClientRect();  // commit the entry positions so the move animates
    setTimeout(() => {
      for (const [i, el] of slots) {
        const d = i - active;
        if (Math.abs(d) > 4) { el.remove(); slots.delete(i); continue; }
        el.classList.toggle("center", d === 0);
        el.style.width = el.style.height = `${g.size}px`;
        el.style.zIndex = String(10 - Math.abs(d));
        el.style.opacity = Math.abs(d) > 3 ? 0 : 1;
        el.style.transform = `translate(${g.cx + d * g.dx - g.size / 2}px, ${g.cy + d * g.dy - g.size / 2}px) scale(${d === 0 ? 1 : .84})`;
        el.firstElementChild.firstElementChild.dataset.idle = d === 0 ? 14 : 6;
      }
    }, 20);
    // the hand-drawn loop around the centre disc
    const w = g.size * 1.22, h = g.size * 0.98, svg = $("#loop"), path = $("#loop-path");
    Object.assign(svg.style, { left: `${g.cx - w / 2}px`, top: `${g.cy - h / 2}px`, width: `${w}px`, height: `${h}px` });
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    path.setAttribute("d", loopPath(w, h));
    const len = path.getTotalLength();
    path.style.transition = "none"; path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
    path.getBoundingClientRect();
    path.style.transition = ""; setTimeout(() => (path.style.strokeDashoffset = 0), 380);
  }
  async function info() {
    const a = list[active];
    $("#deck-count").textContent = `${pad2(active + 1)} / ${pad2(list.length)}`;
    const rows = [["Artist", esc(a.artist)], a.year && ["Year", esc(a.year)], ["Format", esc(fmtLabel(a))]].filter(Boolean);
    $("#deck-info").innerHTML = `
      <h2 class="deck-title"><span class="swap">${esc(a.title)}</span></h2>
      <dl class="deck-meta">${rows.map(([k, v]) => `<div><dt class="lbl">${k}</dt><dd>${v}</dd></div>`).join("")}
        <div class="tracks-row"><dt class="lbl">Tracks</dt><dd id="deck-tracks">${plural(a.tracks, "track")}</dd></div></dl>
      <div class="deck-links"><button class="ulink" id="deck-play">Play</button><a class="ulink" href="#/album/${a.id}">Open</a></div>`;
    $("#deck-notes").innerHTML = `
      <div class="note"><span class="lbl">Length</span><b class="swap">${esc(fmtLong(a.duration))} — ${plural(a.tracks, "track")}</b></div>
      <div class="note"><span class="lbl">Added</span><b class="swap" style="animation-delay:.08s">${new Date(a.added * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b></div>`;
    $("#deck-play").onclick = async () => playList(await albumTracks(a.id), 0);
    const tracks = await albumTracks(a.id);
    if (list[active] === a && $("#deck-tracks")) {
      const names = tracks.slice(0, 5).map((t) => esc(t.title));
      $("#deck-tracks").innerHTML = names.join("<br>") + (tracks.length > 5 ? `<br><span class="lbl mute">+ ${tracks.length - 5} more</span>` : "");
    }
  }
  function go(i) {
    i = Math.max(0, Math.min(list.length - 1, i));
    if (i === active) return;
    active = i; cooldown = performance.now() + 420;
    place(); info();
  }

  deck.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (performance.now() < cooldown) return;
    wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheelAcc) > 40) { go(active + Math.sign(wheelAcc)); wheelAcc = 0; }
  }, { passive: false });
  deck.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
  deck.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, dist = Math.abs(dx) > Math.abs(dy) ? -dx : dy;
    if (Math.abs(dist) > 50) { go(active + Math.sign(dist)); drag = { x: e.clientX, y: e.clientY, moved: true }; }
  });
  deck.addEventListener("pointerup", (e) => {
    const was = drag; drag = null;
    if (!was || was.moved || e.target.closest("a, button")) return;
    const slot = e.target.closest(".slot");
    if (!slot) return;
    const i = Number(slot.dataset.i);
    if (i === active) location.hash = `#/album/${list[i].id}`; else go(i);
  });
  const onKey = (e) => {
    if (!deck.isConnected) return removeEventListener("keydown", onKey);
    if (e.target.matches?.("input, select, textarea")) return;
    if (["ArrowRight", "ArrowDown"].includes(e.key)) { e.preventDefault(); go(active + 1); }
    if (["ArrowLeft", "ArrowUp"].includes(e.key)) { e.preventDefault(); go(active - 1); }
    if (e.key === "Enter") location.hash = `#/album/${list[active].id}`;
  };
  addEventListener("keydown", onKey);
  let rz;
  const onResize = () => { if (!deck.isConnected) return removeEventListener("resize", onResize); clearTimeout(rz); rz = setTimeout(place, 120); };
  addEventListener("resize", onResize);

  place(); info();
}

/* ---------- view: records ---------- */
function renderAlbums() {
  if (!state.albums.length) { $("#view").innerHTML = emptyState(); return; }
  const list = sortedAlbums();
  $("#view").innerHTML = `
    <div class="page">
      <h1 class="page-title reveal">Records</h1>
      <div class="page-sub"><span class="lbl">${plural(list.length, "record")}</span><span class="lbl mute">in the crate</span></div>
      <div class="sec-head">
        <div class="toolbar"><button data-view="index" class="${state.view === "index" ? "on" : ""}">Index</button><button data-view="covers" class="${state.view === "covers" ? "on" : ""}">Covers</button></div>
        <div class="toolbar"><select id="sort" aria-label="Sort records"><option value="added">Recently added</option><option value="artist">Artist</option><option value="title">Title</option><option value="year">Year</option></select></div>
      </div>
      <div id="rec-list">${state.view === "covers" ? coversGrid(list) : indexList(list)}</div>
    </div>`;
  $$(".toolbar button[data-view]").forEach((b) => b.onclick = () => { state.view = b.dataset.view; localSet("recView", state.view); renderAlbums(); });
  const sel = $("#sort"); sel.value = state.sort;
  sel.onchange = () => { state.sort = sel.value; localSet("sort", sel.value); renderAlbums(); };
  bindPeek($("#view"));
  reveals();
}

/* ---------- track table ---------- */
function rows(list, { withAlbum = false, numbered = true } = {}) {
  return list.map((t, i) => `
    <div class="row ${withAlbum ? "" : "no-album"}" data-track="${t.id}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
      <span class="num">${pad2(numbered ? (t.trackNo || i + 1) : i + 1)}</span>
      <span class="ttl"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
      ${withAlbum ? `<span class="alb"><a href="#/album/${t.albumId}" data-stop>${esc(t.album)}</a></span>` : ""}
      <span class="q">${qualityChip(t)}</span>
      <span class="dur">${fmtTime(t.duration)}</span>
      <a class="dl" data-stop href="/download/track/${t.id}" aria-label="Download ${esc(t.title)}" title="Download">${ICON.down}</a>
    </div>`).join("");
}
function bindRows(root, list) {
  $$(".row", root).forEach((row) => {
    const i = list.findIndex((t) => t.id === row.dataset.track);
    const act = (e) => {
      if (e.target.closest("[data-stop]")) return;
      const cur = player.queue[player.index];
      if (cur && cur.id === list[i].id) togglePlay(); else playList(list, i);
    };
    row.addEventListener("click", act);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(e); } });
  });
  markPlaying();
}

/* ---------- view: tracks ---------- */
function renderSongs(limit = 200) {
  const list = state.tracks.slice().sort((a, b) => norm(a.artist).localeCompare(norm(b.artist)) || norm(a.album).localeCompare(norm(b.album)) || a.discNo - b.discNo || a.trackNo - b.trackNo);
  if (!list.length) { $("#view").innerHTML = emptyState(); return; }
  const shown = list.slice(0, limit);
  $("#view").innerHTML = `
    <div class="page">
      <h1 class="page-title reveal">Tracks</h1>
      <div class="page-sub"><span class="lbl">${plural(list.length, "track")}</span><button class="lbl" id="shuffle-all" style="text-decoration:underline;text-underline-offset:3px">Shuffle all</button></div>
      <div class="tracks" id="list">${rows(shown, { withAlbum: true, numbered: false })}</div>
      ${list.length > limit ? `<div class="more"><button class="ulink" id="more">Show more</button></div>` : ""}
    </div>`;
  $("#shuffle-all").onclick = () => playList(shuffle(list), 0);
  bindRows($("#list"), shown);
  const more = $("#more");
  if (more) more.onclick = () => { const y = scrollY; renderSongs(limit + 200); scrollTo(0, y); };
  reveals();
}

/* ---------- view: search ---------- */
function renderSearch() {
  const albums = sortedAlbums().filter((a) => matches([a.title, a.artist, a.genre, a.edition, a.year]));
  const tracks = state.tracks.filter((t) => matches([t.title, t.artist, t.album])).slice(0, 120);
  $("#view").innerHTML = `
    <div class="page">
      <h1 class="page-title">“${esc(state.query)}”</h1>
      <div class="page-sub"><span class="lbl">${plural(albums.length, "record")}</span><span class="lbl">${plural(tracks.length, "track")}</span></div>
      ${albums.length ? `<div style="margin-bottom:70px">${indexList(albums)}</div>` : ""}
      ${tracks.length ? `<div class="tracks" id="list">${rows(tracks, { withAlbum: true, numbered: false })}</div>` : ""}
      ${!albums.length && !tracks.length ? `<div class="empty"><h2>Nothing here.</h2>No record or track matches “${esc(state.query)}”.</div>` : ""}
    </div>`;
  if (tracks.length) bindRows($("#list"), tracks);
  bindPeek($("#view"));
}

/* ---------- view: record (editorial, with the disc) ---------- */
async function renderAlbum(id) {
  let a;
  try { a = await api(`/api/albums/${id}`); }
  catch { $("#view").innerHTML = `<div class="page"><div class="empty"><h2>Not in the crate.</h2>This record isn't here anymore.<div class="links" style="justify-content:center;margin-top:28px"><a class="ulink" href="#/">Back to the crate</a></div></div></div>`; return; }
  const list = a.trackList;
  const order = sortedAlbums(), at = order.findIndex((x) => x.id === a.id);
  const nextAlbum = order.length > 1 ? order[(at + 1) % order.length] : null;
  const meta = [["Artist", a.artist], ["Year", a.year], ["Tracks", String(list.length)], ["Running time", fmtLong(a.duration)],
    ["Format", fmtLabel(a)], ["Size", fmtSize(a.size)], a.edition && ["Edition", a.edition]].filter((m) => m && m[1]);
  $("#view").innerHTML = `
    <article class="ed">
      <a class="lbl mute ed-back" href="#/albums">← Records</a>
      <h1 class="ed-title reveal">${esc(a.title)}</h1>
      <div class="ed-credits reveal"><span><span class="lbl">By</span>${esc(a.artist)}</span>${a.year ? `<span><span class="lbl">Year</span>${esc(a.year)}</span>` : ""}<span><span class="lbl">Runtime</span>${fmtTime(a.duration)}</span></div>
      <div class="ed-stage reveal" style="--d:.08s">
        <div class="sleeve-wrap" id="sleeve">
          ${disc(a, { text: rimText(a, list), idle: 7 })}
          <div class="sleeve">${cover(a, 800)}</div>
        </div>
      </div>
      <div class="ed-actions reveal">
        <button class="ulink" id="play">Play</button>
        <button class="ulink" id="shuffle">Shuffle</button>
        <a class="ulink" href="/download/album/${a.id}">Download <small>${fmtSize(a.size)}</small></a>
      </div>
      <dl class="meta-table reveal">${meta.map(([k, v]) => `<div><dt class="lbl">${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      <div class="sec-head"><span class="lbl">Tracklist</span><span class="lbl mute">${plural(list.length, "track")}</span></div>
      <div class="tracks" id="list">${rows(list)}</div>
      ${nextAlbum ? nextBlock(nextAlbum) : ""}
      <div class="foot"><span class="lbl">${esc(state.siteName)}</span><span class="lbl mute">${esc(a.artist)} — ${esc(a.title)}</span></div>
    </article>`;
  setTimeout(() => $("#sleeve")?.classList.add("out"), 450);
  $("#play").onclick = () => playList(list, 0);
  $("#shuffle").onclick = () => playList(shuffle(list), 0);
  bindRows($("#list"), list);
  spinDiscs($("#view"));
  reveals();
}

/* ---------- routing ---------- */
function route() {
  $("#peek").classList.remove("on");
  document.body.classList.remove("deck-on");
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/album\/([\w-]+)/);
  const tab = state.query ? "" : m ? "albums" : hash.startsWith("#/songs") ? "songs" : hash.startsWith("#/albums") ? "albums" : "home";
  $$(".nav-links a").forEach((a) => a.classList.toggle("on", a.dataset.nav === tab));
  if (m) renderAlbum(m[1]);
  else if (state.query) renderSearch();
  else if (tab === "songs") renderSongs();
  else if (tab === "albums") renderAlbums();
  else renderHome();
  scrollTo({ top: 0, behavior: "instant" });
  closeMenu();
}

/* ---------- player ---------- */
function playList(list, i) {
  if (!list.length) return;
  player.queue = list.slice(); player.index = i; loadCurrent(true);
}
function loadCurrent(autoplay) {
  const t = player.queue[player.index];
  if (!t) return;
  audio.src = `/stream/${t.id}`;
  if (autoplay) audio.play().catch(() => toast("This browser can't play this file. Try downloading it."));
  const p = $("#player");
  p.hidden = false; setTimeout(() => p.classList.add("show"), 30); document.body.classList.add("has-player");
  const art = $("#np-art");
  if (art.dataset.album !== t.albumId) {
    art.dataset.album = t.albumId;
    art.innerHTML = disc({ id: t.albumId, title: t.album }, { cls: "pl-art", idle: 0 });
    spinDiscs(art);
  }
  $("#np-title").textContent = t.title;
  $("#np-artist").textContent = `${t.artist} — ${t.album}`;
  $("#np-link").href = `#/album/${t.albumId}`;
  const q = $("#np-quality"); q.textContent = fmtLabel(t); q.className = `chip ${t.lossless ? "ll" : ""}`;
  $("#np-download").href = `/download/track/${t.id}`;
  $("#t-dur").textContent = fmtTime(t.duration);
  document.title = `${t.title} · ${t.artist} — ${state.siteName}`;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: coverUrl(t.albumId, 800), sizes: "800x800", type: "image/jpeg" }] });
  }
  markPlaying();
}
function togglePlay() { if (audio.src) audio.paused ? audio.play() : audio.pause(); }
function next() { if (player.index < player.queue.length - 1) { player.index++; loadCurrent(true); } }
function prev() { if (audio.currentTime > 3 || player.index === 0) { audio.currentTime = 0; return; } player.index--; loadCurrent(true); }
function markPlaying() {
  const cur = player.queue[player.index];
  $$(".row").forEach((row) => {
    const on = !!cur && row.dataset.track === cur.id;
    row.classList.toggle("playing", on); row.classList.toggle("paused", on && audio.paused);
    const num = $(".num", row);
    if (on && !num.dataset.orig) { num.dataset.orig = num.textContent; num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>'; }
    if (!on && num.dataset.orig) { num.textContent = num.dataset.orig; delete num.dataset.orig; }
  });
}
audio.addEventListener("play", () => { spinDiscs(); $("#toggle-icon").outerHTML = ICON.pause.replace("<svg", '<svg id="toggle-icon"'); $("#toggle").setAttribute("aria-label", "Pause"); markPlaying(); });
audio.addEventListener("pause", () => { $("#toggle-icon").outerHTML = ICON.play.replace("<svg", '<svg id="toggle-icon"'); $("#toggle").setAttribute("aria-label", "Play"); markPlaying(); });
audio.addEventListener("ended", next);
let seeking = false;
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || player.queue[player.index]?.duration || 0;
  const frac = d ? audio.currentTime / d : 0;
  $("#pl-bar").style.transform = `scaleX(${frac})`;
  if (seeking) return;
  $("#t-cur").textContent = fmtTime(audio.currentTime);
  $("#seek").value = Math.round(frac * 1000);
});
audio.addEventListener("loadedmetadata", () => { if (isFinite(audio.duration)) $("#t-dur").textContent = fmtTime(audio.duration); });
const seek = $("#seek");
seek.addEventListener("input", () => { seeking = true; $("#t-cur").textContent = fmtTime((seek.value / 1000) * (audio.duration || 0)); });
seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
const vol = $("#vol");
vol.value = localGet("vol", "1"); audio.volume = Number(vol.value);
vol.addEventListener("input", () => { audio.volume = Number(vol.value); localSet("vol", vol.value); });
$("#toggle").onclick = togglePlay; $("#next").onclick = next; $("#prev").onclick = prev;
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", next);
  navigator.mediaSession.setActionHandler("previoustrack", prev);
}

/* ---------- keyboard, search, menu, refresh ---------- */
document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, select, textarea")) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.code === "Space" && !e.target.closest?.(".row, button, a")) { e.preventDefault(); togglePlay(); }
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
});
let searchTimer;
$("#q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    if (location.hash.startsWith("#/album/")) location.hash = "#/"; else route();
  }, 160);
});
const menu = $("#menu"), burger = $("#burger");
function closeMenu() { if (menu.hidden) return; menu.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); burger.textContent = "Menu"; setTimeout(() => (menu.hidden = true), 450); }
burger.onclick = () => {
  if (!menu.hidden) return closeMenu();
  menu.hidden = false; burger.setAttribute("aria-expanded", "true"); burger.textContent = "Close";
  setTimeout(() => menu.classList.add("open"), 30);
};
$$("#menu a").forEach((a) => a.addEventListener("click", closeMenu));
async function rescan() {
  const btn = $("#rescan"); btn.classList.add("spin");
  try {
    const r = await api("/api/rescan", { method: "POST" });
    await loadLibrary(); route();
    toast(r.tracks != null ? `Crate updated: ${plural(r.albums, "record")}, ${plural(r.tracks, "track")}` : "A refresh is already running");
  } catch { toast("Refresh failed"); }
  btn.classList.remove("spin");
}
$("#rescan").onclick = rescan;
$('[data-action="rescan"]').onclick = () => { closeMenu(); rescan(); };

addEventListener("hashchange", route);
loadLibrary().then(route).catch((e) => {
  if (e.message !== "login") $("#view").innerHTML = `<div class="page"><div class="empty"><h2>Couldn't reach the crate.</h2>Check that the server is running, then reload.</div></div>`;
});
