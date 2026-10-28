// SPDX-License-Identifier: Apache-2.0
// The signed-in Space, drawn like the DataBounty console after login (apps/web/components/app-shell.tsx and
// the pages under apps/web/app/(app)/). Signed out, app.js keeps its own pages. Data comes from the Space's
// /api/console/* routes, which read DataBounty's MCP tools as the person; what no tool offers links to
// databounty.io. Shares app.js's helpers (html, api, icon, mount, state, ticket, …).

Object.assign(ICONS, {
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  award: '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  triangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
});

const CONSOLE_NAV = [
  ["#/analytics", "chart", "Analytics"],
  ["#/sponsor", "database", "Sponsor"],
  ["#/contributor", "code", "Contributor"],
  ["#/validator", "shield", "Validator"],
  ["#/datasets", "layers", "Datasets"], // the Space's own: published datasets on the Hub
  ["#/karma", "sparkles", "Karma"],
  ["#/profile", "award", "Profile"],
  ["#/developers", "code", "API & MCP"],
  ["#/notifications", "bell", "Notifications"],
  ["#/issues", "triangle", "Support cases"],
];

const CONSOLE_ROUTES = [
  [/^#\/?$/, () => location.replace("#/analytics")],
  [/^#\/analytics$/, () => cPageAnalytics()],
  [/^#\/sponsor$/, () => cPageSponsor()],
  [/^#\/sponsor\/([\w-]+)$/, (id) => cPageProgram(id)],
  [/^#\/(?:contribute|contributor)$/, () => cPageContributor()],
  [/^#\/pool\/([\w-]+)$/, (id) => cPagePool(id)],
  [/^#\/submission\/([\w-]+)$/, (id) => pageSubmission(id)],
  [/^#\/(?:validate|validator)$/, () => cPageValidator()],
  [/^#\/audit\/([\w-]+)$/, (id) => pageAudit(id)],
  [/^#\/karma$/, () => cPageKarma()],
  [/^#\/profile$/, () => cPageProfile()],
  [/^#\/(?:developers|agents)$/, () => cPageDevelopers()],
  [/^#\/notifications$/, () => cPageNotifications()],
  [/^#\/issues$/, () => cPageIssues()],
  [/^#\/issues\/([\w-]+)$/, (id) => cPageIssue(id)],
  [/^#\/datasets$/, () => pageDatasets()],
  [/^#\/leaderboard$/, () => pageLeaderboard()],
  [/^#\/u\/([\w.-]+)$/, (handle) => pageProfile(handle)],
  [/^#\/about$/, () => pageAbout()],
];

const COLLAPSE_KEY = "db-sidebar-collapsed";
const cShell = { karma: null, unread: 0, loaded: 0, site: "https://databounty.io", app: "https://console.databounty.io" };
overview().then((data) => { cShell.site = data.siteUrl || cShell.site; cShell.app = data.appUrl || cShell.app; });

// --- Routing ---------------------------------------------------------------------------------------------

function consoleRoute(hash) {
  document.body.classList.add("console");
  renderConsoleShell();
  for (const [pattern, page] of CONSOLE_ROUTES) {
    const match = hash.match(pattern);
    if (match) {
      window.scrollTo(0, 0);
      page(...match.slice(1).map(decodeURIComponent));
      cOnboarding();
      return true;
    }
  }
  location.replace("#/analytics");
  return true;
}

function cActive() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/pool/") || hash.startsWith("#/submission/") || hash.startsWith("#/contribut")) return "#/contributor";
  if (hash.startsWith("#/audit/") || hash.startsWith("#/validat")) return "#/validator";
  if (hash.startsWith("#/issues")) return "#/issues";
  if (hash.startsWith("#/sponsor")) return "#/sponsor";
  if (hash.startsWith("#/agents")) return "#/developers";
  const hit = CONSOLE_NAV.find(([href]) => hash.startsWith(href));
  return hit ? hit[0] : "";
}

// --- The shell: sidebar, karma card, account menu, phone header and drawer ------------------------------

const tierColor = (k) => (k && /^#[0-9a-f]{6}$/i.test(k.tier.color || "") ? k.tier.color : "#a3f60a");

function cKarmaCard() {
  const k = cShell.karma;
  const me = state.me;
  const color = tierColor(k);
  return html`<a class="c-karma" href="#/karma" aria-label="Karma">
    <span class="c-karma-icon">${icon("sparkles")}</span>
    <span class="c-karma-body">
      <span class="c-karma-top"><span class="micro-dark">karma</span>${k && k.tier.label ? html`<span class="c-tier" style="color:${color};background:${color}22">${k.tier.label}</span>` : ""}</span>
      <span class="c-karma-line"><b>${fmt(k ? k.total : me.karma || 0)} pts</b>${k ? html`<span>${k.next ? `${fmt(k.next.toGo)} to ${k.next.label}` : "highest tier"}</span>` : ""}</span>
      <span class="c-karma-bar"><span style="width:${k ? k.progress : 0}%;background:${color}"></span></span>
    </span>
  </a>`;
}

function cAccount() {
  const me = state.me;
  const name = me.displayName || (me.handle ? `@${me.handle}` : "account");
  return html`<div class="c-account">
    <button class="c-account-btn" data-c="account" aria-haspopup="menu" aria-expanded="false">
      <span class="c-avatar">${initial(name)}</span>
      <span class="c-who"><b>${name}</b><span>${me.email || (me.handle ? "@" + me.handle : "")}</span></span>
      ${icon("chevron")}
    </button>
    <div class="c-pop" role="menu" hidden>
      <a class="c-pop-head" href="#/profile"><b>${name}</b>${me.email ? html`<span>${me.email}</span>` : ""}</a>
      <div class="c-pop-group">
        ${me.handle ? html`<a href="${safeUrl(`${cShell.site}/${me.handle}`)}" target="_blank" rel="noopener">${icon("award")} Public profile ${icon("external")}</a>` : ""}
        <a href="${safeUrl(cShell.site)}" target="_blank" rel="noopener">${icon("globe")} Landing page ${icon("external")}</a>
        <a href="${safeUrl(`${cShell.site}/changelog`)}" target="_blank" rel="noopener">${icon("file")} Changelog ${icon("external")}</a>
      </div>
      <div class="c-pop-group"><button data-c="signout">${icon("logout")} Sign out</button></div>
    </div>
  </div>`;
}

function cNav() {
  const active = cActive();
  return html`<nav class="c-nav">${CONSOLE_NAV.map(([href, ic, label]) => html`<a href="${href}" class="${href === active ? "active" : ""}" title="${label}">${icon(ic)}<span class="c-label">${label}</span>${href === "#/notifications" && cShell.unread ? html`<b class="c-badge">${cShell.unread}</b>` : ""}</a>`)}</nav>`;
}

function renderConsoleShell() {
  if (!state.me) return;
  const drawerOpen = Boolean($(".c-drawer:not([hidden])")); // a redraw (the karma card arriving) keeps the phone menu open
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { /* private window */ }
  const brand = html`<a class="c-logo" href="#/analytics"><img src="/static/logo.svg" alt=""><span>DATA<b>/</b>BOUNTY</span></a>`;
  mount($("#sidebar"), html`
    <div class="c-side${collapsed ? " collapsed" : ""}">
      <div class="c-brand">${brand}</div>
      <button class="c-collapse" data-c="collapse" aria-label="${collapsed ? "Expand sidebar" : "Collapse sidebar"}">${icon("chevron")}</button>
      ${cNav()}
      <div class="c-foot">${cKarmaCard()}${cAccount()}</div>
    </div>
    <header class="c-top">
      <button class="c-icon-btn" data-c="menu" aria-label="Open menu">${icon("menu")}</button>
      ${brand}
      <a class="c-icon-btn c-bell" href="#/notifications" aria-label="Notifications">${icon("bell")}${cShell.unread ? html`<span class="c-dot"></span>` : ""}</a>
    </header>
    <div class="c-drawer" ${drawerOpen ? "" : raw("hidden")}>
      <div class="c-scrim" data-c="close"></div>
      <div class="c-drawer-panel" role="dialog" aria-modal="true" aria-label="Navigation menu">
        <div class="c-brand">${brand}<button class="c-icon-btn" data-c="close" aria-label="Close menu">${icon("x")}</button></div>
        ${cNav()}
        <div class="c-foot">${cKarmaCard()}${cAccount()}</div>
      </div>
    </div>`);
  document.body.classList.toggle("c-collapsed", collapsed);
  if (Date.now() - cShell.loaded > 15000) cRefreshShell();
}

async function cRefreshShell() {
  cShell.loaded = Date.now();
  try {
    const data = await api("/api/console/shell");
    cShell.karma = data;
    cShell.unread = data.unread || 0;
  } catch { return; }
  if (state.me) renderConsoleShell();
}

document.addEventListener("click", (event) => {
  const control = event.target.closest("[data-c]");
  const pop = event.target.closest(".c-account");
  if (!pop) $$(".c-pop").forEach((p) => { p.hidden = true; });
  if (!control) {
    if (event.target.closest(".c-drawer a")) $$(".c-drawer").forEach((d) => { d.hidden = true; });
    return;
  }
  const action = control.dataset.c;
  if (action === "collapse") {
    const collapsed = !document.body.classList.contains("c-collapsed");
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* fine */ }
    renderConsoleShell();
  } else if (action === "menu") {
    $$(".c-drawer").forEach((d) => { d.hidden = false; });
  } else if (action === "close") {
    $$(".c-drawer").forEach((d) => { d.hidden = true; });
  } else if (action === "account") {
    const menu = control.parentElement.querySelector(".c-pop");
    menu.hidden = !menu.hidden;
    control.setAttribute("aria-expanded", String(!menu.hidden));
  } else if (action === "signout") {
    event.preventDefault();
    document.body.classList.remove("console", "c-collapsed");
    signOut();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $$(".c-drawer").forEach((d) => { d.hidden = true; });
    $$(".c-pop").forEach((p) => { p.hidden = true; });
  }
});

// --- Setup: the console's verify-email banner and onboarding modal -------------------------------------

function cBanner() {
  const me = state.me;
  if (!me) return "";
  if (me.step === "verify_email") {
    return html`<div class="c-banner">${icon("alert")}<span>Please verify your email address to secure your account. <button class="link" data-c-resend>resend verification email</button></span></div>`;
  }
  if (me.step === "permission") {
    return html`<div class="c-banner">${icon("alert")}<span>The Space wasn't allowed to submit for you. Sign out, sign in again, and keep <b>contribute</b> ticked.</span></div>`;
  }
  return "";
}

document.addEventListener("click", async (event) => {
  const resend = event.target.closest("[data-c-resend]");
  if (!resend) return;
  resend.disabled = true;
  resend.textContent = "sending…";
  try {
    await api("/api/me/resend-verification", { method: "POST" });
    resend.closest(".c-banner").querySelector("span").textContent = "Verification email sent — check your inbox. The link expires in 24 hours.";
  } catch (e) { toast(e.message); resend.disabled = false; resend.textContent = "resend verification email"; }
});

const ONBOARD_STEPS = ["Make your mark", "Built for meaningful work", "Bring your AI"];

function cOnboarding() {
  const me = state.me;
  const box = $("#c-modal");
  if (!me || !["choose_handle", "finish_setup"].includes(me.step)) { if (box) box.remove(); return; }
  if (box) return;
  let step = me.step === "choose_handle" ? 0 : 1;
  let handle = me.handle || me.suggestedHandle || "";
  const modal = document.createElement("div");
  modal.id = "c-modal";
  modal.className = "c-modal";
  document.body.appendChild(modal);
  const draw = (message = "") => {
    const body = [
      html`<h2>Make your work recognizable.</h2><p class="muted">Choose the name people will remember. Build a track record you can share wherever your work matters.</p>
        <div class="row" style="margin-top:14px"><input class="input" id="c-handle" value="${handle}" maxlength="20" placeholder="username" aria-label="username"></div>
        <p class="mono small muted" style="margin:8px 0 0">databounty.io/<b id="c-handle-preview">${handle || "username"}</b></p>
        <p class="small muted">Your page goes live here when you claim it, so your work builds a track record you can share. Switch it off, or hide any section, from Profile at any time.</p>`,
      html`<h2>Turn good work into momentum.</h2><p class="muted">Join community pools to earn Karma, build your profile, and help publish open datasets.</p>
        <div class="two" style="margin-top:14px"><div class="card pad"><div class="micro">reputation</div><b>Karma &amp; profile</b></div><div class="card pad"><div class="micro">access</div><b>Priority &amp; perks</b></div></div>
        <p class="small muted">Build your name with every accepted item.</p>`,
      html`<h2>Put your AI on the job.</h2><p class="muted">Turn the AI you already use into a DataBounty copilot—discover eligible work, understand the task, and take actions you approve.</p>
        <p class="small muted">You can set up API &amp; MCP now or later; it's in the sidebar.</p>`,
    ][step];
    mount(modal, html`<div class="c-modal-card card" role="dialog" aria-modal="true" aria-label="${ONBOARD_STEPS[step]}">
      <div class="c-modal-head"><img src="/static/logo.svg" alt=""><b>${ONBOARD_STEPS[step]}</b><span class="mono small muted">step ${step + 1} of 3</span></div>
      ${body}
      ${message ? notice("warn", message) : ""}
      <div class="row between" style="margin-top:16px">
        ${step > (me.step === "choose_handle" ? 0 : 1) ? html`<button class="btn" data-ob="back">← back</button>` : html`<span></span>`}
        <button class="btn btn-primary" data-ob="next">${step === 0 ? "claim →" : step === 1 ? "Connect your AI" : "continue to API & MCP →"}</button>
      </div>
    </div>`);
    const input = $("#c-handle", modal);
    if (input) input.addEventListener("input", () => { handle = input.value.trim().toLowerCase(); $("#c-handle-preview", modal).textContent = handle || "username"; });
    $$("[data-ob]", modal).forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.ob === "back") { step -= 1; draw(); return; }
      if (step === 0) {
        b.disabled = true;
        try {
          const check = await api("/api/me/handle-check", { method: "POST", body: { handle } });
          if (!check.available) { draw(check.reason || `@${handle} isn't available.`); return; }
        } catch (e) { draw(e.message); return; }
        step = 1; draw(); return;
      }
      if (step === 1) { step = 2; draw(); return; }
      b.disabled = true;
      try {
        await api("/api/me/finish-setup", { method: "POST", body: { handle } });
        await loadMe();
        modal.remove();
        location.hash = "#/developers";
        route();
      } catch (e) { draw(e.message); }
    }));
  };
  draw();
}

// --- Shared pieces --------------------------------------------------------------------------------------

const cHead = (title, sub, actions) => html`<header class="c-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ""}</div>${actions ? html`<div class="c-head-actions">${actions}</div>` : ""}</header>`;
const cSection = (title, sub, right) => html`<div class="c-section"><div><h2>${title}</h2>${sub ? html`<p>${sub}</p>` : ""}</div>${right || ""}</div>`;
const cEmpty = (ic, title, text, action) => html`<div class="card c-empty"><span class="c-empty-icon">${icon(ic)}</span><h3>${title}</h3><p>${text}</p>${action || ""}</div>`;
const cNote = (content) => html`<div class="c-note">${icon("info")}<span>${content}</span></div>`;
const cPill = (text, tone) => html`<span class="pill${tone ? ` pill-${tone}` : ""}">${text}</span>`;
const cOut = (href, text) => html`<a href="${safeUrl(href)}" target="_blank" rel="noopener">${text} ${icon("external")}</a>`;

function cRail(rows) {
  return html`<div class="card c-rail">${rows.map((cells) => html`<div class="c-rail-row" style="grid-template-columns:repeat(${cells.length},minmax(0,1fr))">${cells.map((c) => html`
    <div class="c-cell${c.tone ? ` c-t-${c.tone}` : ""}"><div class="micro">${c.icon ? icon(c.icon) : ""}${c.label}</div><div class="c-cell-value"><b>${c.value}</b>${c.unit ? html`<span>${c.unit}</span>` : ""}</div>${c.sub ? html`<div class="c-cell-sub">${c.sub}</div>` : ""}</div>`)}</div>`)}</div>`;
}

function cStatusBar(k, rank, metrics) {
  return html`<div class="card c-status">
    <div class="c-status-main">
      <span class="c-status-icon">${icon("sparkles")}</span>
      <div class="c-status-who">
        <div class="c-status-num"><b>${fmt(k.total)}</b><span>karma</span>${k.tier.label ? html`<span class="c-chip">${k.tier.label}</span>` : ""}</div>
        ${rank && rank.name ? html`<div class="mono small muted">${rank.name}${rank.next ? html` · ${fmt(rank.toGo)} ${rank.unit} to ${rank.next}` : ""}</div>` : ""}
      </div>
      <div class="c-status-next">
        <div class="row between"><span class="mono small muted">${k.next ? `next tier · ${k.next.label}` : "top tier"}</span><span class="mono small strong">${k.next ? `${fmt(k.next.toGo)} to go` : ""}</span></div>
        <div class="c-bar"><span style="width:${k.progress}%"></span></div>
      </div>
      <a class="pill pill-karma plain" href="#/karma">karma hub ›</a>
    </div>
    ${metrics && metrics.length ? html`<div class="c-status-metrics">${metrics.map(([label, value]) => html`<span>${label} <b>${value}</b></span>`)}</div>` : ""}
  </div>`;
}

function cChart({ title, sub, series, weeks, unit }) {
  const totals = Object.fromEntries(series.map((s) => [s.key, weeks.reduce((sum, w) => sum + (w[s.key] || 0), 0)]));
  const max = Math.max(1, ...weeks.map((w) => series.reduce((sum, s) => sum + (w[s.key] || 0), 0)));
  const label = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return html`<div class="card c-chart">
    <h3>${title}</h3><p class="small muted">${sub}</p>
    <div class="c-legend">${series.map((s) => html`<span><i style="background:${s.color}"></i>${s.label} <b>${fmt(totals[s.key])}</b></span>`)}</div>
    <div class="c-bars">${weeks.map((w) => html`<div class="c-col" title="week of ${w.weekStart}: ${series.map((s) => `${s.label} ${w[s.key] || 0}`).join(", ")}">${series.map((s) => (w[s.key] ? html`<span style="height:${((100 * w[s.key]) / max).toFixed(2)}%;background:${s.color}"></span>` : ""))}</div>`)}</div>
    <div class="c-axis">${weeks.map((w, i) => html`<span>${i % 2 === 0 ? label(w.weekStart) : ""}</span>`)}</div>
    <div class="mono small muted c-scale">Scale 0–${fmt(max)} ${unit} per week · zero baseline</div>
    <details class="c-details"><summary>Show these numbers as a table</summary>
      <div class="table-wrap"><table class="list"><thead><tr><th>Week of</th>${series.map((s) => html`<th>${s.label}</th>`)}</tr></thead>
      <tbody>${weeks.map((w) => html`<tr><td class="mono small">${w.weekStart}</td>${series.map((s) => html`<td class="mono">${fmt(w[s.key] || 0)}</td>`)}</tr>`)}</tbody></table></div>
    </details>
  </div>`;
}

const cSkeleton = (n = 2, height = 64) => html`${Array.from({ length: n }, () => html`<div class="skeleton" style="height:${height}px"></div>`)}`;

// --- Analytics -------------------------------------------------------------------------------------------

async function cPageAnalytics() {
  const live = ticket();
  let weeks = 12;
  const range = html`<select class="select c-range-select" aria-label="Time window">${[[4, "Last 4 weeks"], [12, "Last 12 weeks"], [26, "Last 26 weeks"], [52, "Last 52 weeks"]].map(([n, text]) => html`<option value="${n}" ${n === 12 ? raw("selected") : ""}>${text}</option>`)}</select>`;
  mount($("#page"), html`${cHead("Analytics", "Your own weekly activity — what you submitted and how it was decided, and the audit calls you made. Contributor and validator views are separate because they answer different questions.")}
    ${cBanner()}
    ${cSection("Your contributor activity", "Weekly submission outcomes and karma, from your own rows.", range)}
    <div class="mono small muted c-range"></div>
    <div id="c-contrib" class="stack">${cSkeleton(2, 220)}</div>
    ${cSection("Your validator activity", "Weekly audit decisions and what became of the items you flagged.")}
    <div id="c-validator"></div>`);
  const draw = async () => {
    mount($("#c-contrib"), cSkeleton(2, 220));
    let a;
    try { a = await api(`/api/console/analytics?weeks=${weeks}`); } catch (e) {
      if (live()) mount($("#c-contrib"), cEmpty("chart", "Could not load your activity", e.message));
      return;
    }
    if (!live()) return;
    $(".c-range").textContent = `${a.range.weeks} ISO weeks · ${a.range.from} – ${a.range.to} · weeks start Monday, UTC`;
    const quiet = !Object.values(a.submissions.totals).some(Boolean) && !a.karma.totals.karma;
    mount($("#c-contrib"), quiet
      ? cEmpty("chart", `No activity in ${a.range.from} – ${a.range.to}`, "Nothing submitted and no karma earned in this window. This is a real zero, not a gap in the data — widen the window if you were active earlier.")
      : html`${cChart({ title: "Submissions by the week you sent them", sub: "Each column is one week's submissions, split by where those items stand today.", series: a.submissions.series, weeks: a.submissions.weeks, unit: "items" })}
        ${cChart({ title: "Karma earned", sub: "Karma events, in the week each one was recorded.", series: a.karma.series, weeks: a.karma.weeks, unit: "karma" })}
        ${cNote("Grouped by the week you submitted, and split by where those items stand today — not by when each decision was made. Submissions record an accepted-at time but no rejected-at or needs-fixes-at time, so there is no decision timestamp to group by.")}`);
  };
  $(".c-range-select").addEventListener("change", (e) => { weeks = Number(e.target.value); draw(); });
  const r = state.me.reviewer || {};
  mount($("#c-validator"), html`${cRail([[
    { label: "audits completed", value: fmt(r.auditsCompleted || 0) },
    { label: "claimed slots", value: `${r.active || 0} / ${r.maxConcurrent || 1}` },
    { label: "false flag rate", value: r.falseFlagRate != null ? `${r.falseFlagRate}%` : "—" },
    { label: "missed deadlines", value: fmt(r.missedDeadlines || 0) },
  ]])}
    <div style="margin-top:10px">${cNote(html`Week-by-week audit charts come from DataBounty's own analytics, which other apps can't read yet. ${cOut(`${cShell.app}/analytics/`, "See them on databounty.io")}`)}</div>`);
  draw();
}

// --- Sponsor -----------------------------------------------------------------------------------------------

function cProgramRow(p) {
  const target = p.target_items || 0;
  const accepted = p.accepted_items || 0;
  const pct = target ? Math.min(100, Math.round((100 * accepted) / target)) : 0;
  return html`<a class="card pool-row" href="#/sponsor/${encodeURIComponent(p.id)}">
    <div class="head"><span class="pool-title">${p.title}</span>${cPill("approved · live", "ok")}</div>
    <div class="cap"><span class="mono small muted">${fmt(accepted)} / ${fmt(target)} accepted</span><div class="progress"><span style="width:${pct}%"></span></div><span class="mono small strong">${pct}%</span></div>
    <div class="mono small"><span class="muted">${fmt(p.items || 0)} items submitted · ${p.dataset_type}${p.language ? ` · ${p.language}` : ""}</span>${p.karma_per_accepted_item ? html` · <span class="karma-text">+${fmt(p.karma_per_accepted_item)} karma / item</span>` : ""}</div>
    <span class="row-arrow">${icon("arrow")}</span>
  </a>`;
}

async function cPageSponsor() {
  const live = ticket();
  const app = cShell.app;
  mount($("#page"), html`${cHead("Community Dataset Requests", "Request and sponsor open, public dataset programs — for open-source AI researchers and community builders.",
    html`<a class="btn btn-primary" href="${safeUrl(`${app}/sponsor/create/`)}" target="_blank" rel="noopener">${icon("plus")} Request a dataset ${icon("external")}</a>`)}
    ${cBanner()}
    ${cNote(html`Requests still in review, their reference samples and the reviewer's notes are on databounty.io. ${cOut(`${app}/sponsor/`, "Open your requests")}`)}
    ${cSection("Your pools", "Pools opened from your requests. Open one to see every item, its checks, and dispute an accepted one.")}
    <div id="c-sponsor"><div class="card pad"><div class="mono small muted">Looking for the pools you requested…</div><div class="skeleton" style="margin-top:10px"></div></div></div>`);
  let data;
  try { data = await api("/api/console/sponsor"); } catch (e) {
    if (live()) mount($("#c-sponsor"), notice("warn", e.message));
    return;
  }
  if (!live()) return;
  if (data.needsScope) {
    mount($("#c-sponsor"), notice("warn", html`To see your pools here, sign out and in again, keeping <b>sponsor</b> ticked.`));
    return;
  }
  const partial = data.partial ? notice("warn", "DataBounty didn't answer for some pools, so one of yours may be missing. Reload to check again.") : "";
  mount($("#c-sponsor"), data.pools.length
    ? html`${partial}<div class="rows">${data.pools.map(cProgramRow)}</div>`
    : html`${partial}${cEmpty("database", "No pools from your requests yet", "Plan and submit a specification for an open dataset. Our community contributors and validators will build and verify it, and its pool shows here once it's approved.",
      html`<a class="btn btn-primary btn-sm" href="${safeUrl(`${app}/sponsor/create/`)}" target="_blank" rel="noopener">Plan a dataset request ${icon("external")}</a>`)}`);
}

async function cPageProgram(id) {
  const live = ticket();
  const back = html`<a class="back" href="#/sponsor">${icon("back")} Back to sponsor requests</a>`;
  mount($("#page"), html`${back}<div class="skeleton" style="height:140px"></div>`);
  let c;
  try {
    [c] = await Promise.all([api(`/api/pools/${encodeURIComponent(id)}/contract`), state.pools ? null : api("/api/pools").then((r) => { state.pools = r.pools || []; })]);
  } catch (e) {
    if (live()) mount($("#page"), html`${back}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  const p = (state.pools || []).find((x) => x.id === id) || {};
  const target = p.target_items || 0;
  const accepted = p.accepted_items || 0;
  const pct = target ? Math.round((100 * accepted) / target) : 0;
  let tab = "submissions";
  mount($("#page"), html`${back}
    <div class="micro" style="margin-top:6px">community program · ${c.language || "General"}</div>
    <header class="c-head"><div><h1>${c.title}</h1></div><div class="c-head-actions">${cPill(c.open ? "approved · live" : "closed", c.open ? "ok" : "")}</div></header>
    ${cRail([[
      { label: "accepted items", value: `${fmt(accepted)} / ${fmt(target)}`, sub: `${pct}% complete`, tone: "accepted" },
      { label: "in pipeline", value: fmt(p.in_review_items || 0), tone: "review" },
      { label: "capacity reserved", value: fmt(p.capacity_reserved || 0) },
      { label: "karma / item", value: c.karma ? `+${fmt(c.karma)}` : "—", tone: "karma" },
    ]])}
    <div class="tabs-pills c-tabs" style="margin:16px 0 12px"><button data-tab="submissions" class="on">Submissions</button><button data-tab="overview">Overview</button></div>
    <div id="c-tab"></div>`);
  const draw = () => {
    $$("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    if (tab === "overview") { mount($("#c-tab"), contractCard(c)); return; }
    mount($("#c-tab"), html`<div id="sponsor-panel"><div class="skeleton" style="height:120px"></div></div>`);
    renderSponsorPanel(c, live);
  };
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; draw(); }));
  draw();
}

// --- Contributor ----------------------------------------------------------------------------------------

const POOL_TABS = [["all", "all"], ["action", "needs action"], ["outcome", "needs final outcome"], ["accepted", "final accepted"]];

function cPoolCard(p, mine) {
  const target = p.target_items || 0;
  const reserved = p.capacity_reserved || 0;
  const pct = target ? Math.min(100, Math.round((100 * reserved) / target)) : 0;
  const karma = p.karma_per_accepted_item;
  return html`<a class="card pool-row c-pool" href="#/pool/${encodeURIComponent(p.id)}">
    <div class="head"><span class="pool-title">${p.title}</span>${cPill("direct submit", "karma")}</div>
    ${mine ? html`<div class="mono small strong">You submitted ${fmt(mine.total)} item${mine.total === 1 ? "" : "s"}${mine.review ? ` — ${fmt(mine.review)} awaiting validator` : ""}</div>` : ""}
    <div class="cap"><span class="mono small muted">${fmt(reserved)} / ${fmt(target)} capacity reserved</span><div class="progress"><span style="width:${pct}%"></span></div><span class="mono small strong">${pct}%</span></div>
    <div class="mono small">${typeof karma === "number" ? html`<span class="karma-text">+${fmt(karma)} karma / item${p.karma_total ? ` · up to +${fmt(p.karma_total)} total` : ""}</span> · ` : ""}<span class="muted">${p.dataset_type} · ${fmt(p.final_accepted || 0)} final accepted</span></div>
    <span class="row-arrow">${icon("arrow")}</span>
  </a>`;
}

function cGroupRow(g) {
  const parts = [
    g.accepted && html`<span class="c-ok">${fmt(g.accepted)} accepted</span>`,
    g.action && html`<span class="c-warn">${fmt(g.action)} need action</span>`,
    g.checking && html`<span>${fmt(g.checking)} being checked</span>`,
    g.review && html`<span>${fmt(g.review)} waiting for a validator</span>`,
    g.rejected && html`<span>${fmt(g.rejected)} rejected</span>`,
  ].filter(Boolean);
  return html`<a class="card pool-row" href="#/pool/${encodeURIComponent(g.poolId)}">
    <div class="head"><span class="pool-title">${g.pool}</span><span class="mono small muted">community pool</span>${g.karma ? cPill(`+${fmt(g.karma)} karma / item`, "karma") : ""}</div>
    <div class="mono small c-validation">Validation: ${parts.map((x, i) => html`${i ? " · " : ""}${x}`)}<span class="muted" style="margin-left:auto">${fmt(g.total)} submitted</span></div>
    <span class="row-arrow">${icon("arrow")}</span>
  </a>`;
}

async function cPageContributor() {
  const live = ticket();
  state.cPools = state.cPools || { q: "", type: "", level: "", limit: 12, tab: "all", sq: "" };
  const f = state.cPools;
  mount($("#page"), html`${cHead("Contributor workspace", "Open community pools, validation pipeline signals, and verified karma progress.")}
    ${cBanner()}
    <div id="c-top" class="stack">${cSkeleton(2, 90)}</div>
    <div id="c-first"></div>
    ${cSection("Available work", "Direct-submit community pools. Filters apply to every open pool.")}
    <div class="filters c-filters">
      <label class="search">${icon("search")}<input class="input" id="c-q" placeholder="Search bounty or dataset type…" value="${f.q}" aria-label="Search pools"></label>
      <select class="select" id="c-type" aria-label="Dataset type"><option value="">All dataset types</option></select>
      <select class="select" id="c-level" aria-label="Difficulty"><option value="">All difficulty levels</option>${LEVELS.map((l) => html`<option value="${l}" ${f.level === l ? raw("selected") : ""}>${cap(l)}</option>`)}</select>
      <span class="count" id="c-count"></span>
    </div>
    <div class="rows" id="c-pools">${cSkeleton(3, 96)}</div>
    <div id="c-more" style="text-align:center;margin-top:12px"></div>
    ${cSection("My submissions", "Community-pool contributions. Open any row to review its items, validation evidence, issues, and available resubmissions.")}
    <div class="filters c-filters">
      <div class="tabs-pills c-tabs" id="c-subtabs"></div>
      <label class="search">${icon("search")}<input class="input" id="c-sq" placeholder="Search your submissions…" value="${f.sq}" aria-label="Search your submissions"></label>
      <span class="count" id="c-subcount"></span>
    </div>
    <div class="rows" id="c-groups">${cSkeleton(2, 70)}</div>`);

  let groups = null;
  const minePerPool = () => Object.fromEntries((groups ? groups.pools : []).map((g) => [g.poolId, g]));
  const drawPools = () => {
    if (!state.pools) return;
    const needle = f.q.trim().toLowerCase();
    const shown = state.pools.filter((p) => (!needle || `${p.title} ${p.dataset_type}`.toLowerCase().includes(needle)) && (!f.type || p.dataset_type === f.type) && (!f.level || p.difficulty === f.level));
    $("#c-count").textContent = `${Math.min(shown.length, f.limit)} shown${shown.length > f.limit ? " · more available" : ""}`;
    const mine = minePerPool();
    mount($("#c-pools"), shown.length
      ? shown.slice(0, f.limit).map((p) => cPoolCard(p, mine[p.id]))
      : cEmpty("code", "No work available right now", needle || f.type || f.level ? "No open pool matches these filters." : "No community pool is open yet. Community pools appear here as sponsors publish them."));
    mount($("#c-more"), shown.length > f.limit ? html`<button class="btn" id="c-load">Load more community work</button>` : "");
    $("#c-load")?.addEventListener("click", () => { f.limit += 12; drawPools(); });
  };
  const drawGroups = () => {
    if (!groups) return;
    mount($("#c-subtabs"), POOL_TABS.map(([key, label]) => html`<button class="${f.tab === key ? "on" : ""}" data-subtab="${key}">${label}${key === "all" ? "" : ` · ${groups.counts[key] || 0}`}</button>`));
    $$("[data-subtab]").forEach((b) => b.addEventListener("click", () => { f.tab = b.dataset.subtab; drawGroups(); }));
    const needle = f.sq.trim().toLowerCase();
    const rows = groups.pools.filter((g) => g.filters.includes(f.tab) && (!needle || g.pool.toLowerCase().includes(needle)));
    $("#c-subcount").textContent = `${fmt(groups.submitted)} submission${groups.submitted === 1 ? "" : "s"}`;
    mount($("#c-groups"), rows.length ? rows.map(cGroupRow) : html`<div class="card empty">${groups.submitted ? "No pool matches." : "Nothing submitted yet. Pick up an open pool above to get started."}</div>`);
  };

  $("#c-q").addEventListener("input", (e) => { f.q = e.target.value; f.limit = 12; drawPools(); });
  $("#c-type").addEventListener("change", (e) => { f.type = e.target.value; f.limit = 12; drawPools(); });
  $("#c-level").addEventListener("change", (e) => { f.level = e.target.value; f.limit = 12; drawPools(); });
  $("#c-sq").addEventListener("input", (e) => { f.sq = e.target.value; drawGroups(); });

  api("/api/console/contributor").then((d) => {
    if (!live()) return;
    const fn = d.funnel || {};
    mount($("#c-top"), html`${cStatusBar(d.karma, { ...d.rank, unit: "items" })}
      ${cRail([[
        { label: "submitted", value: fmt(fn.total || 0), icon: "upload" },
        { label: "accepted", value: fmt(fn.accepted || 0), icon: "check", tone: "accepted" },
        { label: "needs your fix", value: fmt(fn.needsAttention || 0), icon: "refresh", tone: "action" },
        { label: "in validation", value: fmt(fn.inReview || 0), icon: "clock", tone: "review" },
      ]])}`);
    if (!fn.total) {
      mount($("#c-first"), html`<div class="card pad c-first"><h3>Start here</h3><p class="small muted">How contributing works on DataBounty:</p>
        <div class="c-steps">${[["Explore open pools", "Each pool says what an item needs and what it earns."], ["Submit single or bulk items", "One with the form, or many from a file."], ["Earn community karma", "Every item a validator accepts adds karma."]].map(([t, s], i) => html`<div class="c-step"><b>${i + 1}. ${t}</b><span class="small muted">${s}</span></div>`)}</div></div>`);
    }
  }).catch((e) => { if (live()) mount($("#c-top"), notice("warn", e.message)); });
  api("/api/console/my-pools").then((d) => { if (live()) { groups = d; drawGroups(); drawPools(); } })
    .catch((e) => { if (live()) mount($("#c-groups"), notice("warn", e.message)); });
  if (!state.pools) {
    try { state.pools = (await api("/api/pools")).pools || []; } catch (e) {
      if (live()) mount($("#c-pools"), notice("warn", e.message));
      return;
    }
  }
  if (!live()) return;
  const types = [...new Set(state.pools.map((p) => p.dataset_type).filter(Boolean))].sort();
  mount($("#c-type"), html`<option value="">All dataset types</option>${types.map((t) => html`<option value="${t}" ${f.type === t ? raw("selected") : ""}>${t}</option>`)}`);
  drawPools();
}

async function cPagePool(id) {
  const live = ticket();
  const back = html`<a class="back" href="#/contributor">${icon("back")} contributor workspace</a>`;
  mount($("#page"), html`${back}<div class="skeleton" style="height:140px"></div>`);
  let c;
  try {
    [c] = await Promise.all([api(`/api/pools/${encodeURIComponent(id)}/contract`), state.pools ? null : api("/api/pools").then((r) => { state.pools = r.pools || []; }).catch(() => null)]);
  } catch (e) {
    if (live()) mount($("#page"), html`${back}${notice("warn", e.message)}`);
    return;
  }
  if (!live()) return;
  if (!c.signedIn) { forget(); route(); toast("Your sign-in ended. Sign in again to continue."); return; }
  const p = (state.pools || []).find((x) => x.id === id) || {};
  const target = p.target_items || 0;
  const reserved = p.capacity_reserved || 0;
  const pct = target ? Math.min(100, Math.round((100 * reserved) / target)) : 0;
  const sub = ["Community open pool", c.karma ? `+${fmt(c.karma)} karma / accepted item` : "", p.karma_total ? `up to +${fmt(p.karma_total)} karma` : ""].filter(Boolean).join(" · ");
  mount($("#page"), html`${back}
    ${cHead(c.title, sub)}
    <div class="card pad c-progress">
      <div class="row between wrap">${cPill("no claim needed — submit directly", "karma")}<span class="mono small muted">${c.license ? `licence ${c.license}` : ""}</span></div>
      ${target ? html`<div class="cap" style="margin-top:12px"><span class="mono small muted">${fmt(reserved)} / ${fmt(target)} capacity reserved · ${fmt(p.final_accepted || 0)} final accepted</span><div class="progress"><span style="width:${pct}%"></span></div><span class="mono small strong">${pct}%</span></div>` : ""}
      <div id="c-mine-tiles" style="margin-top:12px"></div>
    </div>
    ${contractCard(c)}
    <div id="sponsor-panel"></div>
    <div id="pool-work"></div>
    ${cSection("Your submissions to this pool", "")}
    <div class="rows" id="c-pool-subs">${cSkeleton(1, 60)}</div>`);
  renderPoolWork(c);
  if (state.me.canSponsor) renderSponsorPanel(c, live);
  try {
    const mine = await api(`/api/submissions?pool=${encodeURIComponent(id)}`);
    if (!live()) return;
    const count = (group) => mine.items.filter((s) => s.statusGroup === group).length;
    mount($("#c-mine-tiles"), mine.items.length ? cRail([[
      { label: "final accepted", value: fmt(count("accepted")), tone: "accepted" },
      { label: "needs your fix", value: fmt(count("action")), tone: "action" },
      { label: "in progress", value: fmt(count("progress")), tone: "review" },
      { label: "rejected", value: fmt(count("closed")) },
    ]]) : "");
    mount($("#c-pool-subs"), mine.items.length ? mine.items.map(subRow) : html`<div class="card empty">You have not submitted any items to this pool yet.</div>`);
  } catch (e) { if (live()) mount($("#c-pool-subs"), notice("warn", e.message)); }
}

// --- Validator ------------------------------------------------------------------------------------------

const AUDIT_TABS = [["all", "All"], ["claimed", "In Progress"], ["overdue_review", "Overdue"], ["completed", "Completed"]];

function cAuditCard(a, full) {
  const total = typeof a.karma === "number" ? a.karma * (a.items || 0) : null;
  return html`<div class="card c-audit">
    <div class="row between"><span class="row wrap" style="gap:6px">${a.category ? cPill(String(a.category).replace(/_/g, " ").toUpperCase()) : ""}${a.language ? cPill(a.language) : ""}</span><span class="mono small muted">${fmt(a.items)} items</span></div>
    <h3>${a.pool}</h3>
    <div class="c-reward"><span class="muted small">Reward</span><span>${total != null ? html`<b class="karma-text">+${fmt(total)} karma</b><small class="mono muted">+${fmt(a.karma)} / item</small>` : ""}</span></div>
    <button class="btn btn-primary c-claim" data-claim="${a.id}" ${full ? raw("disabled") : ""}>Claim audit</button>
  </div>`;
}

async function cPageValidator() {
  const live = ticket();
  const me = state.me;
  if (!me.canReview) {
    mount($("#page"), html`${cHead("Community Validator Workspace", "Audit dataset items against the pool spec. Karma for every completed batch, more for each confirmed issue.")}
      <div class="card setup-card"><h2>Allow reviewing</h2><p>You signed in before the Space could review for you. Sign out, sign in again, and keep <b>validate</b> ticked.</p><button class="btn" data-c="signout">sign out</button></div>`);
    return;
  }
  let tab = "all";
  mount($("#page"), html`${cHead("Community Validator Workspace", "Audit dataset items against the pool spec. Karma for every completed batch, more for each confirmed issue.",
    html`<a class="btn btn-sm" href="#/karma">${icon("sparkles")} Karma hub</a>`)}
    ${cBanner()}
    <div id="c-top" class="stack">${cSkeleton(2, 90)}</div>
    <div id="c-first"></div>
    <div id="c-active"></div>
    ${cSection("Available Community Audits", "Open batches needing human peer review. Review items, verify against the spec, and earn karma.", html`<span class="mono small muted" id="c-avail-count"></span>`)}
    <div id="c-hidden"></div>
    <div class="filters c-filters">
      <label class="search">${icon("search")}<input class="input" id="c-aq" placeholder="Search open audits…" aria-label="Search open audits"></label>
      <select class="select" id="c-acat" aria-label="Category"><option value="">All Categories</option></select>
      <select class="select" id="c-alang" aria-label="Language"><option value="">All Languages</option></select>
      <span class="count" id="c-ashown"></span>
    </div>
    <div class="c-audit-grid" id="c-open">${cSkeleton(2, 160)}</div>
    ${cSection("My Audit History", "Every audit batch you've claimed, in progress or completed. An unfinished claim releases back to the pool 24 hours after you claim it if nothing was decided.")}
    <div class="filters c-filters"><div class="tabs-pills c-tabs" id="c-htabs"></div><label class="search">${icon("search")}<input class="input" id="c-hq" placeholder="Filter your audits by pool title…" aria-label="Filter your audits"></label><span class="count" id="c-hcount"></span></div>
    <div id="c-history">${cSkeleton(1, 70)}</div>`);

  let open = [];
  let hidden = 0;
  let history = [];
  const r = me.reviewer || {};
  const full = (r.active || 0) >= (r.maxConcurrent || 1);
  const drawOpen = () => {
    const q = $("#c-aq").value.trim().toLowerCase();
    const cat = $("#c-acat").value;
    const lang = $("#c-alang").value;
    const rows = open.filter((a) => (!q || a.pool.toLowerCase().includes(q)) && (!cat || a.category === cat) && (!lang || a.language === lang));
    $("#c-ashown").textContent = `Showing ${rows.length} of ${open.length}`;
    mount($("#c-open"), rows.length ? rows.map((a) => cAuditCard(a, full))
      : html`<div style="grid-column:1/-1">${cEmpty("shield", "No open audit batches", "All submitted items are currently audited. Check back soon for newly submitted contributor batches.")}</div>`);
    $$("[data-claim]").forEach((b) => b.addEventListener("click", () => claimAudit(b.dataset.claim, b)));
  };
  const drawHistory = () => {
    mount($("#c-htabs"), AUDIT_TABS.map(([key, label]) => html`<button class="${tab === key ? "on" : ""}" data-htab="${key}">${label}</button>`));
    $$("[data-htab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.htab; drawHistory(); }));
    const q = $("#c-hq").value.trim().toLowerCase();
    const rows = history.filter((a) => (tab === "all" || a.status === tab || (tab === "claimed" && a.status === "in_progress")) && (!q || a.pool.toLowerCase().includes(q)));
    $("#c-hcount").textContent = `${rows.length} audit${rows.length === 1 ? "" : "s"}`;
    mount($("#c-history"), rows.length ? html`<div class="rows">${rows.map((a) => auditRow(a, false))}</div>` : cEmpty("eye", "No audits found", "You haven't claimed any audit batches yet."));
  };
  $("#c-aq").addEventListener("input", drawOpen);
  $("#c-acat").addEventListener("change", drawOpen);
  $("#c-alang").addEventListener("change", drawOpen);
  $("#c-hq").addEventListener("input", drawHistory);

  api("/api/console/validator").then((d) => {
    if (!live()) return;
    const rv = d.reviewer || {};
    const w = d.work || {};
    const decided = d.flags.decided || 0;
    const confirmed = Math.max(0, decided - (d.flags.dismissed || 0));
    mount($("#c-top"), html`${cStatusBar(d.karma, { name: rv.rank, next: rv.nextRank && rv.nextRank.name, toGo: rv.nextRank && rv.nextRank.toGo, unit: "audits" }, [
      ["audits completed", fmt(rv.auditsCompleted || 0)],
      ["claimed slots", `${rv.active || 0} / ${rv.maxConcurrent || 1}`],
      ["confirmed issue rate", decided ? `${Math.round((100 * confirmed) / decided)}%` : "—"],
      ["false flag rate", rv.falseFlagRate != null ? `${rv.falseFlagRate}%` : "—"],
      ["missed deadlines", fmt(rv.missedDeadlines || 0)],
    ])}
    ${cRail([
      [{ label: "total claimed", value: fmt(w.claimedBatches || 0) }, { label: "completed batches", value: fmt(w.completedBatches || 0), tone: "accepted" },
       { label: "open items pending", value: fmt(w.pendingDecisions || 0), tone: "review" }, { label: "decisions recorded", value: fmt(rv.auditsCompleted || 0), tone: "accepted" }],
      [{ label: "flags decided", value: fmt(decided) }, { label: "confirmed", value: fmt(confirmed), tone: "accepted" }, { label: "dismissed", value: fmt(d.flags.dismissed || 0), tone: "review" }],
    ])}`);
    if (!rv.auditsCompleted) {
      mount($("#c-first"), html`<div class="card pad c-first"><div class="row between wrap"><div><h3>Start here</h3><p class="small muted">How community validation works on DataBounty:</p></div>
        <button class="btn btn-sm" type="button" data-c-jump="c-open">Explore open audit batches ${icon("arrow")}</button></div>
        <div class="c-steps">${[["Claim an audit batch", "Claim any open batch below. That reserves it to you against a deadline — nobody else can review it while you hold it. (The one exception: you can never claim a batch containing an item you submitted yourself as a contributor.)"],
          ["Judge each item against the spec", "Every item shows the sponsor's contract, the machine evidence already gathered, and the rubric. Approve it, or flag it with a reason."],
          ["Complete the batch to earn karma", "Finishing every item earns the batch's karma. A flag the platform upholds earns more; one it dismisses costs reputation, so flag what you can evidence."]]
          .map(([t, s], i) => html`<div class="c-step"><b>${i + 1}. ${t}</b><span class="small muted">${s}</span></div>`)}</div></div>`);
      $("[data-c-jump]")?.addEventListener("click", () => $("#c-open").scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }).catch((e) => { if (live()) mount($("#c-top"), notice("warn", e.message)); });

  try {
    const [avail, held, late, done] = await Promise.all([api("/api/audits"), api("/api/audits/mine?status=claimed"), api("/api/audits/mine?status=overdue_review"), api("/api/audits/mine?status=completed")]);
    if (!live()) return;
    open = avail.audits;
    hidden = avail.hidden || 0;
    history = [...late.audits, ...held.audits, ...done.audits];
    const active = [...late.audits, ...held.audits];
    $("#c-avail-count").textContent = `${fmt(avail.total)} batch${avail.total === 1 ? "" : "es"} available`;
    mount($("#c-hidden"), hidden ? html`<div class="c-note c-note-warn">${icon("alert")}<span><b>Why ${hidden === 1 ? "this batch is" : "these batches are"} hidden:</b> ${hidden} contain${hidden === 1 ? "s" : ""} a submission you made. You can still review any batch that does not involve your submitted work.</span></div>` : "");
    mount($("#c-active"), active.length ? html`${cSection(`Active Audits (${active.length})`, "", html`<span class="mono small muted">${active.length} / ${r.maxConcurrent || 1} slots used</span>`)}<div class="rows">${active.map((a) => auditRow(a, false))}</div>` : "");
    const opts = (key) => [...new Set(open.map((a) => a[key]).filter(Boolean))].sort();
    mount($("#c-acat"), html`<option value="">All Categories</option>${opts("category").map((v) => html`<option value="${v}">${String(v).replace(/_/g, " ")}</option>`)}`);
    mount($("#c-alang"), html`<option value="">All Languages</option>${opts("language").map((v) => html`<option value="${v}">${v}</option>`)}`);
    drawOpen();
    drawHistory();
  } catch (e) { if (live()) mount($("#c-open"), notice("warn", e.message)); }
}

// --- Karma -------------------------------------------------------------------------------------------------

async function cPageKarma() {
  const live = ticket();
  mount($("#page"), html`${cHead("Karma", "Karma is your reputation, earned on community work. Tiers unlock priority and platform perks.")}${cBanner()}<div id="c-karma" class="stack">${cSkeleton(3, 120)}</div>`);
  let d;
  try { d = await api("/api/console/karma"); } catch (e) {
    if (live()) mount($("#c-karma"), notice("warn", e.message));
    return;
  }
  if (!live()) return;
  const k = d.karma;
  let events = d.events;
  let next = d.nextCursor;
  let kind = "";
  const kinds = [["", "All verified events"], ["community_item_accepted", "Accepted items"], ["community_audit_completed", "Audits"], ["community_flag_confirmed", "Flags confirmed"], ["community_item_reversed", "Reversals"], ["admin_adjustment", "Adjustments"]];
  mount($("#c-karma"), html`
    <div class="card pad c-karma-hero">
      <div class="row" style="gap:14px"><span class="c-status-icon">${icon("sparkles")}</span>
        <div><div class="c-status-num"><b>${fmt(k.total)}</b><span>karma</span>${k.tier.label ? html`<span class="c-chip">${k.tier.label}</span>` : ""}</div>
          <div class="small muted">${k.tier.blurb}${k.rank ? html` · rank #${fmt(k.rank)} on the open leaderboard` : ""}</div></div></div>
      ${k.next ? html`<div class="row between" style="margin-top:14px"><span class="mono small muted">progress toward ${k.next.label}</span><span class="mono small strong">${fmt(k.next.toGo)} to ${k.next.label}</span></div><div class="c-bar"><span style="width:${k.progress}%"></span></div>` : ""}
    </div>
    ${k.next ? html`<div class="c-next">${icon("sparkles")}<span><b>Next for you:</b> ${fmt(k.next.toGo)} more karma reaches <b>${k.next.label}</b>${k.next.perks.length ? ` and unlocks ${k.next.perks.join(", ").toLowerCase()}` : ""}.</span></div>` : ""}
    ${cNote(html`Held karma, how an accepted item is priced, and items per tier are on databounty.io. ${cOut(`${cShell.app}/karma/`, "Open karma")}`)}
    ${cSection("Tiers & perks", "What each tier unlocks.")}
    <div class="c-tiers">${d.tiers.map((t) => html`<div class="card c-tier-card ${t.state}">
      <div class="row between"><span class="c-tier" style="color:${/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#6b7360"};background:${/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#6b7360"}22">${t.label}</span><span class="mono small muted">${t.state}</span></div>
      <div class="mono small muted" style="margin-top:10px">${fmt(t.minKarma)}+ karma</div>
      ${t.perks.length ? html`<ul class="c-perks">${t.perks.map((perk) => html`<li>${icon("check")}${perk}</li>`)}</ul>` : ""}
    </div>`)}</div>
    ${cSection("Badges", "Badges record milestones. Perks come from tiers.")}
    <div class="card pad">${d.badges.length ? html`<div class="chips">${d.badges.map((b) => cPill(b, "lime"))}</div>` : html`<p class="small muted" style="margin:0">No badges yet. They arrive as your accepted work adds up.</p>`}</div>
    ${cSection("History", "Newest first.", html`<select class="select" id="c-kind" aria-label="Kind">${kinds.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select>`)}
    <div id="c-history"></div>
    ${cSection("Open leaderboard", "Top contributors across all DataBounty Open datasets.")}
    <div id="c-board">${cSkeleton(1, 120)}</div>
    <p style="margin-top:10px"><a class="mono small" href="#/contributor">find community work →</a></p>`);
  const drawHistory = () => {
    if (!events.length) { mount($("#c-history"), cEmpty("sparkles", "No karma yet", "Karma arrives as validators accept your work and your audits complete.")); return; }
    const days = [];
    for (const e of events) {
      const last = days[days.length - 1];
      if (last && last.day === e.day) last.rows.push(e); else days.push({ day: e.day, rows: [e] });
    }
    mount($("#c-history"), html`<div class="card c-history">${days.map((g) => html`
      <div class="c-day"><span class="micro">${g.day}</span><span class="micro">${g.rows.reduce((s, e) => s + e.amount, 0) >= 0 ? "+" : ""}${fmt(g.rows.reduce((s, e) => s + e.amount, 0))} karma · ${g.rows.length} event${g.rows.length === 1 ? "" : "s"}</span></div>
      ${g.rows.map((e) => html`<div class="c-event">${cPill(e.kind, e.tone)}<span>${e.source}</span><b class="${e.amount < 0 ? "c-neg" : "karma-text"}">${e.amount >= 0 ? "+" : ""}${fmt(e.amount)}</b></div>`)}`)}
      ${next ? html`<div style="text-align:center;padding:12px"><button class="btn btn-sm" id="c-more-karma">Load more</button></div>` : ""}</div>`);
    $("#c-more-karma")?.addEventListener("click", async () => {
      const more = await api(`/api/console/karma?cursor=${encodeURIComponent(next)}${kind ? `&kind=${kind}` : ""}`);
      events = [...events, ...more.events];
      next = more.nextCursor;
      drawHistory();
    });
  };
  $("#c-kind").addEventListener("change", async (e) => {
    kind = e.target.value;
    const fresh = await api(`/api/console/karma${kind ? `?kind=${kind}` : ""}`);
    if (!live()) return;
    events = fresh.events;
    next = fresh.nextCursor;
    drawHistory();
  });
  drawHistory();
  try {
    const board = await api("/api/leaderboard");
    if (!live()) return;
    const me = state.me.handle;
    mount($("#c-board"), board.rows.length ? html`<div class="card table-wrap"><table class="list"><thead><tr><th>rank</th><th>handle</th><th>name</th><th>tier</th><th style="text-align:right">accepted items</th><th style="text-align:right">karma</th></tr></thead>
      <tbody>${board.rows.slice(0, 25).map((row) => html`<tr><td class="mono">#${row.rank}</td><td><a class="plain" href="#/u/${encodeURIComponent(row.handle)}">${row.handle}</a>${row.handle === me ? html` ${cPill("you", "lime")}` : ""}</td><td>${row.display_name || ""}</td><td>${row.tier ? cPill(cap(row.tier)) : ""}</td><td class="mono" style="text-align:right">${fmt(row.accepted_items)}</td><td class="mono karma-text" style="text-align:right">${fmt(row.karma)}</td></tr>`)}</tbody></table></div>`
      : cEmpty("trophy", "Leaderboard is quiet", "No one has earned karma yet."));
  } catch (e) { if (live()) mount($("#c-board"), notice("warn", e.message)); }
}

// --- Profile -------------------------------------------------------------------------------------------------

async function cPageProfile() {
  const live = ticket();
  mount($("#page"), html`${cHead("Profile", "Your capacity and badges, your public page, and your account settings.")}${cBanner()}<div id="c-profile" class="stack">${cSkeleton(3, 120)}</div>`);
  let p;
  try { p = await api("/api/console/profile"); } catch (e) {
    if (live()) mount($("#c-profile"), notice("warn", e.message));
    return;
  }
  if (!live()) return;
  const prefs = p.prefs || {};
  const toggle = (label, on) => html`<div class="c-toggle-row"><span>${label}</span><span class="c-switch ${on ? "on" : ""}" aria-label="${label}: ${on ? "shown" : "hidden"}"></span></div>`;
  const c = p.contributor || {};
  const v = p.validator || {};
  mount($("#c-profile"), html`
    <div class="card pad">
      <div class="micro">display name</div><div class="c-name">${p.displayName || "—"}</div>
      <div class="c-url-row">
        <span class="mono">${p.publicUrl ? p.publicUrl.replace(/^https?:\/\//, "") : "no username yet"}</span>
        ${p.publicUrl ? html`<button class="btn btn-sm" data-action="copy" data-copy="${p.publicUrl}">${icon("copy")} copy</button>` : ""}
        ${p.publicUrl && p.profilePublic ? html`<span style="margin-left:auto">${cOut(p.publicUrl, "view public page")}</span>` : ""}
      </div>
      <div class="c-visibility"><div><b>Page visibility</b><p class="small muted">${p.profilePublic ? "Live. Anyone with the link can see it." : "Off. Only you can see this page."}</p></div><span class="c-switch ${p.profilePublic ? "on" : ""}"></span></div>
      <div class="c-toggles">${toggle("karma & tier", prefs.showKarma !== false)}${toggle("badges", prefs.showBadges !== false)}${toggle("dataset list", prefs.showDatasets !== false)}${toggle("activity", prefs.showActivity !== false)}</div>
      <div class="c-note" style="margin-top:12px">${icon("info")}<span>Your name, page visibility, dataset interests, credentials and password are changed on databounty.io. ${cOut(p.settingsUrl, "Open profile settings")}</span></div>
    </div>
    ${cSection("Capacity", "How much you can claim at once. Reliable delivery raises it.")}
    <div class="two">
      <div class="card pad c-capacity"><div class="row between"><div><div class="micro">contributor capacity</div><b class="c-rank">${c.rank || "—"}</b></div>${cPill(`${fmt(c.maxConcurrentBatches || 1)} batch limit`)}</div>
        <div class="c-metrics"><span>accepted items <b>${fmt(c.acceptedItems || 0)}</b></span><span>clean streak <b>${fmt(c.consecutiveCleanDeliveries || 0)}</b></span><span>missed deadlines <b>${fmt(c.missedDeadlines || 0)}</b></span><span>abandons <b>${fmt(c.abandons || 0)}</b></span></div>
        ${c.nextRank ? html`<div class="mono small muted">${fmt(c.nextRank.itemsToGo)} accepted items to ${c.nextRank.name}</div>` : ""}</div>
      <div class="card pad c-capacity"><div class="row between"><div><div class="micro">validator capacity</div><b class="c-rank">${v.rank || "—"}</b></div>${cPill(`${fmt(v.maxConcurrent || 1)} audits`)}</div>
        <div class="c-metrics"><span>audits completed <b>${fmt(v.auditsCompleted || 0)}</b></span><span>missed deadlines <b>${fmt(v.missedDeadlines || 0)}</b></span><span>false flag rate <b>${v.falseFlagRate != null ? `${v.falseFlagRate}%` : "no decided flags"}</b></span></div>
        ${v.nextRank ? html`<div class="mono small muted">${fmt(v.nextRank.toGo)} audits to ${v.nextRank.name}</div>` : ""}</div>
    </div>
    ${cSection("Badges", "Earned across your contributor and validator work.")}
    <div>${p.badges.length ? html`<div class="chips">${p.badges.map((b) => cPill(b, "lime"))}</div>` : html`<p class="small muted">No earned badges yet.</p>`}</div>`);
}

// --- API & MCP -------------------------------------------------------------------------------------------------

async function cPageDevelopers() {
  const live = ticket();
  const space = `${location.origin}/gradio_api/mcp/`;
  mount($("#page"), html`<header class="c-head compact"><div><h1>Developers <span class="micro">rest api + mcp</span></h1></div></header>${cBanner()}<div id="c-dev" class="stack">${cSkeleton(2, 160)}</div>`);
  let d;
  let tools = { tools: [] };
  try { [d, tools] = await Promise.all([api("/api/console/developers"), api("/api/tools").catch(() => ({ tools: [] }))]); } catch (e) {
    if (live()) mount($("#c-dev"), notice("warn", e.message));
    return;
  }
  if (!live()) return;
  const clients = [
    ["Claude Code", `claude mcp add --transport http databounty ${d.mcpUrl}`],
    ["Cursor", JSON.stringify({ mcpServers: { databounty: { url: d.mcpUrl } } }, null, 2)],
    ["VS Code", JSON.stringify({ servers: { databounty: { type: "http", url: d.mcpUrl } } }, null, 2)],
    ["Claude Desktop", `Settings → Connectors → Add custom connector → ${d.mcpUrl}`],
    ["ChatGPT", `Settings → Connectors → Create → MCP server URL: ${d.mcpUrl}`],
  ];
  let pick = 0;
  mount($("#c-dev"), html`
    <div class="card pad stack">
      <div class="row between wrap"><h3 class="c-card-title">${icon("zap")} MCP server</h3>${cPill(`signed in · ${state.me.email || "@" + state.me.handle}`, "ok")}</div>
      <div class="c-inset"><div class="row wrap" style="gap:8px"><span class="micro">remote · http</span>${cPill("OAuth 2.1 + API key", "ok")}</div>${codeBox(d.mcpUrl)}
        <p class="small muted" style="margin:6px 0 0">Interactive clients open this URL to sign in and approve scopes. Automation sends a scoped API key as a bearer header instead.</p></div>
      <div class="c-inset"><div class="micro">${icon("code")} work with mcp</div>
        <div class="c-clients">${clients.map(([name], i) => html`<button class="btn btn-sm${i === 0 ? " on" : ""}" data-client="${i}">${name}</button>`)}</div>
        <div id="c-client">${codeBox(clients[0][1])}</div></div>
      <div class="c-inset"><div class="micro">oauth connection · browser sign-in</div>
        <div class="c-steps">${[["Sign in", "Use your DataBounty dashboard account."], ["Approve access", "Choose read, contribute, validate, or artifact scopes."], ["Connect client", "Return to Claude, Cursor, or another MCP client."]].map(([t, s], i) => html`<div class="c-step"><b>0${i + 1} ${t}</b><span class="small muted">${s}</span></div>`)}</div></div>
      <details class="c-details"><summary>tools · ${fmt(d.toolCount || tools.tools.length)} live over remote transport</summary>
        <div class="table-wrap" style="max-height:420px"><table class="list"><thead><tr><th>tool</th><th>scope</th><th>what it does</th></tr></thead>
        <tbody>${tools.tools.map((t) => html`<tr><td class="mono small strong">${t.name}</td><td>${cPill(t.scope, t.scope === "public" ? "lime" : "")}</td><td class="small muted">${firstSentence(t.description)}</td></tr>`)}</tbody></table></div></details>
    </div>
    <div class="card pad stack">
      <div class="row between wrap"><h3 class="c-card-title">${icon("shield")} API keys</h3><span class="micro">secret credentials</span></div>
      <div class="c-inset"><p class="small muted" style="margin:0">Create, rotate and revoke your keys on databounty.io, where they're shown once and stored only as a hash. ${cOut(d.keysUrl, "Manage API keys")}</p></div>
    </div>
    <div class="card pad stack">
      <h3 class="c-card-title">${icon("terminal")} This Space's MCP server</h3>
      <p class="small muted" style="margin:0">Browsing needs nothing. To submit items, create an API key with the <b>contribute</b> scope (add <b>sponsor</b> for your own pools) and set it as the <span class="mono">X-DataBounty-Key</span> header. The key never goes in a message, so the AI never sees it.</p>
      ${codeBox(`claude mcp add --transport http databounty-space ${space} --header "X-DataBounty-Key: db_live_sk_..."`)}
    </div>
    <div class="c-tiles3">
      <div class="card pad"><b>${icon("clock")} Rate limits</b><p class="small muted">${fmt(d.rateLimit || 300)} requests / minute per key. Bursts return 429 with a Retry-After header.</p></div>
      <div class="card pad"><b>${icon("refresh")} Same pipeline</b><p class="small muted">Programmatic submissions run the identical verification pipeline: dedupe → AI attribution scan → sandboxed tests → human validator audit.</p></div>
      <div class="card pad"><b>${icon("file")} Full docs</b><p class="small muted">The complete reference lives on databounty.io. ${cOut("https://docs.databounty.io", "docs.databounty.io")}</p></div>
    </div>`);
  $$("[data-client]").forEach((b) => b.addEventListener("click", () => {
    pick = Number(b.dataset.client);
    $$("[data-client]").forEach((x) => x.classList.toggle("on", x === b));
    mount($("#c-client"), codeBox(clients[pick][1]));
  }));
}

// --- Notifications -----------------------------------------------------------------------------------------------

const NOTE_ICON = { ok: "check", warn: "alert", audit: "shield", badge: "award", info: "bell" };

async function cPageNotifications() {
  const live = ticket();
  let unreadOnly = false;
  let items = [];
  let next = null;
  let unread = 0;
  mount($("#page"), html`${cHead("Notification center", "See every alert, and choose where they're delivered.")}${cBanner()}
    <div class="card pad c-channels"><div><b>Delivery channels and new-work alerts</b><p class="small muted">Email, Slack, Discord, Google Chat and Telegram, and the alerts for new work, are set on databounty.io.</p></div><a class="btn" href="${safeUrl(`${cShell.app}/notifications/`)}" target="_blank" rel="noopener">set up channels ${icon("external")}</a></div>
    ${cSection("Inbox", "", html`<span class="mono small muted" id="c-unread"></span>`)}
    <div class="row between wrap" style="margin-bottom:10px"><div class="tabs-pills c-tabs" id="c-ntabs"></div><button class="link mono small" id="c-readall">${icon("check")} mark all read</button></div>
    <div id="c-notes">${cSkeleton(3, 70)}</div>`);
  const load = async (more) => {
    const data = await api(`/api/console/notifications?unread=${unreadOnly ? "true" : "false"}${more && next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
    if (!live()) return;
    items = more ? [...items, ...data.items] : data.items;
    next = data.nextCursor;
    unread = data.unread;
    cShell.unread = unread;
    draw();
  };
  const draw = () => {
    $("#c-unread").textContent = unread ? `${fmt(unread)} unread` : "all caught up";
    mount($("#c-ntabs"), html`<button class="${unreadOnly ? "" : "on"}" data-ntab="all">All</button><button class="${unreadOnly ? "on" : ""}" data-ntab="unread">Unread (${fmt(unread)})</button>`);
    $$("[data-ntab]").forEach((b) => b.addEventListener("click", () => { unreadOnly = b.dataset.ntab === "unread"; load(false); }));
    mount($("#c-notes"), items.length ? html`<div class="stack">${items.map((n) => html`
      <a class="card c-notice${n.read ? "" : " unread"}" href="${n.href ? n.href : safeUrl(n.external)}" ${n.external ? raw('target="_blank" rel="noopener"') : ""} data-note="${n.id}">
        <span class="c-notice-icon c-${n.tone}">${icon(NOTE_ICON[n.tone] || "bell")}</span>
        <span class="c-notice-body"><b>${n.title}${n.read ? "" : html`<i class="c-unread-dot"></i>`}</b><span class="small muted">${n.body}</span></span>
        <span class="mono small muted">${n.when}</span>
      </a>`)}</div>${next ? html`<div style="text-align:center;margin-top:12px"><button class="btn btn-sm" id="c-more-notes">Load more</button></div>` : html`<p class="mono small muted" style="text-align:center;margin-top:14px">you've reached the beginning</p>`}`
      : cEmpty("bell", "No notifications yet", "Activity on your community work will show up here."));
    $$("[data-note]").forEach((a) => a.addEventListener("click", () => {
      const n = items.find((x) => x.id === a.dataset.note);
      if (n && !n.read) { api("/api/console/notifications/read", { method: "POST", body: { id: n.id } }).then(() => { cShell.unread = Math.max(0, cShell.unread - 1); }).catch(() => {}); }
    }));
    $("#c-more-notes")?.addEventListener("click", () => load(true));
  };
  $("#c-readall").addEventListener("click", async () => {
    try { await api("/api/console/notifications/read", { method: "POST", body: {} }); } catch (e) { toast(e.message); return; }
    cShell.unread = 0;
    renderConsoleShell();
    load(false);
  });
  try { await load(false); renderConsoleShell(); } catch (e) { if (live()) mount($("#c-notes"), notice("warn", e.message)); }
}

// --- Support cases ----------------------------------------------------------------------------------------------

const ISSUE_FILTERS = [["", "All cases"], ["needs_info", "Needs your answer"], ["received", "Received"], ["triaged", "Triaged"], ["investigating", "Investigating"], ["resolved", "Resolved"], ["duplicate", "Merged duplicate"], ["not_reproducible", "Not reproducible"], ["rejected", "Closed"]];

async function cPageIssues() {
  const live = ticket();
  mount($("#page"), html`${cHead("Support cases", "Platform problems you or your agent reported. A case is a support channel — it never changes a submission, audit, or karma on its own.")}${cBanner()}
    <div class="filters c-filters"><label class="search">${icon("search")}<input class="input" id="c-iq" placeholder="Search case summaries…" aria-label="Search cases"></label>
      <select class="select" id="c-istatus" aria-label="Status">${ISSUE_FILTERS.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select><span></span></div>
    <div id="c-issues">${cSkeleton(2, 60)}</div>`);
  let timer;
  const load = async () => {
    const q = $("#c-iq").value.trim();
    const status = $("#c-istatus").value;
    let d;
    try { d = await api(`/api/console/issues?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`); } catch (e) {
      if (live()) mount($("#c-issues"), notice("warn", e.message));
      return;
    }
    if (!live()) return;
    mount($("#c-issues"), d.items.length ? html`
      <p class="mono small muted">Filed: ${fmt(d.count)} case${d.count === 1 ? "" : "s"}</p>
      ${d.waiting ? html`<div class="c-note c-note-warn">${icon("alert")}<span>${d.waiting} case${d.waiting === 1 ? " is" : "s are"} waiting on your answer.</span></div>` : ""}
      <div class="card table-wrap"><table class="list c-issue-table"><thead><tr><th>status</th><th>case</th><th>kind</th><th>impact</th><th>context</th><th>updated</th></tr></thead>
      <tbody>${d.items.map((i) => html`<tr data-issue="${i.id}"><td>${cPill(i.statusLabel, i.statusTone)}</td><td><a class="plain strong" href="#/issues/${encodeURIComponent(i.id)}">${i.summary}</a><div class="mono small muted">${i.id} · open full page</div></td><td class="small">${i.kind}</td><td>${cPill(i.impact, i.impactTone)}</td><td>${cPill(i.context)}</td><td class="mono small muted">${i.updated}</td></tr>`)}</tbody></table></div>`
      : cEmpty("triangle", "No support cases filed", "When you or your agent hits a platform problem — a broken contract, a validation that looks wrong, an upload that won't process — report it with the report_issue tool over MCP and it appears here with its status."));
    $$("[data-issue]").forEach((row) => row.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = `#/issues/${encodeURIComponent(row.dataset.issue)}`; }));
  };
  $("#c-iq").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  $("#c-istatus").addEventListener("change", load);
  load();
}

async function cPageIssue(id) {
  const live = ticket();
  const back = html`<a class="back" href="#/issues">${icon("back")} support cases</a>`;
  mount($("#page"), html`${back}<div class="skeleton" style="height:160px"></div>`);
  const draw = (i) => {
    mount($("#page"), html`${back}
      <header class="c-head"><div><h1>${i.summary}</h1><div class="row wrap" style="gap:6px;margin-top:8px">${cPill(i.statusLabel, i.statusTone)}${cPill(i.impact, i.impactTone)}${cPill(i.kind)}${cPill(i.context)}</div></div></header>
      ${i.guidance ? cNote(i.guidance) : ""}
      <div class="c-issue-grid">
        <div class="stack">
          <div class="card pad"><h3 class="c-card-title">What you reported</h3>
            <div class="micro" style="margin-top:10px">expected</div><p>${i.expected}</p>
            <div class="micro">actual</div><p>${i.actual}</p>
            ${i.steps ? html`<div class="micro">steps</div><pre class="block">${i.steps}</pre>` : ""}</div>
          ${i.outcome ? html`<div class="card pad"><h3 class="c-card-title">Outcome</h3><p>${i.outcome}</p></div>` : ""}
          <div class="card pad"><h3 class="c-card-title">History</h3><div class="c-timeline">${i.history.map((h) => html`<div class="c-tl-row"><span class="mono small muted">${h.when}</span><div><b class="small">${h.who}</b> <span class="small muted">${h.type}</span><p class="small" style="margin:4px 0 0">${h.body}</p></div></div>`)}</div></div>
          <div class="card pad">${i.canReply ? html`<h3 class="c-card-title">Add a reply</h3><textarea class="textarea" id="c-reply" maxlength="2000" placeholder="What else should DataBounty know?"></textarea>
            <div class="row between" style="margin-top:8px"><span class="mono small muted" id="c-reply-count">0 / 2000</span><button class="btn btn-primary" id="c-send" disabled>Send reply</button></div>` : html`<p class="small muted" style="margin:0">This case is closed.</p>`}</div>
        </div>
        <aside class="stack">
          <div class="card pad"><div class="micro">case</div><div class="c-kv"><span>Filed</span><b>${i.filed}</b></div><div class="c-kv"><span>Last update</span><b>${i.updated}</b></div><div class="c-kv"><span>Also reported by</span><b>${fmt(i.alsoReportedBy)}</b></div></div>
          <div class="card pad"><div class="micro">a case is not a dispute</div><p class="small muted">A case reports a platform problem. It never changes a submission, an audit or karma by itself.</p></div>
        </aside>
      </div>`);
    const box = $("#c-reply");
    if (!box) return;
    box.addEventListener("input", () => { $("#c-reply-count").textContent = `${box.value.length} / 2000`; $("#c-send").disabled = !box.value.trim(); });
    $("#c-send").addEventListener("click", async () => {
      $("#c-send").disabled = true;
      try { draw(await api(`/api/console/issues/${encodeURIComponent(id)}/reply`, { method: "POST", body: { body: box.value } })); toast("Reply sent."); }
      catch (e) { toast(e.message); $("#c-send").disabled = false; }
    });
  };
  try {
    const i = await api(`/api/console/issues/${encodeURIComponent(id)}`);
    if (live()) draw(i);
  } catch (e) { if (live()) mount($("#page"), html`${back}${notice("warn", e.message)}`); }
}
