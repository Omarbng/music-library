"use strict";
/* Music · the void — private library front end.
   Views: #/ (void), #/albums, #/songs, #/album/<id>, search via the nav field. */

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
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function localGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8.5 5.8v12.4L18.5 12z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5.5h2.6v13H8zm5.4 0H16v13h-2.6z" fill="currentColor" stroke="none"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M4 7h3.5c2 0 3.2 1 4.3 2.8l1.4 2.4c1.1 1.8 2.3 2.8 4.3 2.8H20M4 17h3.5c1.3 0 2.2-.4 3-1.2M13.5 8.2c.8-.8 1.7-1.2 3-1.2H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9.5 6 6 6-6 6"/></svg>',
};

const state = { albums: [], tracks: [], byAlbum: new Map(), query: "", sort: localGet("sort", "added"), view: localGet("wallView", "2d"), siteName: "music", siteArtist: "" };
const player = { queue: [], index: -1 };
const audio = $("#audio");
const live = new Set(); // running animations to stop when the view changes

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
  state.siteName = d.siteName || "music"; state.siteArtist = d.siteArtist || "";
  $("#brand-word").textContent = state.siteName;
}

/* ---------- covers with generated fallbacks ---------- */
function phStyle(id) {
  const h = hash(id) % 360, h2 = (h + 40 + (hash(id + "x") % 80)) % 360;
  return `--ph: radial-gradient(120% 90% at 20% 15%, hsl(${h} 70% 46%), transparent 60%), radial-gradient(100% 100% at 90% 90%, hsl(${h2} 75% 30%), #0d0d12 70%)`;
}
function cover(album, size = 300) {
  const id = album.id || album.albumId;
  const title = album.title || album.album || "";
  return `<div class="cover" style="${phStyle(id)}"><span class="ph">${esc(title)}</span><img loading="lazy" decoding="async" alt="" src="/cover/${id}?size=${size}" onload="this.classList.add('ready')" onerror="this.remove()"></div>`;
}
const qualityChip = (x) => {
  const label = x.quality === "Mixed" ? (x.lossless ? "Lossless" : "Mixed") : x.quality.split(" · ").slice(0, 2).join(" ");
  return `<span class="chip ${x.lossless ? "ll" : ""}">${esc(label)}</span>`;
};

/* ---------- discs: the album printed on a spinning disc ---------- */
let discUid = 0;
function rimText(a, tracks = []) {
  const bits = [a.artist, a.title, a.year, ...tracks.map((x) => x.title)].filter(Boolean).map((x) => String(x).toUpperCase());
  let s = "";
  while (s.length < 168 && bits.length) s += bits.join("  ·  ") + "  ·  ";
  return s.slice(0, 168);
}
function disc(a, { text = "", cls = "", idle = 9 } = {}) {
  const id = a.id || a.albumId, uid = `dp${++discUid}`;
  return `<div class="disc ${cls}" data-disc data-album="${esc(id)}" data-idle="${idle}" style="${phStyle(id)}; --disc-img: url('/cover/${esc(id)}?size=800')" aria-hidden="true">
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

/* ---------- starfield ---------- */
(function starfield() {
  const c = $("#stars"), ctx = c.getContext("2d");
  let w, h, dpr, stars = [], mx = 0, my = 0, tx = 0, ty = 0;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2); w = innerWidth; h = innerHeight;
    c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((w * h) / 5200);
    stars = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, z: Math.random() ** 2, p: Math.random() * 6.28, s: .4 + Math.random() * 1.8 }));
    if (REDUCED) draw(0);
  }
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    tx += (mx - tx) * .04; ty += (my - ty) * .04;
    for (const s of stars) {
      const tw = REDUCED ? .8 : .55 + .45 * Math.sin(t * .0012 * s.s + s.p);
      const r = .35 + s.z * 1.25, x = (s.x + tx * (s.z * 18) + w) % w, y = (s.y + ty * (s.z * 18) + h) % h;
      ctx.globalAlpha = (.18 + s.z * .7) * tw;
      ctx.fillStyle = s.z > .82 ? "#cdd6ff" : "#fff";
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      if (!REDUCED) s.y = (s.y + .012 + s.z * .03) % h;
    }
    if (!REDUCED) requestAnimationFrame(draw);
  }
  addEventListener("resize", resize);
  addEventListener("pointermove", (e) => { mx = (e.clientX / w - .5) * -1; my = (e.clientY / h - .5) * -1; }, { passive: true });
  resize(); if (!REDUCED) requestAnimationFrame(draw);
})();

/* ---------- 3D void: covers drifting toward the viewer ---------- */
class VoidField {
  constructor(el, albums, { count = 34, size = 168, interactive = false, clearCenter = false } = {}) {
    this.el = el; this.albums = albums.length ? albums : []; this.interactive = interactive; this.clear = clearCenter;
    this.size = size; this.speed = .055; this.target = .055; this.boost = 0; this.rx = 0; this.ry = 0; this.trx = 0; this.try = 0;
    this.far = -2600; this.near = 420; this.next = 0;
    el.classList.add("voidfield");
    this.stage = document.createElement("div"); this.stage.className = "vf-stage"; el.appendChild(this.stage);
    const n = Math.min(count, Math.max(12, this.albums.length * 3));
    this.cards = [];
    for (let i = 0; i < n && this.albums.length; i++) {
      const a = document.createElement("a"); a.className = "vf-card"; a.style.setProperty("--w", `${size}px`);
      this.stage.appendChild(a);
      const card = { el: a, z: this.far + (i / n) * (this.near - this.far) };
      this.place(card, true); this.cards.push(card);
    }
    this.onMove = (e) => { const r = el.getBoundingClientRect(); this.try = ((e.clientX - r.left) / r.width - .5) * 8; this.trx = -((e.clientY - r.top) / r.height - .5) * 6; };
    el.addEventListener("pointermove", this.onMove, { passive: true });
    el.addEventListener("pointerover", (e) => { if (e.target.closest(".vf-card")) this.target = .008; });
    el.addEventListener("pointerout", (e) => { if (e.target.closest(".vf-card")) this.target = .055; });
    if (interactive) {
      el.addEventListener("wheel", (e) => { e.preventDefault(); this.boost += e.deltaY * .0016; this.boost = Math.max(-2.2, Math.min(2.2, this.boost)); }, { passive: false });
      let last = null;
      el.addEventListener("pointerdown", (e) => { last = e.clientY; });
      el.addEventListener("pointermove", (e) => { if (last !== null && e.buttons) { this.boost += (last - e.clientY) * .006; last = e.clientY; } });
      addEventListener("pointerup", () => { last = null; });
    }
    this.io = new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; if (this.visible) this.start(); });
    this.io.observe(el); live.add(this);
  }
  place(card, first = false) {
    const a = this.albums[this.next++ % this.albums.length];
    const W = this.el.clientWidth || innerWidth, H = this.el.clientHeight || innerHeight;
    let x, y, tries = 0;
    do { x = (Math.random() - .5) * W * 1.7; y = (Math.random() - .5) * H * 1.5; tries++; }
    while (this.clear && Math.abs(x) < W * (W < 760 ? .46 : .34) && Math.abs(y) < H * (W < 760 ? .26 : .3) && y > -H * .9 && tries < 16);
    card.x = x; card.y = y; if (!first) card.z = this.far;
    card.el.href = `#/album/${a.id}`;
    card.el.setAttribute("aria-label", `${a.title} by ${a.artist}`);
    card.el.innerHTML = `${cover(a, 300)}<div class="vf-cap"><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></div>`;
  }
  start() {
    if (this.raf || REDUCED && this.drawn) return;
    let prev = performance.now();
    const tick = (now) => {
      const dt = Math.min(64, now - prev); prev = now;
      this.speed += (this.target - this.speed) * .06; this.boost *= .93;
      const v = REDUCED ? 0 : (this.speed + this.boost) * dt;
      this.rx += (this.trx - this.rx) * .05; this.ry += (this.try - this.ry) * .05;
      this.stage.style.transform = `rotateX(${this.rx}deg) rotateY(${this.ry}deg)`;
      for (const c of this.cards) {
        c.z += v;
        if (c.z > this.near) this.place(c);
        if (c.z < this.far) { c.z = this.near - 1; }
        const fadeIn = Math.min(1, (c.z - this.far) / 700), fadeOut = Math.min(1, (this.near - c.z) / 260);
        c.el.style.opacity = Math.max(0, Math.min(fadeIn, fadeOut)).toFixed(3);
        c.el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, ${c.z.toFixed(1)}px)`;
      }
      this.drawn = true;
      if (this.visible && !document.hidden && !REDUCED && this.el.isConnected) this.raf = requestAnimationFrame(tick);
      else this.raf = null;
    };
    this.raf = requestAnimationFrame(tick);
  }
  destroy() { cancelAnimationFrame(this.raf); this.raf = null; this.io.disconnect(); live.delete(this); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) live.forEach((f) => f.visible && f.start && f.start()); });

/* ---------- reveal on scroll ---------- */
const revealer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px" });
function reveals(root = document) {
  const els = $$(".reveal:not(.in)", root);
  // Anything already on screen reveals right away; the rest waits until it scrolls into view.
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
const recentAlbums = (n) => state.albums.slice().sort(SORTS.added).slice(0, n);

/* ---------- view: the void (home) ---------- */
const WORDS = ["albums", "tracks", "DJ sets", "B-sides", "remixes", "sessions"];
function renderHome() {
  const totalSize = state.albums.reduce((n, a) => n + a.size, 0);
  const lossless = state.tracks.filter((t) => t.lossless).length;
  const recents = recentAlbums(14);
  $("#view").innerHTML = `
    <section class="hero" id="hero">
      <div id="hero-void"></div>
      <div class="hero-copy">
        <span class="eyebrow reveal"><b></b>${esc(state.siteArtist ? `${state.siteArtist} · private library` : "Your private library")}</span>
        <h1 class="reveal" style="--d:.08s"><span class="l1">Your favourite <span class="swap" id="swap">${WORDS[0]}</span></span><br>deserve a universe.</h1>
        <p class="hero-sub reveal" style="--d:.16s"><strong>${plural(state.tracks.length, "song")}</strong> across <strong>${plural(state.albums.length, "album")}</strong>, ${fmtSize(totalSize)} drifting in one void${lossless ? `, ${lossless} in lossless` : ""}.</p>
        <div class="btn-row reveal" style="--d:.24s">
          <button class="btn primary" id="play-all">Play the void <span class="ico">${ICON.shuffle}</span></button>
          <a class="btn" href="#/albums">Browse albums <span class="ico">${ICON.arrow}</span></a>
        </div>
      </div>
      <span class="scroll-cue" aria-hidden="true"></span>
    </section>

    ${recents.length ? `<section class="section" id="listen">
      <div class="section-head reveal"><span class="eyebrow"><b></b>Recently added</span><h2>Listen, right here.</h2><p>Tap the album in the middle to play it. Swipe, drag or use the arrows to drift through the rest.</p></div>
      <div class="flow reveal" id="flow" aria-roledescription="carousel"></div>
      <div class="flow-nav reveal"><button class="round" id="flow-prev" aria-label="Previous album">${ICON.left}</button><button class="round" id="flow-next" aria-label="Next album">${ICON.right}</button></div>
    </section>` : ""}

    <section class="section" id="everything">
      <div class="section-head reveal"><span class="eyebrow"><b></b>${plural(state.albums.length, "album")}</span><h2>Everything in the void.</h2><p>Your whole library, floating in staggered orbit. Switch to 3D and scroll to fly through it.</p></div>
      <div id="wall-area"></div>
    </section>
    <div class="foot">${esc(state.siteName)} · private, password-protected · ${plural(state.tracks.length, "song")}</div>`;

  if (!state.albums.length) {
    $("#view").innerHTML = emptyState();
    return;
  }
  new VoidField($("#hero-void"), recentAlbums(40).length ? shuffle(state.albums).slice(0, 60) : [], { count: innerWidth < 760 ? 18 : 34, size: innerWidth < 760 ? 112 : 168, clearCenter: true });
  startSwap();
  $("#play-all").onclick = () => playList(shuffle(state.tracks), 0, true);
  if (recents.length) coverFlow($("#flow"), recents);
  renderWall($("#wall-area"), sortedAlbums(), { toolbar: true });
  reveals();
}

function startSwap() {
  let i = 0;
  const el = $("#swap");
  const timer = setInterval(() => {
    if (!el.isConnected) return clearInterval(timer);
    i = (i + 1) % WORDS.length;
    el.classList.remove("glitch"); void el.offsetWidth; el.classList.add("glitch");
    setTimeout(() => { el.textContent = WORDS[i]; }, 160);
  }, 2600);
}

/* ---------- cover-flow ---------- */
function coverFlow(root, albums) {
  let active = Math.min(2, albums.length - 1);
  root.innerHTML = albums.map((a, i) => `
    <div class="flow-item" data-i="${i}" role="group" aria-label="${esc(a.title)} by ${esc(a.artist)}">
      <div class="bezel"><div class="core">${cover(a, 800)}</div></div>
      <span class="flow-play" aria-hidden="true">${ICON.play}</span>
      <div class="flow-cap"><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></div>
    </div>`).join("");
  const items = $$(".flow-item", root);
  const mobile = innerWidth < 760;
  function layout() {
    items.forEach((el, i) => {
      const d = i - active, ad = Math.abs(d);
      const x = d === 0 ? 0 : Math.sign(d) * ((mobile ? 120 : 210) + (ad - 1) * (mobile ? 56 : 120));
      const z = -ad * 160, ry = Math.max(-46, Math.min(46, -d * 34)), s = d === 0 ? 1 : .78;
      el.style.transform = `translateX(${x}px) translateZ(${z}px) rotateY(${ry}deg) scale(${s})`;
      el.style.opacity = ad > 4 ? 0 : String(1 - ad * .17);
      el.style.zIndex = String(100 - ad);
      el.style.filter = d === 0 ? "none" : `brightness(${.75 - ad * .07})`;
      el.style.pointerEvents = ad > 4 ? "none" : "auto";
      el.classList.toggle("active", d === 0);
    });
  }
  const go = (n) => { active = Math.max(0, Math.min(albums.length - 1, n)); layout(); };
  items.forEach((el, i) => el.addEventListener("click", async () => {
    if (moved) return;
    if (i !== active) return go(i);
    const album = await api(`/api/albums/${albums[i].id}`);
    playList(album.trackList, 0);
  }));
  $("#flow-prev").onclick = () => go(active - 1);
  $("#flow-next").onclick = () => go(active + 1);
  let startX = null, moved = false;
  root.addEventListener("pointerdown", (e) => { startX = e.clientX; moved = false; });
  root.addEventListener("pointermove", (e) => { if (startX !== null && Math.abs(e.clientX - startX) > 40) { go(active + (e.clientX < startX ? 1 : -1)); startX = e.clientX; moved = true; } });
  addEventListener("pointerup", () => { startX = null; setTimeout(() => (moved = false), 0); });
  root.tabIndex = 0;
  root.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") go(active + 1); if (e.key === "ArrowLeft") go(active - 1); });
  layout();
}

/* ---------- the wall (2D staggered columns or 3D fly-through) ---------- */
function columnsFor(w) { return w >= 1320 ? 6 : w >= 1080 ? 5 : w >= 820 ? 4 : w >= 560 ? 3 : 2; }
function renderWall(root, albums, { toolbar = false } = {}) {
  root.innerHTML = `
    ${toolbar ? `<div class="wall-toolbar reveal">
      <div class="seg" role="tablist" aria-label="View">
        <button data-view="2d" class="${state.view === "2d" ? "on" : ""}">2D</button>
        <button data-view="3d" class="${state.view === "3d" ? "on" : ""}">3D</button>
      </div>
      <select class="pill-select" id="sort" aria-label="Sort albums">
        <option value="added">Recently added</option><option value="artist">Artist</option><option value="title">Title</option><option value="year">Year</option>
      </select>
    </div>` : ""}
    <div class="wall-body"></div>`;
  const body = $(".wall-body", root);
  const draw = () => {
    live.forEach((f) => { if (body.contains(f.el)) f.destroy(); });
    if (state.view === "3d" && toolbar) {
      body.innerHTML = `<div class="wall-3d bezel"><div class="core"><div class="vf"></div><span class="hint">Scroll or drag to fly · click a cover to open it</span></div></div>`;
      new VoidField($(".vf", body), albums, { count: innerWidth < 760 ? 22 : 46, size: innerWidth < 760 ? 110 : 150, interactive: true });
      return;
    }
    const cols = columnsFor(body.clientWidth || innerWidth);
    const offsets = [0, 64, 22, 92, 38, 76];
    const buckets = Array.from({ length: cols }, () => []);
    albums.forEach((a, i) => buckets[i % cols].push([a, i]));
    body.innerHTML = `<div class="wall" style="--cols:${cols}">${buckets.map((b, c) => `
      <div class="wall-col" style="padding-top:${cols > 2 ? offsets[c % offsets.length] : (c % 2) * 40}px">${b.map(([a, i]) => `
        <a class="tile reveal" style="--d:${Math.min(i, 14) * .035}s" href="#/album/${a.id}">
          <div class="bezel"><div class="core">${cover(a, 300)}</div></div>
          <div class="tile-cap"><b>${esc(a.title)}</b><span>${esc(a.artist)}${a.year ? ` · ${esc(a.year)}` : ""}</span>${qualityChip(a)}</div>
        </a>`).join("")}</div>`).join("")}</div>`;
    body.dataset.cols = cols;
    reveals(body);
  };
  draw();
  if (toolbar) {
    $$(".seg button", root).forEach((b) => b.onclick = () => {
      state.view = b.dataset.view; localSet("wallView", state.view);
      $$(".seg button", root).forEach((x) => x.classList.toggle("on", x === b)); draw();
    });
    const sel = $("#sort", root); sel.value = state.sort;
    sel.onchange = () => { state.sort = sel.value; localSet("sort", sel.value); albums = sortedAlbums(); draw(); };
  }
  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (!body.isConnected) return removeEventListener("resize", onResize); if (state.view === "2d" || !toolbar) { if (String(columnsFor(body.clientWidth)) !== body.dataset.cols) draw(); } }, 160); };
  addEventListener("resize", onResize);
}

/* ---------- view: albums ---------- */
function renderAlbums() {
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head reveal">
        <div><span class="eyebrow"><b></b>${plural(state.albums.length, "album")}</span><h1>Albums.</h1><p>Every record in the void, in staggered orbit.</p></div>
      </div>
      <div id="wall-area"></div>
    </div>`;
  state.albums.length ? renderWall($("#wall-area"), sortedAlbums(), { toolbar: true }) : ($("#wall-area").innerHTML = emptyState());
  reveals();
}

/* ---------- track rows ---------- */
function rows(list, { withAlbum = false, numbered = true } = {}) {
  return list.map((t, i) => `
    <div class="row ${withAlbum ? "with-album" : ""}" data-track="${t.id}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
      <span class="num">${withAlbum ? `<span class="mini-art">${cover({ id: t.albumId, title: t.album }, 300)}</span>` : (numbered ? (t.trackNo || i + 1) : i + 1)}</span>
      <span class="ttl"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
      ${withAlbum ? `<span class="alb"><a href="#/album/${t.albumId}" data-stop>${esc(t.album)}</a></span>` : ""}
      <span class="q">${qualityChip(t)}</span>
      <span class="dur">${fmtTime(t.duration)}</span>
      <a class="ghost-btn dl" data-stop href="/download/track/${t.id}" aria-label="Download ${esc(t.title)}" title="Download">${ICON.down}</a>
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

/* ---------- view: songs ---------- */
function renderSongs(limit = 200) {
  const list = state.tracks.slice().sort((a, b) => norm(a.artist).localeCompare(norm(b.artist)) || norm(a.album).localeCompare(norm(b.album)) || a.discNo - b.discNo || a.trackNo - b.trackNo);
  const shown = list.slice(0, limit);
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head reveal">
        <div><span class="eyebrow"><b></b>${plural(list.length, "song")}</span><h1>Every song.</h1><p>The whole void as one long list.</p></div>
        ${list.length ? `<button class="btn" id="shuffle-all">Shuffle all <span class="ico">${ICON.shuffle}</span></button>` : ""}
      </div>
      ${list.length ? `<div class="list bezel reveal"><div class="core" id="list">${rows(shown, { withAlbum: true, numbered: false })}</div></div>
      ${list.length > limit ? `<div class="more"><button class="btn small" id="more">Show ${Math.min(200, list.length - limit)} more <span class="ico">${ICON.down}</span></button></div>` : ""}` : emptyState()}
    </div>`;
  if (!list.length) return;
  $("#shuffle-all").onclick = () => playList(shuffle(list), 0, true);
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
      <div class="page-head reveal"><div><span class="eyebrow"><b></b>Search</span><h1>“${esc(state.query)}”</h1><p>${plural(albums.length, "album")} and ${plural(tracks.length, "song")} found in the void.</p></div></div>
      ${albums.length ? `<div id="wall-area" style="margin-bottom:64px"></div>` : ""}
      ${tracks.length ? `<div class="list bezel reveal"><div class="core" id="list">${rows(tracks, { withAlbum: true, numbered: false })}</div></div>` : ""}
      ${!albums.length && !tracks.length ? `<div class="empty"><h2>Nothing out here.</h2>No album or song matches “${esc(state.query)}”.</div>` : ""}
    </div>`;
  if (albums.length) renderWall($("#wall-area"), albums);
  if (tracks.length) bindRows($("#list"), tracks);
  reveals();
}

/* ---------- view: album (editorial, with the disc) ---------- */
async function renderAlbum(id) {
  let a;
  try { a = await api(`/api/albums/${id}`); }
  catch { $("#view").innerHTML = `<div class="page"><div class="empty"><h2>Lost in the void.</h2>This album isn't here anymore.<div class="btn-row" style="justify-content:center;margin-top:24px"><a class="btn" href="#/">Back to the void <span class="ico">${ICON.arrow}</span></a></div></div></div>`; return; }
  const list = a.trackList;
  const order = sortedAlbums(), at = order.findIndex((x) => x.id === a.id);
  const nextAlbum = order.length > 1 ? order[(at + 1) % order.length] : null;
  const meta = [["Artist", a.artist], ["Year", a.year], ["Songs", String(list.length)], ["Length", fmtLong(a.duration)],
    ["Format", a.quality === "Mixed" ? (a.lossless ? "Lossless" : "Mixed") : a.quality], ["Size", fmtSize(a.size)], a.edition && ["Edition", a.edition]].filter((m) => m && m[1]);
  $("#view").innerHTML = `
    <article class="ed">
      <span class="cross tl"></span><span class="cross tr"></span>
      <a class="back" href="#/albums">${ICON.back} Albums</a>
      <header class="ed-head reveal">
        <div class="ed-kicker">${list.length === 1 ? "Single" : "Album"}${a.year ? ` · ${esc(a.year)}` : ""}</div>
        <h1 class="ed-title">${esc(a.title)}</h1>
        <div class="ed-credits"><span><small>By</small>${esc(a.artist)}</span>${a.edition ? `<span><small>Edition</small>${esc(a.edition)}</span>` : ""}<span><small>Runtime</small>${fmtTime(a.duration)}</span></div>
      </header>
      <div class="ed-stage reveal" style="--d:.08s">
        <div class="sleeve-wrap" id="sleeve">
          ${disc(a, { text: rimText(a, list), idle: 7 })}
          <div class="sleeve">${cover(a, 800)}</div>
        </div>
      </div>
      <div class="ed-actions reveal" style="--d:.14s">
        <button class="btn primary" id="play">Play <span class="ico">${ICON.play}</span></button>
        <button class="btn" id="shuffle">Shuffle <span class="ico">${ICON.shuffle}</span></button>
        <a class="btn" href="/download/album/${a.id}">Download · ${fmtSize(a.size)} <span class="ico">${ICON.down}</span></a>
      </div>
      <dl class="ed-meta reveal">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      <div class="list bezel reveal"><div class="core" id="list">${rows(list)}</div></div>
      ${nextAlbum ? `<a class="next reveal" href="#/album/${nextAlbum.id}" aria-label="Next album: ${esc(nextAlbum.title)}">
        <span class="ed-kicker">Next in the void</span>
        ${nextWords(nextAlbum.title)}
        ${disc(nextAlbum, { text: rimText(nextAlbum), idle: 11 })}
        <span class="next-cta">${esc(nextAlbum.artist)} →</span>
      </a>` : ""}
    </article>`;
  tintFrom(a.id);
  setTimeout(() => $("#sleeve")?.classList.add("out"), 450);
  $("#play").onclick = () => playList(list, 0);
  $("#shuffle").onclick = () => playList(shuffle(list), 0, true);
  bindRows($("#list"), list);
  spinDiscs($("#view"));
  reveals();
}

function nextWords(title) {
  const words = String(title).toUpperCase().split(/\s+/).filter(Boolean);
  const lines = words.length <= 3 ? words : [words[0], words.slice(1, -1).join(" "), words[words.length - 1]];
  const lefts = ["16%", "48%", "28%"];
  return lines.map((w, i) => `<span class="next-word" style="top:calc(var(--rule) * ${i + 1}); left:${lefts[i]}">${esc(w)}</span>`).join("");
}

/* tint glows from the album's average colour */
function tintFrom(albumId) {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 12;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data; let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const m = Math.max(d[i], d[i + 1], d[i + 2]); if (m < 30) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      if (n) document.documentElement.style.setProperty("--tint", `${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}`);
    } catch {}
  };
  img.src = `/cover/${albumId}?size=300`;
}

function emptyState() {
  return `<div class="page"><div class="empty"><span class="eyebrow"><b></b>Empty void</span><h2>Nothing is floating here yet.</h2>Add music to ${esc(state.root || "your library")}, then press the refresh button at the top.</div></div>`;
}
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- routing ---------- */
function route() {
  live.forEach((f) => f.destroy());
  document.documentElement.style.setProperty("--tint", "150, 150, 160");
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
  const q = $("#np-quality"); q.textContent = t.quality.split(" · ").slice(0, 2).join(" "); q.className = `chip ${t.lossless ? "ll" : ""}`;
  $("#np-download").href = `/download/track/${t.id}`;
  $("#t-dur").textContent = fmtTime(t.duration);
  document.title = `${t.title} · ${t.artist}`;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: `/cover/${t.albumId}?size=800`, sizes: "800x800", type: "image/jpeg" }] });
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
    if (!num || num.querySelector(".mini-art")) return;
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

/* ---------- keyboard, search, menu, rescan ---------- */
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
function closeMenu() { if (menu.hidden) return; menu.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); setTimeout(() => (menu.hidden = true), 450); }
burger.onclick = () => {
  if (!menu.hidden) return closeMenu();
  menu.hidden = false; burger.setAttribute("aria-expanded", "true"); setTimeout(() => menu.classList.add("open"), 30);
};
async function rescan() {
  const btn = $("#rescan"); btn.classList.add("spin");
  try {
    const r = await api("/api/rescan", { method: "POST" });
    await loadLibrary(); route();
    toast(r.tracks != null ? `Library updated: ${plural(r.albums, "album")}, ${plural(r.tracks, "song")}` : "A refresh is already running");
  } catch { toast("Refresh failed"); }
  btn.classList.remove("spin");
}
$("#rescan").onclick = rescan;
$('[data-action="rescan"]').onclick = () => { closeMenu(); rescan(); };

addEventListener("hashchange", route);
loadLibrary().then(route).catch((e) => {
  if (e.message !== "login") $("#view").innerHTML = `<div class="page"><div class="empty"><h2>Couldn't reach the void.</h2>Check that the server is running, then reload.</div></div>`;
});
