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

/* ---------- view: the crate (home) ---------- */
function renderHome() {
  if (!state.albums.length) { $("#view").innerHTML = emptyState(); return; }
  const recents = latest(), top = recents[0], second = recents[1] || recents[0];
  const lossless = state.tracks.filter((t) => t.lossless).length;
  const totalTime = state.tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const updated = new Date((Math.max(...state.albums.map((a) => a.added)) || 0) * 1000);
  const words = String(top.title).toUpperCase().split(/\s+/).filter(Boolean).slice(0, 4);
  const spots = [["48%", "25vh"], ["6%", "50vh"], ["58%", "75vh"], ["22%", "100vh"]];
  $("#view").innerHTML = `
    <section class="title-page">
      <div class="tp-head">
        <h1 class="tp-title">Void Crate</h1>
        <div class="credits">
          <span><span class="lbl">Selected by</span>${esc(state.siteArtist || "hand")}</span>
          <span><span class="lbl">Kept</span>private</span>
          <span><span class="lbl">Sound</span>raw, minimal</span>
        </div>
        <div class="tp-links">
          <button class="ulink" id="play-all">Play the crate</button>
          <a class="ulink" href="#/albums">Browse records</a>
        </div>
      </div>
      <div class="tp-disc">${disc(top, { text: rimText(top), idle: 8 })}</div>
      <dl class="meta">
        <div><dt class="lbl">Records</dt><dd>${state.albums.length}</dd></div>
        <div><dt class="lbl">Tracks</dt><dd>${state.tracks.length}</dd></div>
        <div><dt class="lbl">Running time</dt><dd>${fmtLong(totalTime)}</dd></div>
        <div><dt class="lbl">Lossless</dt><dd>${lossless} of ${state.tracks.length}</dd></div>
        <div><dt class="lbl">Updated</dt><dd>${updated.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</dd></div>
      </dl>
    </section>

    <section class="band" aria-label="Latest record: ${esc(top.title)}">
      ${cover(top, 800)}
      ${words.map((w, i) => `<span class="band-word" style="left:${spots[i][0]}; top:${spots[i][1]}">${esc(w)}</span>`).join("")}
      <div class="band-cta"><a class="ulink" href="#/album/${top.id}">Open record</a></div>
    </section>
    <div class="blurb">
      <span class="lbl">Latest in the crate</span>
      <div>
        <p>${esc(top.title)} by ${esc(top.artist)}${top.year ? `, ${esc(top.year)}` : ""}. ${plural(top.tracks, "track")}, ${fmtLong(top.duration)}, ${esc(fmtLabel(top).toLowerCase())}.</p>
        <div class="links stack" style="margin-top:22px">
          <button class="ulink" id="play-latest">Play record</button>
          <a class="ulink" href="/download/album/${top.id}">Download <small>${fmtSize(top.size)}</small></a>
        </div>
      </div>
    </div>

    <section class="sec">
      <div class="sec-head reveal"><span class="lbl">The crate — ${plural(state.albums.length, "record")}</span><a class="lbl mute" href="#/albums">All records →</a></div>
      ${indexList(sortedAlbums())}
    </section>

    ${second && second.id !== top.id ? nextBlock(second, "Also in the crate") : ""}
    <div class="foot"><span class="lbl">${esc(state.siteName)}</span><span class="lbl mute">Private · selected by hand</span></div>`;
  $("#play-all").onclick = () => playList(shuffle(state.tracks), 0);
  $("#play-latest").onclick = async () => { const al = await api(`/api/albums/${top.id}`); playList(al.trackList, 0); };
  bindPeek($("#view"));
  spinDiscs($("#view"));
  reveals();
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
  if (e.target.matches("input, select, textarea")) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.code === "Space" && !e.target.closest(".row, button, a")) { e.preventDefault(); togglePlay(); }
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
