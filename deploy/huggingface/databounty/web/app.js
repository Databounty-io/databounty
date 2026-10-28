// SPDX-License-Identifier: Apache-2.0
// The Space's page: DataBounty's console for contributors and validators, drawn from webapi.py's data.
// Everything dynamic goes through html`` (escaped). Only icons and markup built here are raw.
"use strict";

const SESSION_KEY = "databounty-space-session";
const NONCE_KEY = "databounty-signin";
const METHODS = [["human", "I wrote it"], ["ai_assisted", "With AI help"], ["ai_generated", "AI generated"]];
const LEVELS = ["beginner", "intermediate", "advanced"];
const POOL_PAGE = 12;

const state = {
  session: read(localStorage, SESSION_KEY),
  me: null,
  pools: null,
  filters: { q: "", level: "" },
  poolLimit: POOL_PAGE,
};

// --- Small helpers ------------------------------------------------------------------------------

function read(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}
function write(storage, key, value) {
  try { value == null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* storage blocked */ }
}

class Raw { constructor(value) { this.value = value; } }
const raw = (value) => new Raw(value);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function part(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === false || value == null) return "";
  return esc(value);
}
function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""));
}
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
// A tool's description is written for agents; people get its first sentence.
const firstSentence = (text) => {
  const first = String(text || "").split(/(?<=[.!?])\s/)[0];
  return first.length > 170 ? `${first.slice(0, 169)}…` : first;
};
// Links from data only ever leave as http(s).
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || "")) ? url : "#");
const initial = (name) => (String(name || "?").trim().charAt(0) || "?").toUpperCase();
const embedded = () => window.top !== window.self;
const mount = (target, content) => { if (target) target.innerHTML = part(content); };
const notice = (tone, content) => html`<div class="notice notice-${tone}">${content}</div>`;

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

const ICONS = {
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  terminal: '<path d="m8 9 3 3-3 3"/><path d="M13 15h3"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  briefcase: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
};
const icon = (name) => raw(`<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`);

// --- Talking to the Space ------------------------------------------------------------------------

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { Accept: "application/json" };
  if (state.session) headers.Authorization = `Bearer ${state.session}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new Error("Couldn't reach the Space. Check your connection and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401 && state.session) {
    forget();
    route();
    toast("Your sign-in ended. Sign in again to continue.");
  }
  if (!res.ok) {
    const message = data && (data.error || (typeof data.detail === "string" && data.detail));
    const error = new Error(message || `Something went wrong (${res.status}). Try again.`);
    error.status = res.status;
    error.needs = (data && data.needs) || "";
    throw error;
  }
  return data;
}

let overviewLoad = null;
function overview() {
  overviewLoad ??= api("/api/overview").catch(() => {
    overviewLoad = null; // try again next time
    return { stats: {}, tiers: [] };
  });
  return overviewLoad;
}

// --- Signing in (account.py explains the whole flow) --------------------------------------------------
// The page keeps a random secret in sessionStorage and starts with only its hash. At the Space's own
// address it signs in in the same tab. Inside the huggingface.co embed, which may open windows but not
// leave the page, it opens a small sign-in window and checks every 1.5 s whether the sign-in finished.

function signInNote(text) {
  $$("[data-signin-note]").forEach((el) => { el.textContent = text; });
  toast(text);
}

let signInAttempt = 0;

async function startSignIn() {
  const attempt = ++signInAttempt;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
  try { sessionStorage.setItem(NONCE_KEY, nonce); } catch {
    signInNote("This browser blocked the page's storage, so sign-in can't finish here. Open the Space at its own address and try again.");
    return;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const n = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!embedded()) { location.assign(`/oauth/start?n=${n}`); return; }
  const w = 520, h = 720;
  const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || w) - w) / 2);
  const top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || h) - h) / 2);
  const win = window.open(`/oauth/start?popup=1&n=${n}`, "databounty-signin", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  // huggingface.co serves its page with Cross-Origin-Opener-Policy: same-origin, so the window
  // opens but this frame gets no handle to it (null). Null is not "blocked": wait either way.
  signInNote(win
    ? "Finish signing in in the window that opened. This page updates by itself."
    : "Finish signing in in the sign-in window. This page updates by itself. No window? Allow pop-ups for this page and try again.");
  const deadline = Date.now() + 10 * 60 * 1000;
  const check = async () => {
    if (attempt !== signInAttempt || state.session) return;
    if (Date.now() > deadline) { signInNote("Sign-in timed out. Press sign in to try again."); return; }
    try {
      const res = await fetch(`/oauth/status?n=${n}`, { cache: "no-store" });
      if (res.ok && (await res.json()).ready && (await claimSignIn(nonce))) { await afterSignIn(); return; }
    } catch { /* try again */ }
    setTimeout(check, 1500);
  };
  setTimeout(check, 1500);
}

async function claimSignIn(nonce = read(sessionStorage, NONCE_KEY)) {
  if (!nonce) return false;
  try {
    const { session } = await api("/api/session/claim", { method: "POST", body: { nonce } });
    state.session = session;
    write(localStorage, SESSION_KEY, session);
    write(sessionStorage, NONCE_KEY, null);
    return true;
  } catch {
    return false;
  }
}

async function afterSignIn() {
  await loadMe();
  toast(state.me ? `Signed in as ${state.me.displayName || "@" + state.me.handle}.` : "Signed in.");
  route();
}

async function loadMe() {
  if (!state.session) { state.me = null; return; }
  try { state.me = await api("/api/me"); } catch { state.me = null; }
}

function forget() {
  state.session = null;
  state.me = null;
  write(localStorage, SESSION_KEY, null);
}

async function signOut() {
  try { await api("/api/session/sign-out", { method: "POST" }); } catch { /* signed out here either way */ }
  forget();
  toast("You're signed out.");
  route();
}

// --- Sidebar --------------------------------------------------------------------------------------

const NAV = [
  ["#/", "home", "Home"],
  ["#/contribute", "code", "Contribute"],
  ["#/validate", "shield", "Validate"],
  ["#/sponsor", "briefcase", "Sponsor"],
  ["#/datasets", "database", "Datasets"],
  ["#/leaderboard", "trophy", "Leaderboard"],
  ["#/agents", "terminal", "API & MCP"],
  ["#/about", "info", "About"],
];

function activeNav() {
  const hash = location.hash || "#/";
  if (hash === "#/" || hash === "#") return "#/";
  if (hash.startsWith("#/validate") || hash.startsWith("#/audit/")) return "#/validate";
  if (hash.startsWith("#/sponsor")) return "#/sponsor";
  if (hash.startsWith("#/datasets")) return "#/datasets";
  if (hash.startsWith("#/leaderboard") || hash.startsWith("#/u/")) return "#/leaderboard";
  if (hash.startsWith("#/agents")) return "#/agents";
  if (hash.startsWith("#/about")) return "#/about";
  return "#/contribute"; // the workspace, a pool, a submission
}

function renderSidebar() {
  const active = activeNav();
  mount($("#sidebar"), html`
    <a class="brand" href="#/"><img src="/static/logo.svg" alt=""><span>DATA<b>/</b>BOUNTY</span></a>
    <nav class="nav">${NAV.map(([href, ic, label]) => html`<a href="${href}" class="${href === active ? "active" : ""}">${icon(ic)}${label}</a>`)}</nav>
    <button class="top-action" data-action="sign-in">sign in</button>
    <div class="side-bottom"><div class="side-signin"><p data-signin-note>Sign in to contribute items and earn karma.</p><button class="btn btn-lime btn-sm" data-action="sign-in">sign in ${icon("arrow")}</button></div></div>`);
}

// --- Routing --------------------------------------------------------------------------------------

let renderToken = 0;
// Each page takes a ticket; a page whose ticket is stale (the person moved on) stops drawing.
function ticket() {
  const mine = ++renderToken;
  return () => mine === renderToken;
}

const ROUTES = [
  [/^#\/?$/, () => pageHome()],
  [/^#\/contribute$/, () => pageContribute()],
  [/^#\/pool\/([\w-]+)$/, (id) => pagePool(id)],
  [/^#\/submission\/([\w-]+)$/, (id) => pageSubmission(id)],
  [/^#\/validate$/, () => pageValidate()],
  [/^#\/audit\/([\w-]+)$/, (id) => pageAudit(id)],
  [/^#\/sponsor$/, () => pageSponsor()],
  [/^#\/datasets$/, () => pageDatasets()],
  [/^#\/leaderboard$/, () => pageLeaderboard()],
  [/^#\/u\/([\w.-]+)$/, (handle) => pageProfile(handle)],
  [/^#\/agents$/, () => pageAgents()],
  [/^#\/about$/, () => pageAbout()],
];

function route() {
  const hash = location.hash || "#/";
  // Signed in, the Space is drawn like the DataBounty console (console.js).
  if (state.me && typeof consoleRoute === "function") { consoleRoute(hash); return; }
  document.body.classList.remove("console", "c-collapsed");
  renderSidebar();
  for (const [pattern, page] of ROUTES) {
    const match = hash.match(pattern);
    if (match) {
      window.scrollTo(0, 0);
      page(...match.slice(1).map(decodeURIComponent));
      return;
    }
  }
  location.replace("#/");
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "sign-in") { event.preventDefault(); startSignIn(); }
  else if (action === "sign-out") { event.preventDefault(); signOut(); }
  else if (action === "copy") {
    event.preventDefault();
    navigator.clipboard?.writeText(el.dataset.copy || "").then(() => toast("Copied."), () => toast("Couldn't copy. Select the text instead."));
  }
});

// --- Home -------------------------------------------------------------------------------------------

const ROLES = [
  ["#/contribute", "code", "Contribute", "Add items to open pools. Earn karma for each one reviewers accept."],
  ["#/validate", "shield", "Validate", "Check other people's items against the pool's spec. Earn karma for each decision."],
  ["#/sponsor", "briefcase", "Sponsor", "Ask for the dataset you need, and follow the items that come in."],
];

function statTiles(s) {
  const tiles = [["items accepted", s.acceptedItems], ["dataset programmes", s.programs], ["contributors", s.contributors], ["datasets published", s.publishedDatasets], ["karma awarded", s.totalKarmaAwarded]];
  return html`<div class="tiles">${tiles.map(([label, value]) => html`<div class="card tile"><div class="micro">${label}</div><b>${fmt(value)}</b></div>`)}</div>`;
}

async function pageHome() {
  const live = ticket();
  mount($("#page"), html`
    <section class="card hero">
      <div>
        <div class="micro">databounty on hugging face</div>
        <h1>Open datasets for AI, built by the community</h1>
        <p>Sponsors ask for a dataset. Contributors add items, validators check every one, and the finished dataset is published on the Hugging Face Hub.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/contribute">${icon("code")} start contributing</a>
          <a class="btn" href="#/validate">${icon("shield")} review items</a>
          <a class="btn" href="#/sponsor">${icon("briefcase")} request a dataset</a>
        </div>
      </div>
      <img class="hero-mark" src="/static/logo.svg" alt="">
    </section>
    <div id="home-tiles" style="margin-top:14px"><div class="skeleton"></div></div>
    <h2 class="section">Three ways to take part</h2>
    <div class="roles">${ROLES.map(([href, ic, title, text]) => html`<a class="card role" href="${href}"><span class="role-icon">${icon(ic)}</span><b>${title}</b><span class="small muted">${text}</span><span class="row-arrow">${icon("arrow")}</span></a>`)}</div>
    <h2 class="section">Open pools</h2>
    <p class="section-sub">A few of the pools taking items now.</p>
    <div class="rows" id="home-pools">${[1, 2, 3].map(() => html`<div class="skeleton"></div>`)}</div>
    <p style="margin-top:12px"><a class="btn btn-sm" href="#/contribute">see all open pools ${icon("arrow")}</a></p>`);
  overview().then((data) => { if (live()) mount($("#home-tiles"), statTiles(data.stats || {})); });
  if (!state.pools) {
    try { state.pools = (await api("/api/pools")).pools || []; } catch (e) {
      if (live()) mount($("#home-pools"), notice("warn", e.message));
      return;
    }
  }
  if (!live()) return;
  const pools = state.pools.slice(0, 4);
  mount($("#home-pools"), pools.length ? pools.map(poolRow) : html`<div class="card empty">No pools are open right now. New ones open as sponsors' requests are approved.</div>`);
}

// --- Contributor workspace ----------------------------------------------------------------------------

function signInCard(title = "Sign in to contribute", text = raw("Earn <b>karma</b> for every item reviewers accept. Use your DataBounty account, or create one on the way.")) {
  return html`<div class="card signin-card">
    <img src="/static/logo.svg" alt="">
    <div><h2>${title}</h2><p>${text}</p></div>
    <div class="signin-actions">
      <button class="btn btn-primary" data-action="sign-in">sign in with DataBounty ${icon("arrow")}</button>
      <span class="note" data-signin-note>${embedded() ? "" : "You'll come straight back here."}</span>
    </div>
  </div>`;
}

async function pageContribute() {
  const live = ticket();
  mount($("#page"), html`
    <header class="page-head"><h1 class="title">Contributor workspace</h1><p class="sub">Open community pools, your submissions and your karma.</p></header>
    <div class="stack">${signInCard()}</div>
    <h2 class="section">Available work</h2>
    <p class="section-sub">Pick a pool and submit items directly. Every item is checked automatically, then reviewed by a person.</p>
    <div class="filters">
      <label class="search">${icon("search")}<input class="input" id="pool-q" placeholder="Search pools or dataset types…" value="${state.filters.q}" aria-label="Search pools"></label>
      <select class="select" id="pool-level" aria-label="Level"><option value="">All levels</option>${LEVELS.map((l) => html`<option value="${l}" ${state.filters.level === l ? raw("selected") : ""}>${cap(l)}</option>`)}</select>
      <span class="count" id="pool-count"></span>
    </div>
    <div class="rows" id="pool-list">${[1, 2, 3].map(() => html`<div class="skeleton"></div>`)}</div>`);
  $("#pool-q").addEventListener("input", (e) => { state.filters.q = e.target.value; state.poolLimit = POOL_PAGE; renderPoolList(); });
  $("#pool-level").addEventListener("change", (e) => { state.filters.level = e.target.value; state.poolLimit = POOL_PAGE; renderPoolList(); });
  if (!state.pools) {
    try { state.pools = (await api("/api/pools")).pools || []; } catch (e) {
      if (live()) mount($("#pool-list"), notice("warn", e.message));
      return;
    }
  }
  if (live()) renderPoolList();
}

function renderPoolList() {
  const list = $("#pool-list");
  if (!list || !state.pools) return;
  const words = state.filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const pools = state.pools.filter((p) =>
    (!state.filters.level || p.difficulty === state.filters.level) &&
    words.every((w) => `${p.title} ${p.dataset_type} ${p.language} ${p.category}`.toLowerCase().includes(w)));
  const shown = pools.slice(0, state.poolLimit);
  const left = pools.length - shown.length;
  $("#pool-count").textContent = `${pools.length} open`;
  mount(list, pools.length
    ? [shown.map(poolRow), left > 0 ? html`<button class="btn more" id="pool-more">show ${Math.min(POOL_PAGE, left)} more · ${left} left</button>` : ""]
    : html`<div class="card empty">No open pool matches. Try another search.</div>`);
  $("#pool-more")?.addEventListener("click", () => { state.poolLimit += POOL_PAGE; renderPoolList(); });
}

function poolRow(p) {
  const target = p.target_items || 0;
  const accepted = p.accepted_items || 0;
  const pct = target ? Math.min(100, Math.round((accepted / target) * 100)) : 0;
  return html`<a class="card pool-row" href="#/pool/${encodeURIComponent(p.id)}">
    <div class="head"><span class="pool-title">${p.title}</span><span class="pill pill-karma">direct submit</span>${p.difficulty ? html`<span class="pill">${p.difficulty}</span>` : ""}</div>
    <div class="cap"><span class="mono small muted">${fmt(accepted)} / ${fmt(target)} accepted</span><div class="progress"><span style="width:${pct}%"></span></div><span class="mono small strong">${pct}%</span></div>
    <div class="mono small">${typeof p.karma_per_accepted_item === "number" ? html`<span class="karma-text">+${fmt(p.karma_per_accepted_item)} karma / item</span> · ` : ""}<span class="muted">${p.dataset_type}${p.language ? ` · ${p.language}` : ""}${p.in_review_items ? ` · ${fmt(p.in_review_items)} in review` : ""}</span></div>
    <span class="row-arrow">${icon("arrow")}</span>
  </a>`;
}

function subRow(s) {
  return html`<a class="card sub-row" href="#/submission/${encodeURIComponent(s.id)}">
    <div class="head"><span class="sub-title">${s.title}</span><span class="pill pill-${s.statusTone}">${s.statusLabel}</span></div>
    <div class="mono small muted">${s.pool}${s.date ? ` · ${s.date}` : ""}</div>
    <span class="row-arrow">${icon("arrow")}</span>
  </a>`;
}

// --- A pool --------------------------------------------------------------------------------------

const backToPools = () => html`<a class="back" href="#/contribute">${icon("back")} all pools</a>`;
const labelFor = (c, key) => (c.fields.find((f) => f.key === key) || { label: key }).label;

async function pagePool(id) {
  const live = ticket();
  const page = $("#page");
  mount(page, html`${backToPools()}<div class="skeleton" style="height:140px"></div>`);
  let c;
  try { c = await api(`/api/pools/${encodeURIComponent(id)}/contract`); } catch (e) {
    if (live()) mount(page, html`${backToPools()}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  if (!c.signedIn && state.session) {
    forget();
    renderSidebar();
    toast("Your sign-in ended. Sign in again to continue.");
  }
  const meta = [c.karma ? `+${fmt(c.karma)} karma / accepted item` : "", cap(c.difficulty), c.language].filter(Boolean).join(" · ");
  mount(page, html`${backToPools()}
    <header class="page-head"><h1 class="title">${c.title}</h1><p class="sub">Community open pool${meta ? ` · ${meta}` : ""}</p></header>
    <div class="card cap-card"><div class="row"><span class="pill pill-karma">no claim needed — submit directly</span><span class="mono small muted">${c.remaining != null ? `${fmt(c.remaining)} items still wanted` : ""}${c.license ? ` · licence ${c.license}` : ""}</span></div></div>
    ${contractCard(c)}
    <div id="sponsor-panel"></div>
    <div id="pool-work"></div>`);
  renderPoolWork(c);
  if (state.me && state.me.canSponsor) renderSponsorPanel(c, live);
}

function contractCard(c) {
  const sample = c.samples[0];
  return html`<div class="card contract">
    <div class="micro">dataset contract</div>
    <h3>${c.typeName || c.title}</h3>
    <div class="chips">${c.pipeline.map((p) => html`<span class="pill ${p.key === "execution" ? "pill-ok" : ""}">${p.label}</span>`)}</div>
    ${c.tip ? html`<p class="tip">${c.tip}</p>` : ""}
    <div class="contract-grid">
      <div class="mini"><div class="micro">what you submit</div>${c.fields.map((f) => html`<div class="kv"><span>${f.label}${f.required ? "" : html` <span class="opt">optional</span>`}</span><span>${f.hint || f.role}</span></div>`)}</div>
      <div class="mini"><div class="micro">how it's checked</div><ul class="steps">${c.pipeline.map((p) => html`<li><b>${p.label}</b> · ${p.what}</li>`)}</ul></div>
    </div>
    ${sample ? html`<details class="disclose"><summary>${icon("eye")} See an example item</summary><div class="body">
      <p class="hint" style="margin:12px 0 0">An approved example from this pool. Use it to see the format, then write your own: copies are rejected.</p>
      ${Object.entries(sample).map(([key, value]) => html`<div class="spec"><div class="micro">${labelFor(c, key)}</div><pre class="block">${typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>`)}
    </div></details>` : ""}
    <details class="disclose"><summary>${icon("file")} Full requirements</summary><div class="body">
      ${c.description ? html`<div class="spec"><div class="micro">about this pool</div><p>${c.description}</p></div>` : ""}
      ${c.fields.map((f) => html`<div class="spec"><div class="micro">${f.label} · ${f.required ? "required" : "optional"} · column ${f.key}</div><p>${f.help || f.hint}</p></div>`)}
    </div></details>
  </div>`;
}

function renderPoolWork(c) {
  const box = $("#pool-work");
  const spaced = (content) => html`<div style="margin-top:22px">${content}</div>`;
  if (!state.me) { mount(box, spaced(signInCard())); return; }
  if (state.me.step !== "ready") { mount(box, spaced(notice("warn", raw('Finish setting up your account on the <a href="#/contribute">Contribute</a> page first.')))); return; }
  if (!c.open) { mount(box, spaced(notice("warn", `This pool isn't taking items right now. ${c.nextStep}`))); return; }
  const hasFiles = c.fields.some((f) => f.kind === "file");
  mount(box, html`
    <div class="seg-row"><div class="seg" role="tablist"><button class="on" data-mode="one" role="tab">Single item</button><button data-mode="bulk" role="tab">Bulk upload</button></div><span class="mono small muted">Bulk: CSV / TSV / JSON / JSONL</span></div>
    <div id="mode-one">${itemForm(c)}</div>
    <div id="mode-bulk" hidden>${bulkPanel(c, hasFiles)}</div>`);
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    $$("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    $("#mode-one").hidden = b.dataset.mode !== "one";
    $("#mode-bulk").hidden = b.dataset.mode !== "bulk";
  }));
  wireItemForm(c);
  wireBulk(c);
}

function fieldInput(f) {
  if (f.kind === "enum") return html`<select class="select" data-key="${f.key}"><option value="">Pick one…</option>${f.options.map((o) => html`<option value="${o}">${o}</option>`)}</select>`;
  if (f.kind === "file") return html`<input type="file" class="input" data-file="${f.key}" ${f.maxCount > 1 ? raw("multiple") : ""} ${f.accept ? raw(`accept="${esc(f.accept)}"`) : ""}>`;
  if (f.kind === "code") return html`<textarea class="textarea code" data-key="${f.key}" spellcheck="false" placeholder="${f.label}"></textarea>`;
  if (f.kind === "list") return html`<textarea class="textarea" data-key="${f.key}" placeholder="One per line"></textarea>`;
  if (f.kind === "longtext") return html`<textarea class="textarea" data-key="${f.key}" placeholder="${f.label}"></textarea>`;
  return html`<input class="input" data-key="${f.key}" placeholder="${f.label}">`;
}

function itemForm(c) {
  return html`<form class="card form" id="item-form" novalidate>
    ${c.fields.map((f) => html`<div class="field">
      <div class="field-label"><span class="micro">${f.label}</span>${f.required ? html`<span class="req">*</span>` : html`<span class="opt">optional</span>`}<span class="key-chip">${f.key}</span>${f.language ? html`<span class="lang-chip">${f.language}</span>` : ""}</div>
      ${fieldInput(f)}
      ${f.hint ? html`<div class="hint">${f.hint}</div>` : ""}
    </div>`)}
    <div class="two">
      <div class="field"><div class="field-label"><span class="micro">title</span><span class="opt">optional</span></div><input class="input" id="item-title" maxlength="120" placeholder="Leave empty to use the start of your task"></div>
      <div class="field"><div class="field-label"><span class="micro">generation method</span><span class="req">*</span></div>
        <select class="select" id="item-method"><option value="">Select how this item was made…</option>${METHODS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
        <div class="hint">AI help is allowed, as long as you say so.</div></div>
    </div>
    <div class="attest"><div class="micro">attestations</div>
      <label><input type="checkbox" data-attest> This is my original work.</label>
      <label><input type="checkbox" data-attest> It contains no private code and isn't copied from a public benchmark.</label>
      <label><input type="checkbox" data-attest> I grant the license this pool publishes under${c.license ? ` (${c.license})` : ""}.</label>
    </div>
    <div class="stage-bar">${icon("shield")}<span>Validation stages: ${c.pipeline.map((p) => p.label).join(" → ")}.</span></div>
    <div class="form-foot"><span class="mono small muted" id="item-missing"></span><button class="btn btn-submit" id="item-submit" type="submit" disabled>${icon("send")} Submit item</button></div>
    <div id="item-result"></div>
  </form>`;
}

function missingText(c, form) {
  const empty = c.fields.filter((f) => {
    if (!f.required) return false;
    if (f.kind === "file") return !(($(`[data-file="${CSS.escape(f.key)}"]`, form) || {}).files || []).length;
    return !(($(`[data-key="${CSS.escape(f.key)}"]`, form) || {}).value || "").trim();
  });
  if (empty.length) return `Fill in ${empty.map((f) => f.label).join(", ")}.`;
  if (!$("#item-method", form).value) return "Choose how you made it.";
  if (!$$("[data-attest]", form).every((x) => x.checked)) return "Tick the three attestations.";
  return "";
}

function insertTabs(textarea) {
  textarea.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    textarea.value = value.slice(0, start) + "    " + value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 4;
  });
}

function wireItemForm(c) {
  const form = $("#item-form");
  const button = $("#item-submit");
  const out = $("#item-result");
  let busy = false;
  const update = () => {
    const missing = missingText(c, form);
    $("#item-missing").textContent = missing || (c.karma ? `earns +${fmt(c.karma)} karma on acceptance` : "ready to submit");
    button.disabled = busy || Boolean(missing);
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  $$("textarea.code", form).forEach(insertTabs);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || missingText(c, form)) return;
    const data = new FormData();
    const values = {};
    for (const f of c.fields) {
      if (f.kind === "file") {
        const input = $(`[data-file="${CSS.escape(f.key)}"]`, form);
        [...((input && input.files) || [])].forEach((file) => data.append(`file:${f.key}`, file));
      } else {
        const el = $(`[data-key="${CSS.escape(f.key)}"]`, form);
        values[f.key] = el ? el.value : "";
      }
    }
    data.append("values", JSON.stringify(values));
    data.append("title", $("#item-title").value);
    data.append("method", $("#item-method").value);
    busy = true;
    button.disabled = true;
    mount(button, html`${icon("refresh")} Submitting…`);
    try {
      const r = await api(`/api/pools/${encodeURIComponent(c.id)}/items`, { method: "POST", form: data });
      if (r.duplicate) {
        mount(out, notice("warn", "The same item is already in this pool, so it wasn't added."));
      } else {
        mount(out, notice("ok", html`<b>Submitted ✓</b> Automated checks start now, then a reviewer takes a look.${c.karma ? html` You earn <b>+${fmt(c.karma)} karma</b> if it's accepted.` : ""} <a href="#/contribute">See it in My submissions →</a>`));
        form.reset();
      }
    } catch (err) {
      mount(out, notice("bad", html`<b>Not sent.</b> ${err.message}`));
    } finally {
      busy = false;
      mount(button, html`${icon("send")} Submit item`);
      update();
      out.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  update();
}

function bulkPanel(c, hasFiles) {
  return html`<div class="card pad stack">
    <p class="muted" style="margin:0">Add many items at once, one item per row. Start from the template so the columns match.${hasFiles ? " Items with files are added one at a time." : ""}</p>
    <div class="row"><a class="btn btn-sm" href="/api/pools/${encodeURIComponent(c.id)}/template.csv" download>${icon("download")} download CSV template</a></div>
    <label class="dropzone" id="bulk-drop">${icon("upload")}<span>Choose a file or drop it here</span><span class="small">CSV, TSV, JSON or JSONL · up to 500 rows</span><input type="file" id="bulk-file" accept=".csv,.tsv,.json,.jsonl,.ndjson"></label>
    <div id="bulk-preview"></div>
  </div>`;
}

function wireBulk(c) {
  const input = $("#bulk-file");
  const drop = $("#bulk-drop");
  if (!input) return;
  const take = (file) => { if (file) previewBulk(c, file); };
  // Cleared after each pick, so picking the same file again (after fixing it) previews it again.
  input.addEventListener("change", () => { take(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => take(e.dataTransfer.files[0]));
}

async function previewBulk(c, file) {
  const box = $("#bulk-preview");
  mount(box, html`<div class="skeleton" style="height:80px"></div>`);
  const form = new FormData();
  form.append("file", file);
  let data;
  try { data = await api(`/api/pools/${encodeURIComponent(c.id)}/bulk/preview`, { method: "POST", form }); } catch (e) {
    mount(box, notice("bad", e.message));
    return;
  }
  const rows = data.rows || [];
  const ready = rows.filter((r) => r.ok);
  mount(box, html`
    ${!rows.length ? notice("warn", "That file has no rows.") : ready.length === rows.length
      ? notice("ok", `All ${rows.length} rows are ready. Untick any you don't want to send.`)
      : notice("warn", `${ready.length} of ${rows.length} rows are ready. Rows marked ✗ won't be sent: fix them in your file and upload it again.`)}
    ${rows.length ? html`<div class="table-wrap" style="margin-top:12px"><table class="list">
      <thead><tr><th style="width:52px">send</th><th style="width:60px">row</th><th>check</th><th>title</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td><input type="checkbox" data-row="${r.number}" ${r.ok ? raw("checked") : raw("disabled")}></td><td class="mono small">${r.number}</td><td class="small ${r.ok ? "ok-text" : "bad-text"}">${r.ok ? "✓ ready" : `✗ ${r.problem}`}</td><td>${r.title}</td></tr>`)}</tbody>
    </table></div>` : ""}
    ${ready.length ? html`
      <div class="two" style="margin-top:14px"><div class="field"><div class="field-label"><span class="micro">generation method</span><span class="req">*</span></div>
        <select class="select" id="bulk-method"><option value="">Select how these items were made…</option>${METHODS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></div></div>
      <div class="attest" style="margin-top:12px"><label><input type="checkbox" id="bulk-attest"> I attest these items are my original work, contain no private code, aren't copied from a public benchmark, and I grant the license this pool publishes under${c.license ? ` (${c.license})` : ""}.</label></div>
      <div class="form-foot" style="margin-top:12px"><span class="mono small muted" id="bulk-count"></span><button class="btn btn-submit" id="bulk-send" disabled>${icon("send")} send items</button></div>
      <div id="bulk-out" style="margin-top:12px"></div>` : ""}`);
  if (!ready.length) return;
  let sent = false; // once sent, these rows can't go again: upload the file again to send more
  let busy = false;
  const update = () => {
    const n = $$("[data-row]:checked", box).length;
    $("#bulk-count").textContent = sent ? "Sent. To add more, choose another file." : `${n} item${n === 1 ? "" : "s"} selected`;
    $("#bulk-send").disabled = sent || busy || !(n && $("#bulk-method").value && $("#bulk-attest").checked);
  };
  box.onchange = update; // replaces the handler of an earlier file's preview
  update();
  $("#bulk-send").addEventListener("click", async () => {
    const chosen = new Set($$("[data-row]:checked", box).map((x) => Number(x.dataset.row)));
    const send = rows.filter((r) => r.ok && chosen.has(r.number)).map(({ number, title, payload }) => ({ number, title, payload }));
    if (busy || sent || !send.length) return;
    busy = true;
    $("#bulk-send").disabled = true;
    try {
      const r = await api(`/api/pools/${encodeURIComponent(c.id)}/bulk/send`, { method: "POST", body: { method: $("#bulk-method").value, rows: send } });
      const extra = [r.duplicates ? `${r.duplicates} already in the pool, so not added.` : "", r.skipped ? `${r.skipped} didn't pass the check, so not sent.` : ""].filter(Boolean).join(" ");
      mount($("#bulk-out"), html`${notice(r.sent ? "ok" : "warn", html`<b>${r.sent ? `${r.sent} item${r.sent === 1 ? "" : "s"} sent ✓` : "Nothing was sent."}</b> ${extra} <a href="#/contribute">See them in My submissions →</a>`)}${r.problem ? html`<div style="margin-top:8px">${notice("warn", r.problem)}</div>` : ""}`);
      sent = r.sent > 0;
    } catch (e) {
      mount($("#bulk-out"), notice("bad", e.message));
    } finally {
      busy = false;
      update();
    }
  });
}

// --- A submission --------------------------------------------------------------------------------------

async function pageSubmission(id) {
  const live = ticket();
  const page = $("#page");
  const back = html`<a class="back" href="#/contribute">${icon("back")} contributor workspace</a>`;
  if (!state.session) { mount(page, html`${back}${signInCard()}`); return; }
  mount(page, html`${back}<div class="skeleton" style="height:180px"></div>`);
  let s;
  try { s = await api(`/api/submissions/${encodeURIComponent(id)}`); } catch (e) {
    if (live()) mount(page, html`${back}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  const icons = { pass: "check", fail: "x", wait: "clock", note: "alert" };
  mount(page, html`${back}
    <header class="page-head"><div class="row wrap"><h1 class="title" style="margin:0">${s.title}</h1><span class="pill pill-${s.statusTone}">${s.statusLabel}</span></div><p class="sub" style="margin-top:6px">${s.pool}${s.date ? ` · submitted ${s.date}` : ""}</p></header>
    <div class="card pad"><div class="micro">checks</div>
      ${s.checks.length ? html`<ul class="checks">${s.checks.map((ch) => html`<li class="check check-${ch.state}"><span class="check-icon">${icon(icons[ch.state])}</span><div><b>${ch.label}</b>${ch.reason ? html`<span>${ch.reason}</span>` : ""}</div></li>`)}</ul>` : html`<p class="muted" style="margin:10px 0 0">No checks have run yet.</p>`}
      ${s.recheckAfter ? html`<p class="hint" style="margin:12px 0 0">Checks are still running. Look again in about ${s.recheckAfter} seconds.</p>` : ""}
    </div>
    ${s.notes.map((note) => html`<div style="margin-top:12px">${notice("warn", html`<b>Reviewer note.</b> ${note}`)}</div>`)}
    ${s.fixUrl ? html`<div style="margin-top:14px"><a class="btn btn-primary" href="${safeUrl(s.fixUrl)}" target="_blank" rel="noopener">fix it on databounty.io ${icon("external")}</a></div>` : ""}`);
}

// --- Reviewing (validators) -----------------------------------------------------------------------------
// An audit is a few items from one pool. Claiming it makes it yours for 24 hours; you approve each
// item or reject it with a reason and a note, and every decision is final (DataBounty's rules).

const FLAG_REASONS = [
  ["duplicate", "Duplicate or near-duplicate"],
  ["contaminated", "Copied from a public benchmark"],
  ["tests_invalid", "Tests are wrong"],
  ["solution_incorrect", "Solution is wrong"],
  ["too_trivial", "Too easy"],
  ["low_quality", "Low quality"],
  ["off_spec", "Doesn't follow the pool's spec"],
  ["other", "Something else"],
];
const MIN_NOTE = 10;
const CHECK_ICONS = { pass: "check", fail: "x", wait: "clock", note: "alert" };

function dueText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "past due";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 1 ? `due in ${h}h ${m}m` : `due in ${m}m`;
}

const reviewHead = () => html`<header class="page-head"><h1 class="title">Validator workspace</h1><p class="sub">Review other people's items against the pool's spec. Earn karma for every decision.</p></header>`;
const reviewSignIn = () => signInCard("Sign in to review", "Check other people's items against the pool's spec, and earn karma for every decision.");

function howReviewing() {
  return html`<h2 class="section">How reviewing works</h2>
    <div class="card pad"><ol class="how">
      <li><span><b>Claim an open audit.</b> It's yours for 24 hours, and you never get your own work.</span></li>
      <li><span><b>Check each item</b> against the pool's spec and its automated checks.</span></li>
      <li><span><b>Approve it, or reject it</b> with a reason and a note for the contributor.</span></li>
      <li><span><b>Earn karma</b> for every decision when the audit completes.</span></li>
    </ol></div>`;
}

function auditRow(a, claimable) {
  const pct = a.items ? Math.min(100, Math.round((100 * a.decided) / a.items)) : 0;
  const due = a.deadline && a.status !== "completed" ? dueText(a.deadline) : "";
  const body = html`
    <div class="head"><span class="pool-title">${a.pool}</span><span class="pill pill-${a.statusTone}">${a.statusLabel}</span>${a.language ? html`<span class="pill">${a.language}</span>` : ""}</div>
    <div class="cap"><span class="mono small muted">${fmt(a.decided)} / ${fmt(a.items)} decided</span><div class="progress"><span style="width:${pct}%"></span></div><span class="mono small strong">${pct}%</span></div>
    <div class="mono small">${typeof a.karma === "number" ? html`<span class="karma-text">+${fmt(a.karma)} karma / decision</span> · ` : ""}<span class="muted">${a.items} item${a.items === 1 ? "" : "s"}${a.category ? ` · ${a.category}` : ""}${due ? ` · ${due}` : ""}</span></div>`;
  if (claimable) return html`<div class="card pool-row has-action">${body}<button class="btn btn-primary btn-sm row-action" data-claim="${a.id}">claim</button></div>`;
  return html`<a class="card pool-row" href="#/audit/${encodeURIComponent(a.id)}">${body}<span class="row-arrow">${icon("arrow")}</span></a>`;
}

async function claimAudit(id, button) {
  if (button) { button.disabled = true; button.textContent = "claiming…"; }
  try {
    await api(`/api/audits/${encodeURIComponent(id)}/claim`, { method: "POST" });
    await loadMe(); // one more slot in use
    if (location.hash === `#/audit/${id}`) pageAudit(id);
    else location.hash = `#/audit/${encodeURIComponent(id)}`;
  } catch (e) {
    toast(e.message);
    if (button) { button.disabled = false; button.textContent = "claim"; }
  }
}

function pageValidate() {
  ticket(); // a page still loading stops drawing
  mount($("#page"), html`${reviewHead()}${reviewSignIn()}${howReviewing()}`);
}

async function pageAudit(id) {
  const live = ticket();
  const page = $("#page");
  const back = html`<a class="back" href="#/validate">${icon("back")} validator workspace</a>`;
  if (!state.me) { mount(page, html`${back}${reviewSignIn()}`); return; }
  mount(page, html`${back}<div class="skeleton" style="height:180px"></div>`);
  let a;
  try { a = await api(`/api/audits/${encodeURIComponent(id)}`); } catch (e) {
    if (!live()) return;
    if (e.needs === "claim") {
      mount(page, html`${back}<div class="card setup-card"><h2>Claim this audit</h2><p>${e.message}</p><button class="btn btn-primary" id="claim-here">claim audit</button></div>`);
      $("#claim-here").addEventListener("click", (ev) => claimAudit(id, ev.currentTarget));
      return;
    }
    mount(page, html`${back}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  const first = a.items.findIndex((item) => !item.decided);
  renderAudit(a, first === -1 ? 0 : first, back, live);
}

function renderAudit(a, index, back, live) {
  if (!live()) return;
  const item = a.items[index];
  const due = a.deadline && a.decided < a.total ? dueText(a.deadline) : "";
  const pct = a.total ? Math.round((100 * a.decided) / a.total) : 0;
  const mark = (it, i) => it.decided
    ? (it.verdict === "ok" ? html`<span class="mark ok">${icon("check")}</span>` : html`<span class="mark flagged">${icon("x")}</span>`)
    : html`<span class="mark">${i + 1}</span>`;
  const status = !item ? "" : item.decided
    ? (item.verdict === "ok" ? html`<span class="pill pill-ok">Approved</span>` : html`<span class="pill pill-bad">Rejected</span>`)
    : html`<span class="pill pill-info">To decide</span>`;
  mount($("#page"), html`${back}
    <header class="page-head"><h1 class="title">${a.pool}</h1><p class="sub">Audit · ${a.total} item${a.total === 1 ? "" : "s"}${typeof a.karma === "number" ? ` · +${fmt(a.karma)} karma per decision` : ""}${due ? ` · ${due}` : ""}</p></header>
    <div class="card cap-card"><div class="row"><span class="mono small">${fmt(a.decided)} of ${fmt(a.total)} decided</span><span class="mono small muted">${a.typeName}</span></div><div class="progress" style="margin-top:10px"><span style="width:${pct}%"></span></div></div>
    ${a.total && a.decided === a.total ? html`<div style="margin-top:12px">${notice("ok", html`<b>All ${a.total} decisions recorded.</b> The audit closes by itself, and your karma for it is added then. <a href="#/validate">Back to your audits →</a>`)}</div>` : ""}
    ${!item ? html`<div class="card empty" style="margin-top:16px">This audit has no items.</div>` : html`
    <div class="audit-grid">
      <nav class="card item-list" aria-label="Items">${a.items.map((it, i) => html`<button class="${i === index ? "on" : ""}" data-item="${i}">${mark(it, i)}<span class="t">${it.title || `Item ${i + 1}`}</span></button>`)}</nav>
      <article class="card item-card">
        <div><div class="micro">item ${index + 1} of ${a.total}</div>
          <div class="row wrap" style="margin-top:4px"><h2>${item.title || `Item ${index + 1}`}</h2>${status}${item.method ? html`<span class="pill">${item.method}</span>` : ""}</div></div>
        ${a.spec.length ? html`<details class="disclose" style="margin-top:0"><summary>${icon("file")} What this pool asks for</summary><div class="body">${a.spec.map((f) => html`<div class="spec"><div class="micro">${f.label} · ${f.required ? "required" : "optional"}</div><p>${f.hint}</p></div>`)}</div></details>` : ""}
        ${item.fields.map((f) => html`<div><div class="micro">${f.label}</div><pre class="block">${f.value}</pre></div>`)}
        ${item.attachments.length ? html`<div><div class="micro">attachments</div><ul class="files">${item.attachments.map((f) => html`<li>${icon("file")} ${f.name}${typeof f.size === "number" ? html` <span class="muted">· ${fmt(Math.ceil(f.size / 1024))} KB</span>` : ""}</li>`)}</ul><a class="mono small" href="${safeUrl(a.consoleUrl)}" target="_blank" rel="noopener">open the files on databounty.io ${icon("external")}</a></div>` : ""}
        <div><div class="micro">automated checks</div>${item.checks.length
          ? html`<ul class="checks" style="margin-top:6px">${item.checks.map((ch) => html`<li class="check check-${ch.state}"><span class="check-icon">${icon(CHECK_ICONS[ch.state])}</span><div><b>${ch.label}</b>${ch.reason ? html`<span>${ch.reason}</span>` : ""}</div></li>`)}</ul>`
          : html`<p class="hint" style="margin:6px 0 0">No automated checks recorded for this item.</p>`}</div>
        <div id="decision">${item.decided
          ? notice(item.verdict === "ok" ? "ok" : "bad", item.verdict === "ok"
            ? html`<b>Approved.</b> This decision is final.`
            : html`<b>Rejected${item.flagReason ? ` · ${item.flagReason}` : ""}.</b> ${item.note} <span class="muted">This decision is final.</span>`)
          : html`<div class="decide">
            <div class="row between wrap"><span class="hint">Approve it if it meets the spec. Decisions are final.</span><button class="btn btn-submit" id="approve">${icon("check")} approve item</button></div>
            <div class="reject"><div class="micro">or reject it</div>
              <select class="select" id="flag-reason" aria-label="Why you're rejecting it"><option value="">Why are you rejecting it?</option>${FLAG_REASONS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
              <textarea class="textarea" id="flag-note" placeholder="What's wrong, for the contributor. It's all they'll see." aria-label="Note for the contributor"></textarea>
              <div class="form-foot"><span class="mono small muted" id="note-count"></span><button class="btn btn-danger" id="reject" disabled>${icon("x")} reject item</button></div>
            </div>
            <div id="decision-out"></div>
          </div>`}</div>
        <div class="item-nav"><button class="btn btn-sm" id="prev-item" ${index === 0 ? raw("disabled") : ""}>${icon("prev")} previous</button><button class="btn btn-sm" id="next-item" ${index >= a.total - 1 ? raw("disabled") : ""}>next ${icon("next")}</button></div>
      </article>
    </div>`}`);
  if (!item) return;
  const go = (i) => { renderAudit(a, i, back, live); window.scrollTo(0, 0); };
  $$("[data-item]").forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.item))));
  $("#prev-item").addEventListener("click", () => go(index - 1));
  $("#next-item").addEventListener("click", () => go(index + 1));
  if (item.decided) return;

  const reason = $("#flag-reason");
  const note = $("#flag-note");
  const reject = $("#reject");
  const approve = $("#approve");
  let busy = false;
  const update = () => {
    const n = note.value.trim().length;
    $("#note-count").textContent = n >= MIN_NOTE ? `${n} characters` : `${n} of at least ${MIN_NOTE} characters`;
    reject.disabled = busy || !reason.value || n < MIN_NOTE;
    approve.disabled = busy;
  };
  reason.addEventListener("change", update);
  note.addEventListener("input", update);
  update();
  const decide = async (body) => {
    if (busy) return;
    busy = true;
    update();
    try {
      await api(`/api/audits/${encodeURIComponent(a.id)}/decisions`, { method: "POST", body: { itemId: item.id, ...body } });
      const label = (FLAG_REASONS.find(([value]) => value === body.flagReason) || ["", ""])[1];
      Object.assign(item, { decided: true, verdict: body.verdict, flagReason: label, note: body.note || "" });
      a.decided += 1;
      toast(body.verdict === "ok" ? "Approved." : "Rejected. The contributor gets your note.");
      if (a.decided === a.total) loadMe(); // the audit completes, so a slot frees up
      const next = a.items.findIndex((it, i) => i > index && !it.decided);
      const any = a.items.findIndex((it) => !it.decided);
      go(next !== -1 ? next : any !== -1 ? any : index);
    } catch (e) {
      busy = false;
      update();
      mount($("#decision-out"), notice("bad", html`<b>Not saved.</b> ${e.message}`));
    }
  };
  approve.addEventListener("click", () => decide({ verdict: "ok" }));
  reject.addEventListener("click", () => decide({ verdict: "flagged", flagReason: reason.value, note: note.value.trim() }));
}

// --- Your pool (sponsors) -----------------------------------------------------------------------------
// Only the person who requested a pool can see its items (DataBounty's rule). The pool page asks, and
// shows this panel only when DataBounty says yes; everyone else sees nothing extra.

const SPONSOR_FILTERS = [["all", "all"], ["progress", "in progress"], ["accepted", "accepted"], ["action", "sent back"], ["closed", "rejected"]];

async function renderSponsorPanel(c, live) {
  let data;
  try { data = await api(`/api/pools/${encodeURIComponent(c.id)}/sponsor`); } catch { return; }
  if (!live()) return;
  drawSponsorPanel(c, data, "all", live);
}

function drawSponsorPanel(c, data, filter, live) {
  const box = $("#sponsor-panel");
  if (!box || !live()) return;
  const count = (group) => data.items.filter((item) => item.statusGroup === group).length;
  const shown = filter === "all" ? data.items : data.items.filter((item) => item.statusGroup === filter);
  const icons = { pass: "check", fail: "x", wait: "clock", note: "alert" };
  mount(box, html`<section class="card sponsor-card">
    <div class="row between wrap">
      <div><div class="micro">your pool</div><h3 style="margin:4px 0 2px;font-size:16px">You requested this pool</h3>
        <p class="hint" style="margin:0">${fmt(data.total)} item${data.total === 1 ? "" : "s"} so far. You can dispute an accepted item while its window is open; an admin decides.</p></div>
      <span class="pill pill-karma">sponsor view</span>
    </div>
    <div class="tabs-pills" style="margin:14px 0 10px">${SPONSOR_FILTERS.map(([key, label]) => html`<button class="${filter === key ? "on" : ""}" data-sponsor-filter="${key}">${label}${key === "all" ? "" : ` · ${count(key)}`}</button>`)}</div>
    ${shown.length ? html`<div class="stack">${shown.map((item) => html`<details class="disclose" style="margin-top:0" data-item="${item.id}">
      <summary><span class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.title}</span><span class="pill pill-${item.statusTone}">${item.statusLabel}</span><span class="mono small muted">${item.handle ? `@${item.handle}` : item.contributor}${item.date ? ` · ${item.date}` : ""}</span></summary>
      <div class="body stack" style="padding-top:12px">
        ${item.method ? html`<div><span class="pill">${item.method}</span></div>` : ""}
        ${item.fields.map((f) => html`<div><div class="micro">${f.label}</div><pre class="block">${f.value}</pre></div>`)}
        <div><div class="micro">checks</div>${item.checks.length
          ? html`<ul class="checks" style="margin-top:6px">${item.checks.map((ch) => html`<li class="check check-${ch.state}"><span class="check-icon">${icon(icons[ch.state])}</span><div><b>${ch.label}</b>${ch.reason ? html`<span>${ch.reason}</span>` : ""}</div></li>`)}</ul>`
          : html`<p class="hint" style="margin:6px 0 0">No checks recorded yet.</p>`}</div>
        ${item.flags.map((flag) => notice("warn", html`<b>${flag.reason}.</b> ${flag.note}`))}
        ${item.canDispute ? html`<div class="decide">
          <div class="micro">dispute this item</div>
          <p class="hint" style="margin:0">Open until ${new Date(item.disputeUntil).toLocaleString()}. Use it when the item shouldn't have been accepted.</p>
          <select class="select" data-dispute-reason aria-label="Why"><option value="">Why shouldn't it have been accepted?</option>${FLAG_REASONS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
          <textarea class="textarea" data-dispute-argument placeholder="What's wrong with it, for the admin who decides." aria-label="What's wrong"></textarea>
          <div class="form-foot"><span class="mono small muted" data-dispute-count></span><button class="btn btn-danger" data-dispute disabled>${icon("flag")} dispute item</button></div>
          <div data-dispute-out></div>
        </div>` : item.status === "accepted" && item.disputeUntil ? html`<p class="hint" style="margin:0">The dispute window closed on ${new Date(item.disputeUntil).toLocaleDateString()}.</p>` : ""}
      </div>
    </details>`)}</div>` : html`<div class="empty" style="padding:18px">${data.items.length ? "Nothing here." : "No items yet."}</div>`}
    ${data.more ? html`<p class="hint" style="margin:12px 0 0">Showing the newest 50. Your full pool is on <a href="https://console.databounty.io/sponsor/" target="_blank" rel="noopener">databounty.io</a>.</p>` : ""}
  </section>`);
  $$("[data-sponsor-filter]", box).forEach((b) => b.addEventListener("click", () => drawSponsorPanel(c, data, b.dataset.sponsorFilter, live)));
  $$("details[data-item]", box).forEach((details) => {
    const button = $("[data-dispute]", details);
    if (!button) return;
    const reason = $("[data-dispute-reason]", details);
    const argument = $("[data-dispute-argument]", details);
    let busy = false;
    const update = () => {
      const n = argument.value.trim().length;
      $("[data-dispute-count]", details).textContent = n >= MIN_NOTE ? `${n} characters` : `${n} of at least ${MIN_NOTE} characters`;
      button.disabled = busy || !reason.value || n < MIN_NOTE;
    };
    reason.addEventListener("change", update);
    argument.addEventListener("input", update);
    update();
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      update();
      try {
        await api(`/api/sponsor/submissions/${encodeURIComponent(details.dataset.item)}/dispute`, { method: "POST", body: { reason: reason.value, argument: argument.value.trim() } });
        toast("Disputed. An admin decides it.");
        renderSponsorPanel(c, live);
      } catch (e) {
        busy = false;
        update();
        mount($("[data-dispute-out]", details), notice("bad", html`<b>Not sent.</b> ${e.message}`));
      }
    });
  });
}

// --- Sponsoring ----------------------------------------------------------------------------------------
// Requesting a dataset happens on databounty.io: DataBounty's API doesn't offer it to other apps.

async function pageSponsor() {
  const live = ticket();
  const data = await overview();
  if (!live()) return;
  const app = safeUrl(data.appUrl || "https://console.databounty.io");
  mount($("#page"), html`
    <header class="page-head"><h1 class="title">Sponsor a dataset</h1><p class="sub">Ask the community for the dataset you need. Contributors build it, validators check it, and it's published openly.</p></header>
    <div class="card signin-card">
      <img src="/static/logo.svg" alt="">
      <div><h2>Request a dataset</h2><p>Describe what each item needs, how many you want and how hard they should be. Requests are made on databounty.io.</p></div>
      <div class="signin-actions"><a class="btn btn-primary" href="${app}/sponsor/create/" target="_blank" rel="noopener">request a dataset ${icon("external")}</a><span class="note">Opens databounty.io in a new tab.</span></div>
    </div>
    <h2 class="section">How it works</h2>
    <div class="card pad"><ol class="how">
      <li><span><b>You describe the dataset:</b> its fields, how many items, the difficulty and the licence, with a few sample items.</span></li>
      <li><span><b>DataBounty's team reviews the request</b> and opens a pool for it.</span></li>
      <li><span><b>Contributors submit items.</b> Each one is checked automatically, then reviewed by validators.</span></li>
      <li><span><b>You can review items in your pool</b>, and dispute an accepted one while its dispute window is open.</span></li>
      <li><span><b>The finished dataset is published</b> on the Hugging Face Hub, crediting every contributor.</span></li>
    </ol></div>
    <h2 class="section">Already a sponsor?</h2>
    <p class="section-sub">Open your pool's page here to see the items people submitted, with their checks, and dispute an accepted one.</p>
    <div class="rows">
      <a class="card pool-row" href="${app}/sponsor/" target="_blank" rel="noopener"><div class="head"><span class="pool-title">Your requests and pools</span></div><div class="mono small muted">Track requests, review items in your pools and close a pool, on databounty.io.</div><span class="row-arrow">${icon("external")}</span></a>
    </div>`);
}

// --- Datasets, leaderboard, profiles ------------------------------------------------------------------

const codeBox = (text) => html`<div class="code-box"><pre class="block">${text}</pre><button class="btn btn-sm" data-action="copy" data-copy="${text}">${icon("copy")} copy</button></div>`;

async function pageDatasets() {
  const live = ticket();
  mount($("#page"), html`<header class="page-head"><h1 class="title">Published datasets</h1><p class="sub">Finished datasets on the Hugging Face Hub, crediting every contributor.</p></header><div id="ds"><div class="skeleton"></div></div>`);
  let data;
  try { data = await api("/api/datasets"); } catch (e) {
    if (live()) mount($("#ds"), notice("warn", e.message));
    return;
  }
  if (!live()) return;
  const sets = data.datasets || [];
  const example = (sets.find((d) => d.hugging_face_id) || {}).hugging_face_id;
  mount($("#ds"), html`
    <div class="rows">${sets.length ? sets.map((d) => html`<div class="card pool-row" style="padding-right:20px">
      <div class="head"><span class="pool-title">${d.hugging_face_url ? html`<a class="plain" href="${safeUrl(d.hugging_face_url)}" target="_blank" rel="noopener">${d.title}</a>` : d.title}</span>${d.license ? html`<span class="pill">${d.license}</span>` : ""}</div>
      <div class="mono small muted">${fmt(d.items)} items${d.published_on ? ` · published ${d.published_on}` : ""}${typeof d.downloads === "number" ? ` · ${fmt(d.downloads)} downloads` : ""}${typeof d.likes === "number" ? ` · ${fmt(d.likes)} likes` : ""}</div>
      ${d.github_url ? html`<div class="mono small"><a class="plain muted" href="${safeUrl(d.github_url)}" target="_blank" rel="noopener">also on GitHub ${icon("external")}</a></div>` : ""}
    </div>`) : html`<div class="card empty">No datasets published yet.</div>`}</div>
    ${example ? html`<h2 class="section">Load one</h2><p class="section-sub">Every dataset ships data/items.jsonl and a manifest.json with contributor credit.</p>${codeBox(`from datasets import load_dataset\n\nds = load_dataset("${example}")`)}` : ""}`);
}

async function pageLeaderboard() {
  const live = ticket();
  const { tiers } = await overview();
  if (!live()) return;
  mount($("#page"), html`<header class="page-head"><h1 class="title">Leaderboard</h1><p class="sub">All-time karma. Standing is public and permanent.</p></header>
    <div class="filters">
      <label class="search">${icon("search")}<input class="input" id="lb-q" placeholder="Search by handle or name…" aria-label="Search contributors"></label>
      <select class="select" id="lb-tier" aria-label="Tier"><option value="">All tiers</option>${(tiers || []).map((t) => html`<option value="${t.label}">${t.label}</option>`)}</select>
      <span class="count" id="lb-count"></span>
    </div>
    <div id="lb"><div class="skeleton"></div></div>`);
  let timer;
  let latest = 0;
  const load = async () => {
    const mine = ++latest;
    const q = $("#lb-q").value.trim();
    const tier = $("#lb-tier").value;
    let data;
    try { data = await api(`/api/leaderboard?tier=${encodeURIComponent(tier)}&q=${encodeURIComponent(q)}`); } catch (e) {
      if (live() && mine === latest) mount($("#lb"), notice("warn", e.message));
      return;
    }
    if (!live() || mine !== latest) return;
    const rows = data.rows || [];
    $("#lb-count").textContent = `${rows.length} shown`;
    mount($("#lb"), rows.length ? html`<div class="table-wrap" style="max-height:none"><table class="list">
      <thead><tr><th style="width:64px">rank</th><th>contributor</th><th class="hide-sm">tier</th><th style="text-align:right">karma</th><th class="hide-sm" style="text-align:right">accepted items</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="click" data-handle="${r.handle}">
        <td class="mono">${r.rank || "—"}</td>
        <td><div class="row"><div class="avatar" style="width:28px;height:28px;font-size:12px;background:var(--ink);color:var(--lime);border:0">${initial(r.display_name || r.handle)}</div><div><div class="strong">${r.display_name}</div><div class="mono small muted">@${r.handle}</div></div></div></td>
        <td class="hide-sm">${r.tier ? html`<span class="pill">${r.tier}</span>` : ""}</td>
        <td class="mono strong" style="text-align:right">${fmt(r.karma)}</td>
        <td class="mono hide-sm" style="text-align:right">${fmt(r.accepted_items)}</td>
      </tr>`)}</tbody></table></div>` : html`<div class="card empty">No one matches that search.</div>`);
    $$("[data-handle]").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/u/${encodeURIComponent(tr.dataset.handle)}`; }));
  };
  $("#lb-q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  $("#lb-tier").addEventListener("change", load);
  load();
}

async function pageProfile(handle) {
  const live = ticket();
  const page = $("#page");
  const back = html`<a class="back" href="#/leaderboard">${icon("back")} leaderboard</a>`;
  mount(page, html`${back}<div class="skeleton" style="height:160px"></div>`);
  let p;
  try { p = await api(`/api/profiles/${encodeURIComponent(handle)}`); } catch (e) {
    if (live()) mount(page, html`${back}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  const contributed = [...(p.datasets_contributed_to || [])].sort((a, b) => (b.items || 0) - (a.items || 0)).slice(0, 8);
  mount(page, html`${back}
    <div class="card pad"><div class="profile-head"><div class="avatar">${initial(p.display_name || p.handle)}</div><div><h1 class="title" style="margin:0">${p.display_name}</h1><div class="mono small muted">@${p.handle}${p.member_since ? ` · member since ${p.member_since}` : ""}</div></div>${p.tier ? html`<span class="pill pill-karma" style="margin-left:auto">${p.tier}</span>` : ""}</div></div>
    <div class="tiles" style="margin-top:12px">
      <div class="card tile"><div class="micro">karma</div><b class="karma-text">${fmt(p.karma)}</b></div>
      <div class="card tile"><div class="micro">accepted items</div><b>${fmt(p.accepted_items)}</b></div>
      <div class="card tile"><div class="micro">audits</div><b>${fmt(p.audits || 0)}</b></div>
    </div>
    ${(p.badges || []).length ? html`<h2 class="section">Badges</h2><div class="chips">${p.badges.map((b) => html`<span class="pill pill-lime">${b}</span>`)}</div>` : ""}
    ${(p.published_credits || []).length ? html`<h2 class="section">Credited on published datasets</h2><div class="card"><table class="list"><tbody>${p.published_credits.map((c) => html`<tr><td>${c.hugging_face_url ? html`<a class="plain" href="${safeUrl(c.hugging_face_url)}" target="_blank" rel="noopener">${c.title} ${icon("external")}</a>` : c.title}</td></tr>`)}</tbody></table></div>` : ""}
    ${contributed.length ? html`<h2 class="section">Most accepted items in</h2><div class="card"><table class="list"><tbody>${contributed.map((d) => html`<tr><td>${d.title}</td><td class="mono" style="text-align:right">${fmt(d.items)}</td></tr>`)}</tbody></table></div>` : ""}
    <p style="margin-top:18px"><a class="btn btn-sm" href="${safeUrl(p.profile_url)}" target="_blank" rel="noopener">full profile on databounty.io ${icon("external")}</a></p>`);
}

// --- API & MCP, About ------------------------------------------------------------------------------------

async function pageAgents() {
  const live = ticket();
  const space = `${location.origin}/gradio_api/mcp/`;
  mount($("#page"), html`<header class="page-head"><h1 class="title">API &amp; MCP</h1><p class="sub">Connect your AI agent to DataBounty. Sign-in is OAuth, so you never paste a key.</p></header>
    <div class="card pad stack" id="mcp-setup"><div class="skeleton" style="height:60px"></div></div>
    <h2 class="section">This Space is an MCP server too</h2>
    <p class="section-sub">Browsing needs nothing. To submit items, create an API key at <a href="https://console.databounty.io/developers/" target="_blank" rel="noopener">databounty.io/developers</a> with the <b>contribute</b> scope (add <b>sponsor</b> for your own pools) and set it as the <span class="mono">X-DataBounty-Key</span> header. The key never goes in a message, so the AI never sees it.</p>
    <div class="card pad stack">
      <div><div class="micro">endpoint</div>${codeBox(space)}</div>
      <div><div class="micro">claude code</div>${codeBox(`claude mcp add --transport http databounty-space ${space} --header "X-DataBounty-Key: db_live_sk_..."`)}</div>
      <div><div class="micro">cursor · ~/.cursor/mcp.json</div>${codeBox(JSON.stringify({ mcpServers: { "databounty-space": { url: space, headers: { "X-DataBounty-Key": "db_live_sk_..." } } } }, null, 2))}</div>
      <p class="hint" style="margin:0">Browse: stats, open pools, pool details, datasets, leaderboard, profiles. With a key: get_my_account, get_pool_contract, submit_items, list_my_submissions, check_submission. For a pool you requested: get_pool_items_as_sponsor, dispute_accepted_item.</p>
    </div>
    <h2 class="section">DataBounty's tools</h2>
    <p class="section-sub">The scope is the permission a tool needs. Public tools work without signing in.</p>
    <div id="tools"><div class="skeleton"></div></div>`);
  let data;
  try { data = await api("/api/tools"); } catch (e) {
    if (live()) { mount($("#tools"), notice("warn", e.message)); mount($("#mcp-setup"), notice("warn", e.message)); }
    return;
  }
  if (!live()) return;
  const url = data.mcpUrl;
  mount($("#mcp-setup"), html`
    <div><div class="micro">endpoint · streamable HTTP</div>${codeBox(url)}</div>
    <div><div class="micro">claude code</div>${codeBox(`claude mcp add --transport http databounty ${url}`)}</div>
    <div class="two">
      <div><div class="micro">cursor · ~/.cursor/mcp.json</div>${codeBox(JSON.stringify({ mcpServers: { databounty: { url } } }, null, 2))}</div>
      <div><div class="micro">vs code · .vscode/mcp.json</div>${codeBox(JSON.stringify({ servers: { databounty: { type: "http", url } } }, null, 2))}</div>
    </div>`);
  const order = { public: 0, read: 1, account: 2, contribute: 3, validate: 4, artifact: 5, sponsor: 6 };
  const tools = [...(data.tools || [])].sort((a, b) => (order[a.scope] ?? 9) - (order[b.scope] ?? 9) || a.name.localeCompare(b.name));
  mount($("#tools"), html`<div class="table-wrap" style="max-height:560px"><table class="list"><thead><tr><th>tool</th><th>scope</th><th>what it does</th></tr></thead>
    <tbody>${tools.map((t) => html`<tr><td class="mono small strong">${t.name}</td><td><span class="pill ${t.scope === "public" ? "pill-lime" : ""}">${t.scope}</span></td><td class="small muted">${firstSentence(t.description)}</td></tr>`)}</tbody></table></div>`);
}

async function pageAbout() {
  const live = ticket();
  mount($("#page"), html`<header class="page-head"><h1 class="title">About DataBounty</h1><p class="sub">Open datasets built by the community, checked by people and credited with karma.</p></header><div id="about"><div class="skeleton"></div></div>`);
  const data = await overview();
  if (!live()) return;
  const s = data.stats || {};
  const pct = s.targetItems ? Math.min(100, (100 * (s.clearedItems || 0)) / s.targetItems) : 0;
  mount($("#about"), html`
    ${statTiles(s)}
    <div class="card pad" style="margin-top:12px"><div class="row between"><span class="micro">progress across every programme</span><span class="mono small muted">${fmt(s.clearedItems)} of ${fmt(s.targetItems)} items cleared the automated checks</span></div><div class="progress" style="margin-top:10px;height:6px"><span style="width:${pct.toFixed(1)}%;background:var(--lime-ink)"></span></div></div>
    <h2 class="section">Karma tiers</h2>
    <p class="section-sub">Your standing is public and permanent.</p>
    <div class="tiers">${(data.tiers || []).map((t) => html`<span class="pill"><span class="dot" style="color:${/^#[0-9a-f]{3,8}$/i.test(t.color || "") ? t.color : "#a3f60a"}"></span>${t.label} · from ${fmt(t.minKarma)} karma</span>`)}</div>
    <h2 class="section">How it works</h2>
    <div class="card pad"><ol class="how">
      <li><span><b>A sponsor asks for a dataset</b>, and DataBounty opens a pool for it: what each item needs, how many are wanted, and the karma each accepted item earns.</span></li>
      <li><span><b>You add items</b>, here, on databounty.io, or through an AI agent over MCP.</span></li>
      <li><span><b>Every item is checked automatically</b> for duplicates and disclosed AI help, and its tests run in a sandbox where the dataset has them.</span></li>
      <li><span><b>People review it</b>, and you earn karma for each item they accept.</span></li>
      <li><span><b>Finished datasets are published</b> on the Hugging Face Hub under <a href="https://huggingface.co/${data.hfOrg || "databounty-io"}" target="_blank" rel="noopener">${data.hfOrg || "databounty-io"}</a>, crediting every contributor.</span></li>
    </ol></div>
    <p class="mono small muted" style="margin-top:18px">Browsing needs no account. Signing in keeps your DataBounty sign-in in this Space's memory; this browser holds only a random key to it, and signing out ends both. Source: <a href="https://github.com/Databounty-io/databounty" target="_blank" rel="noopener">github.com/Databounty-io/databounty</a> (Apache-2.0).</p>`);
}

// --- Start ------------------------------------------------------------------------------------------

window.addEventListener("hashchange", route);
(async function boot() {
  // Coming back from a same-tab sign-in: claim the session it left for this page.
  if (read(sessionStorage, NONCE_KEY) && (await claimSignIn())) { await afterSignIn(); return; }
  await loadMe();
  route();
})();
