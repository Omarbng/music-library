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
  add: '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
};

const state = { albums: [], tracks: [], byAlbum: new Map(), byTrack: new Map(), query: "", view: localGet("recView", "index"), siteName: "void crate", siteArtist: "", cv: 0,
  sort: localGet("sort", "added"), rev: localGet("rev", "0") === "1",            // records
  tsort: localGet("tsort", "added"), trev: localGet("trev", "0") === "1",       // tracks
  tfilter: localGet("tfilter", "all") };
const player = { queue: [], orig: [], index: -1, shuffle: localGet("shuffle", "0") === "1", repeat: localGet("repeat", "off") };
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
  state.byTrack = new Map(d.tracks.map((t) => [t.id, t]));
  state.siteName = d.siteName || "void crate"; state.siteArtist = d.siteArtist || "";
  state.cv = Math.floor(d.scannedAt || 0);  // new cover links after every library refresh
  $("#brand-word").textContent = state.siteName;
  // the top-bar link for finding new music (Lucida unless NAV_LINK says otherwise)
  $$(".ext-link").forEach((e) => e.remove());
  if (d.navLink) {
    const mk = (cls) => Object.assign(document.createElement("a"), { className: `ext-link ${cls}`, href: d.navLink.url, target: "_blank", rel: "noopener", title: `Open ${d.navLink.label} in a new tab`, textContent: `${d.navLink.label} ↗` });
    $(".nav-tools").prepend(mk("txt-btn"));
    $("#menu").insertBefore(mk(""), $("#menu [data-action]"));
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
  const bits = [a.artist, a.title, ...tracks.map((x) => x.title)].filter(Boolean).map((x) => String(x).toUpperCase());
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
const byTitle = (a, b) => norm(a.title).localeCompare(norm(b.title), undefined, { numeric: true });
const byArtist = (a, b) => norm(a.artist).localeCompare(norm(b.artist)) || byTitle(a, b);
const qRank = (x) => (x.lossless ? 1e5 : 0) + (Number(String(x.quality).match(/(\d+)\s*kbps/)?.[1]) || 0);
// each sort has a natural direction (newest, A–Z, longest, best first); "reverse" flips it
const SORTS = {
  added: { label: "Recently added", fn: (a, b) => b.added - a.added || byTitle(a, b) },
  artist: { label: "Artist A–Z", fn: byArtist },
  title: { label: "Title A–Z", fn: byTitle },
  duration: { label: "Length", fn: (a, b) => b.duration - a.duration || byTitle(a, b) },
  tracks: { label: "Track count", fn: (a, b) => b.tracks - a.tracks || byTitle(a, b) },
  quality: { label: "Format (best first)", fn: (a, b) => qRank(b) - qRank(a) || byTitle(a, b) },
  size: { label: "File size", fn: (a, b) => b.size - a.size || byTitle(a, b) },
};
const TSORTS = {
  added: { label: "Recently added", fn: (a, b) => (b.added || 0) - (a.added || 0) || byTitle(a, b) },
  title: { label: "Title A–Z", fn: byTitle },
  artist: { label: "Artist A–Z", fn: byArtist },
  album: { label: "Record A–Z", fn: (a, b) => norm(a.album).localeCompare(norm(b.album)) || a.discNo - b.discNo || a.trackNo - b.trackNo || byTitle(a, b) },
  quality: { label: "Format (best first)", fn: (a, b) => qRank(b) - qRank(a) || byTitle(a, b) },
  duration: { label: "Length", fn: (a, b) => b.duration - a.duration || byTitle(a, b) },
};
function sortBy(list, table, key, rev) {
  const s = table[key] || Object.values(table)[0];
  const out = list.slice().sort(s.fn);
  if (rev) out.reverse();
  return s.blank ? out.filter((x) => !s.blank(x)).concat(out.filter(s.blank)) : out;  // unknowns always last
}
const sortedAlbums = () => sortBy(state.albums, SORTS, state.sort, state.rev);
const sortedTracks = (list = state.tracks) => sortBy(list, TSORTS, state.tsort, state.trev);
const sortOptions = (table, cur) => Object.entries(table).map(([k, s]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(s.label)}</option>`).join("");
const dirBtn = (rev, id) => `<button id="${id}" class="dir" title="Reverse the order" aria-label="Reverse the order" aria-pressed="${rev}">${rev ? "↑ Reversed" : "↓"}</button>`;
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- shared blocks ---------- */
function indexList(albums) {
  return `<div class="index">${albums.map((a, i) => `
    <a class="idx" href="#/album/${a.id}" data-peek="${a.id}">
      <span class="n">${pad2(i + 1)}</span>
      <span class="t">${esc(a.title)}</span>
      <span class="r"><span class="a">${esc(a.artist)}</span><span class="lbl mute">${esc([plural(a.tracks, "track"), fmtLabel(a)].join(" · "))}</span></span>
    </a>`).join("")}</div>`;
}
function coversGrid(albums) {
  return `<div class="covers">${albums.map((a, i) => `
    <a class="ctile reveal" style="--d:${Math.min(i, 12) * .04}s" href="#/album/${a.id}">
      ${cover(a, 300)}
      <div class="cap"><b>${esc(a.title)}</b>${qualityChip(a)}</div>
      <div class="lbl mute" style="margin-top:4px">${esc(a.artist)}</div>
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
      <button class="deck-side l lbl" id="deck-sort" title="Change the order">Sorted by ${esc((SORTS[state.sort] || SORTS.added).label)}${state.rev ? " ↑" : ""} ↻</button>
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
    const rows = [["Artist", esc(a.artist)], ["Format", esc(fmtLabel(a))]];
    $("#deck-info").innerHTML = `
      <h2 class="deck-title"><span class="swap">${esc(a.title)}</span></h2>
      <dl class="deck-meta">${rows.map(([k, v]) => `<div><dt class="lbl">${k}</dt><dd>${v}</dd></div>`).join("")}
        <div class="tracks-row"><dt class="lbl">Tracks</dt><dd id="deck-tracks">${plural(a.tracks, "track")}</dd></div></dl>
      <div class="deck-links"><button class="ulink" id="deck-play">Play</button><a class="ulink" href="#/album/${a.id}">Open</a><a class="ulink" href="/download/album/${a.id}" title="Download ${esc(fmtSize(a.size))}">Download</a></div>`;
    $("#deck-notes").innerHTML = `
      <div class="note"><span class="lbl">Length</span><b class="swap">${esc(fmtLong(a.duration))} — ${plural(a.tracks, "track")}</b></div>
      <div class="note"><span class="lbl">Size</span><b class="swap" style="animation-delay:.08s">${esc(fmtSize(a.size))}</b></div>`;
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
  $("#deck-sort").onclick = () => {
    const keys = Object.keys(SORTS);
    state.sort = keys[(keys.indexOf(state.sort) + 1) % keys.length]; state.rev = false;
    localSet("sort", state.sort); localSet("rev", "0"); renderHome();
  };
  const onKey = (e) => {
    if (!deck.isConnected) return removeEventListener("keydown", onKey);
    if (e.target.matches?.("input, select, textarea") || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
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
  const total = list.reduce((n, a) => n + a.duration, 0), bytes = list.reduce((n, a) => n + a.size, 0);
  $("#view").innerHTML = `
    <div class="page">
      <h1 class="page-title reveal">Records</h1>
      <div class="page-sub"><span class="lbl">${plural(list.length, "record")}</span><span class="lbl mute">${fmtLong(total)}</span><span class="lbl mute">${fmtSize(bytes)}</span></div>
      <div class="sec-head">
        <div class="toolbar"><button data-view="index" class="${state.view === "index" ? "on" : ""}">Index</button><button data-view="covers" class="${state.view === "covers" ? "on" : ""}">Covers</button></div>
        <div class="toolbar"><span class="lbl mute">Sort</span><select id="sort" aria-label="Sort records">${sortOptions(SORTS, state.sort)}</select>${dirBtn(state.rev, "dir")}</div>
      </div>
      <div id="rec-list">${state.view === "covers" ? coversGrid(list) : indexList(list)}</div>
    </div>`;
  $$(".toolbar button[data-view]").forEach((b) => b.onclick = () => { state.view = b.dataset.view; localSet("recView", state.view); renderAlbums(); });
  $("#sort").onchange = (e) => { state.sort = e.target.value; state.rev = false; localSet("sort", state.sort); localSet("rev", "0"); renderAlbums(); };
  $("#dir").onclick = () => { state.rev = !state.rev; localSet("rev", state.rev ? "1" : "0"); renderAlbums(); };
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
      <button class="rbtn addq" data-stop aria-label="Add ${esc(t.title)} to the queue" title="Add to queue">${ICON.add}</button>
      <a class="rbtn dl" data-stop href="/download/track/${t.id}" aria-label="Download ${esc(t.title)}" title="Download · ${esc(fmtSize(t.size || 0))}">${ICON.down}</a>
    </div>`).join("");
}
// column headers that sort the Tracks table
function headRow() {
  const col = (key, text, cls) => {
    const on = state.tsort === key;
    return `<button class="${cls} ${on ? "on" : ""}" data-tsort="${key}" aria-label="Sort by ${esc(text)}">${esc(text)}${on ? (state.trev ? " ↑" : " ↓") : ""}</button>`;
  };
  return `<div class="row head" role="presentation">
    ${col("added", "New", "num")}<span class="ttl">${col("title", "Title", "")}${col("artist", "Artist", "")}</span>
    ${col("album", "Record", "alb")}${col("quality", "Format", "q")}${col("duration", "Time", "dur")}<span></span><span></span></div>`;
}
function bindRows(root, list) {
  $$(".row:not(.head)", root).forEach((row) => {
    const i = list.findIndex((t) => t.id === row.dataset.track);
    $(".addq", row).onclick = () => addToQueue([list[i]]);
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
  if (!state.tracks.length) { $("#view").innerHTML = emptyState(); return; }
  const all = sortedTracks();
  const list = state.tfilter === "lossless" ? all.filter((t) => t.lossless) : all;
  const shown = list.slice(0, limit);
  const total = list.reduce((n, t) => n + t.duration, 0);
  $("#view").innerHTML = `
    <div class="page">
      <h1 class="page-title reveal">Tracks</h1>
      <div class="page-sub"><span class="lbl">${plural(list.length, "track")}</span><span class="lbl mute">${fmtLong(total)}</span></div>
      <div class="sec-head">
        <div class="toolbar">
          <button data-filter="all" class="${state.tfilter === "all" ? "on" : ""}">All</button>
          <button data-filter="lossless" class="${state.tfilter === "lossless" ? "on" : ""}">Lossless only</button>
          <button id="play-all">Play all</button><button id="shuffle-all">Shuffle all</button>
        </div>
        <div class="toolbar"><span class="lbl mute">Sort</span><select id="tsort" aria-label="Sort tracks">${sortOptions(TSORTS, state.tsort)}</select>${dirBtn(state.trev, "tdir")}</div>
      </div>
      <div class="tracks" id="list">${headRow()}${rows(shown, { withAlbum: true, numbered: false })}</div>
      ${!list.length ? `<div class="empty"><h2>No lossless tracks.</h2>Switch the filter back to All.</div>` : ""}
      ${list.length > limit ? `<div class="more"><button class="ulink" id="more">Show more</button></div>` : ""}
    </div>`;
  const setSort = (key, rev) => { state.tsort = key; state.trev = rev; localSet("tsort", key); localSet("trev", rev ? "1" : "0"); renderSongs(limit); };
  $$("[data-tsort]").forEach((b) => b.onclick = () => setSort(b.dataset.tsort, b.dataset.tsort === state.tsort ? !state.trev : false));
  $("#tsort").onchange = (e) => setSort(e.target.value, false);
  $("#tdir").onclick = () => setSort(state.tsort, !state.trev);
  $$("[data-filter]").forEach((b) => b.onclick = () => { state.tfilter = b.dataset.filter; localSet("tfilter", state.tfilter); renderSongs(limit); });
  $("#play-all").onclick = () => playList(list, 0, { shuffle: false });
  $("#shuffle-all").onclick = () => playList(list, Math.floor(Math.random() * list.length), { shuffle: true });
  bindRows($("#list"), shown);
  const more = $("#more");
  if (more) more.onclick = () => { const y = scrollY; renderSongs(limit + 200); scrollTo(0, y); };
  reveals();
}

/* ---------- view: search ---------- */
function renderSearch() {
  const albums = sortedAlbums().filter((a) => matches([a.title, a.artist, a.genre, a.edition]));
  const tracks = sortedTracks(state.tracks.filter((t) => matches([t.title, t.artist, t.album]))).slice(0, 120);
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
  const meta = [["Artist", a.artist], ["Tracks", String(list.length)], ["Running time", fmtLong(a.duration)],
    ["Format", fmtLabel(a)], ["Size", fmtSize(a.size)], a.edition && ["Edition", a.edition]].filter((m) => m && m[1]);
  $("#view").innerHTML = `
    <article class="ed">
      <a class="lbl mute ed-back" href="#/albums">← Records</a>
      <h1 class="ed-title reveal">${esc(a.title)}</h1>
      <div class="ed-credits reveal"><span><span class="lbl">By</span>${esc(a.artist)}</span><span><span class="lbl">Runtime</span>${fmtTime(a.duration)}</span></div>
      <div class="ed-stage reveal" style="--d:.08s">
        <div class="sleeve-wrap" id="sleeve">
          ${disc(a, { text: rimText(a, list), idle: 7 })}
          <div class="sleeve">${cover(a, 800)}</div>
        </div>
      </div>
      <div class="ed-actions reveal">
        <button class="ulink" id="play">Play</button>
        <button class="ulink" id="shuffle">Shuffle</button>
        <button class="ulink" id="enqueue">Add to queue</button>
        <a class="ulink" href="/download/album/${a.id}">Download <small>${fmtSize(a.size)}</small></a>
      </div>
      <dl class="meta-table reveal">${meta.map(([k, v]) => `<div><dt class="lbl">${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      <div class="sec-head"><span class="lbl">Tracklist</span><span class="lbl mute">${plural(list.length, "track")}</span></div>
      <div class="tracks" id="list">${rows(list)}</div>
      ${nextAlbum ? nextBlock(nextAlbum) : ""}
      <div class="foot"><span class="lbl">${esc(state.siteName)}</span><span class="lbl mute">${esc(a.artist)} — ${esc(a.title)}</span></div>
    </article>`;
  setTimeout(() => $("#sleeve")?.classList.add("out"), 450);
  $("#play").onclick = () => playList(list, 0, { shuffle: false });
  $("#shuffle").onclick = () => playList(list, Math.floor(Math.random() * list.length), { shuffle: true });
  $("#enqueue").onclick = () => addToQueue(list);
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

/* ---------- player: queue, shuffle, repeat, resume ---------- */
const cur = () => player.queue[player.index];
function playList(list, i = 0, opts = {}) {
  if (!list.length) return;
  if (opts.shuffle && !player.shuffle) { player.shuffle = true; localSet("shuffle", "1"); }
  const first = list[i] || list[0];
  player.orig = list.slice();
  player.queue = player.shuffle ? [first, ...shuffle(list.filter((t) => t !== first))] : list.slice();
  player.index = player.shuffle ? 0 : Math.max(0, list.indexOf(first));
  loadCurrent(true); syncModes();
}
function addToQueue(tracks) {
  if (!tracks.length) return;
  if (!cur()) return playList(tracks, 0);
  player.queue.push(...tracks); player.orig.push(...tracks);
  toast(tracks.length === 1 ? `Added to the queue: ${tracks[0].title}` : `Added ${plural(tracks.length, "track")} to the queue`);
  renderQueue(); saveResume();
}
function setShuffle(on) {
  player.shuffle = on; localSet("shuffle", on ? "1" : "0");
  const c = cur();
  if (c && on) player.queue = [...player.queue.slice(0, player.index + 1), ...shuffle(player.queue.slice(player.index + 1))];
  if (c && !on) { const j = player.orig.findIndex((t) => t.id === c.id); if (j >= 0) { player.queue = player.orig.slice(); player.index = j; } }
  syncModes(); renderQueue(); saveResume();
  toast(on ? "Shuffle on" : "Shuffle off");
}
const REPEAT_TEXT = { off: "Repeat off", all: "Repeat all", one: "Repeat this track" };
function cycleRepeat() {
  player.repeat = { off: "all", all: "one", one: "off" }[player.repeat] || "off";
  localSet("repeat", player.repeat); syncModes(); renderQueue();
  toast(REPEAT_TEXT[player.repeat]);
}
function syncModes() {
  const s = $("#shuffle-btn"), r = $("#repeat-btn");
  s.classList.toggle("on", player.shuffle); s.setAttribute("aria-pressed", String(player.shuffle));
  s.title = player.shuffle ? "Shuffle on (S)" : "Shuffle off (S)";
  r.classList.toggle("on", player.repeat !== "off"); r.dataset.mode = player.repeat;
  r.title = `${REPEAT_TEXT[player.repeat]} (R)`; r.setAttribute("aria-label", REPEAT_TEXT[player.repeat]);
}
function loadCurrent(autoplay) {
  const t = cur();
  if (!t) return;
  audio.src = `/stream/${t.id}`;
  player.wantPlay = !!autoplay;
  if (autoplay) audio.play().catch(() => {});  // a file the browser can't play is reported by the error handler
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
  const dl = $("#np-download"); dl.href = `/download/track/${t.id}`; dl.title = `Download this track · ${fmtSize(t.size || 0)}`;
  $("#t-cur").textContent = "0:00"; $("#seek").value = 0; $("#pl-bar").style.transform = "scaleX(0)";
  $("#t-dur").textContent = fmtTime(t.duration);
  document.title = `${t.title} · ${t.artist} — ${state.siteName}`;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: coverUrl(t.albumId, 800), sizes: "800x800", type: "image/jpeg" }] });
  }
  markPlaying(); renderQueue(); saveResume();
}
function togglePlay() { if (audio.src) audio.paused ? audio.play() : audio.pause(); }
function next(auto) {
  if (auto === true && player.repeat === "one") { audio.currentTime = 0; audio.play(); return; }
  if (player.index < player.queue.length - 1) player.index++;
  else if (player.repeat !== "off" && player.queue.length) player.index = 0;
  else { if (auto === true) toast("End of the queue"); return; }
  loadCurrent(true);
}
function prev() { if (audio.currentTime > 3 || player.index === 0) { audio.currentTime = 0; return; } player.index--; loadCurrent(true); }
function seekBy(s) { if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration - .5, audio.currentTime + s)); }
function toggleMute() { if (!audio.src) return; audio.muted = !audio.muted; toast(audio.muted ? "Muted (M)" : "Sound on"); }
function markPlaying() {
  const c = cur();
  $$(".row:not(.head)").forEach((row) => {
    const on = !!c && row.dataset.track === c.id;
    row.classList.toggle("playing", on); row.classList.toggle("paused", on && audio.paused);
    const num = $(".num", row);
    if (on && !num.dataset.orig) { num.dataset.orig = num.textContent; num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>'; }
    if (!on && num.dataset.orig) { num.textContent = num.dataset.orig; delete num.dataset.orig; }
  });
}

/* the queue panel */
const queueEl = $("#queue");
function renderQueue() {
  if (queueEl.hidden) return;
  const c = player.index, now = cur();
  const item = (t, i) => `
    <div class="q-item ${i === c ? "now" : ""}" data-qi="${i}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
      <span class="num">${i === c ? (audio.paused ? "II" : '<span class="eq"><i></i><i></i><i></i></span>') : pad2(i - c)}</span>
      <span class="ttl"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
      <span class="dur">${fmtTime(t.duration)}</span>
      ${i > c ? `<button class="rbtn" data-qrm="${i}" aria-label="Remove ${esc(t.title)} from the queue" title="Remove">${ICON.x}</button>` : "<span></span>"}
    </div>`;
  const up = player.queue.slice(c + 1), upTime = up.reduce((n, t) => n + t.duration, 0);
  $("#q-list").innerHTML = now ? `
    <div class="q-sec lbl mute">Now playing</div>${item(now, c)}
    <div class="q-sec lbl mute">Up next · ${plural(up.length, "track")}${up.length ? ` · ${fmtLong(upTime)}` : ""}${player.shuffle ? " · shuffled" : ""}${player.repeat !== "off" ? ` · ${REPEAT_TEXT[player.repeat].toLowerCase()}` : ""}</div>
    ${up.map((t, k) => item(t, c + 1 + k)).join("") || `<div class="q-empty">Nothing after this track.${player.repeat === "all" ? " Repeat all starts the queue again." : ""}</div>`}`
    : `<div class="q-empty">Nothing playing yet. Pick a record or a track.</div>`;
  $("#q-clear").hidden = !up.length;
}
function openQueue() { queueEl.hidden = false; renderQueue(); setTimeout(() => queueEl.classList.add("open"), 20); $("#queue-btn").classList.add("on"); }
function closeQueue() { if (queueEl.hidden) return; queueEl.classList.remove("open"); $("#queue-btn").classList.remove("on"); setTimeout(() => (queueEl.hidden = true), 400); }
function toggleQueue() { queueEl.hidden ? openQueue() : closeQueue(); }
$("#q-list").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-qrm]");
  if (rm) {
    const i = Number(rm.dataset.qrm), [gone] = player.queue.splice(i, 1);
    const j = player.orig.findIndex((t) => t.id === gone.id); if (j >= 0) player.orig.splice(j, 1);
    renderQueue(); saveResume(); return;
  }
  const it = e.target.closest("[data-qi]");
  if (!it) return;
  const i = Number(it.dataset.qi);
  if (i === player.index) togglePlay(); else { player.index = i; loadCurrent(true); }
});
$("#q-list").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-qi]")) e.target.click(); });
$("#q-clear").onclick = () => { player.queue = player.queue.slice(0, player.index + 1); player.orig = player.queue.slice(); renderQueue(); saveResume(); toast("Cleared up next"); };
$("#q-close").onclick = closeQueue;
$("#queue-btn").onclick = toggleQueue;

/* pick up where you left off after a reload */
function saveResume() {
  if (!cur()) return;
  const start = Math.max(0, player.index - 50), ids = (l) => l.slice(start, start + 400).map((t) => t.id);
  localSet("resume", JSON.stringify({ q: ids(player.queue), o: player.orig.slice(0, 450).map((t) => t.id), i: player.index - start, t: Math.floor(audio.currentTime || 0) }));
}
function restoreResume() {
  let r; try { r = JSON.parse(localGet("resume", "null")); } catch { return; }
  if (!r || !Array.isArray(r.q)) return;
  const first = state.byTrack.get(r.q[r.i]);
  if (!first) return;
  player.queue = r.q.map((id) => state.byTrack.get(id)).filter(Boolean);
  player.orig = (r.o || r.q).map((id) => state.byTrack.get(id)).filter(Boolean);
  player.index = player.queue.indexOf(first);
  const at = r.t || 0;
  if (at > 2) audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.min(at, Math.max(0, audio.duration - 2)); }, { once: true });
  loadCurrent(false);
}

const setIcon = (paused) => { $("#toggle-icon").outerHTML = (paused ? ICON.play : ICON.pause).replace("<svg", '<svg id="toggle-icon"'); $("#toggle").setAttribute("aria-label", paused ? "Play" : "Pause"); };
audio.addEventListener("play", () => { player.wantPlay = true; spinDiscs(); setIcon(false); markPlaying(); renderQueue(); positionState(); });
audio.addEventListener("pause", () => { setIcon(true); markPlaying(); renderQueue(); saveResume(); });
audio.addEventListener("ended", () => next(true));
audio.addEventListener("error", () => {
  const t = cur();
  if (!t || !audio.getAttribute("src") || !player.wantPlay) return;  // a paused, restored track just waits
  toast(`This browser can't play “${t.title}”. Download it instead.`);
  if (player.index < player.queue.length - 1) setTimeout(() => { if (cur() === t) next(); }, 1800);
});
let seeking = false, lastSave = 0;
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || cur()?.duration || 0;
  const frac = d ? audio.currentTime / d : 0;
  $("#pl-bar").style.transform = `scaleX(${frac})`;
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveResume(); }
  if (seeking) return;
  $("#t-cur").textContent = fmtTime(audio.currentTime);
  $("#seek").value = Math.round(frac * 1000);
});
audio.addEventListener("loadedmetadata", () => { if (isFinite(audio.duration)) $("#t-dur").textContent = fmtTime(audio.duration); positionState(); });
audio.addEventListener("seeked", positionState);
addEventListener("pagehide", saveResume);
const seek = $("#seek");
seek.addEventListener("input", () => { seeking = true; $("#t-cur").textContent = fmtTime((seek.value / 1000) * (audio.duration || 0)); });
seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
const vol = $("#vol");
vol.value = localGet("vol", "1"); audio.volume = Number(vol.value);
vol.addEventListener("input", () => { audio.volume = Number(vol.value); audio.muted = false; localSet("vol", vol.value); });
$("#toggle").onclick = togglePlay; $("#next").onclick = () => next(); $("#prev").onclick = prev;
$("#shuffle-btn").onclick = () => setShuffle(!player.shuffle); $("#repeat-btn").onclick = cycleRepeat;
syncModes();
function positionState() {
  try { if (audio.duration && isFinite(audio.duration)) navigator.mediaSession?.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}
if ("mediaSession" in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  on("play", () => audio.play()); on("pause", () => audio.pause());
  on("nexttrack", () => next()); on("previoustrack", prev);
  on("seekbackward", (d) => seekBy(-(d.seekOffset || 10))); on("seekforward", (d) => seekBy(d.seekOffset || 10));
  on("seekto", (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ---------- keyboard, search, menu, refresh ---------- */
document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, select, textarea")) {
    if (e.key === "Escape") { if (e.target.id === "q" && e.target.value) { e.target.value = ""; state.query = ""; route(); } e.target.blur(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "Space" && !e.target.closest?.(".row, .q-item, button, a")) { e.preventDefault(); togglePlay(); return; }
  if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); seekBy(e.key === "ArrowRight" ? 10 : -10); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const keys = { "/": () => $("#q").focus(), n: () => next(), p: prev, m: toggleMute, s: () => setShuffle(!player.shuffle), r: cycleRepeat, q: toggleQueue, Escape: closeQueue };
  if (keys[k]) { e.preventDefault(); keys[k](); }
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
loadLibrary().then(() => { route(); restoreResume(); }).catch((e) => {
  if (e.message !== "login") $("#view").innerHTML = `<div class="page"><div class="empty"><h2>Couldn't reach the crate.</h2>Check that the server is running, then reload.</div></div>`;
});
