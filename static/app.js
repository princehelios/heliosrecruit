"use strict";

/* ==========================================================================
   Resume Screener UI (simple)
   Routes:  #/dashboard        totals, per-position stats, resumes not in Recruit
            #/                 positions (role folders)
            #/folder/<id>      position or date folder: JD, resumes, screen
            #/candidates       screened candidates
            #/pending          resumes waiting for the Google Form
            #/invites          fetched applicants to send the Google Form to (review, then send)
            #/sheets           Google Form response sheet link per position
            #/log              activity log
            #/run/<id>         one run
   Resume-derived text is untrusted: everything goes through esc(), and only
   http(s) URLs are rendered as links.
   ========================================================================== */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const state = {
  status: null, folder: null, selected: new Set(), poll: null,
  cand: { filter: "", q: "", recruit: "", role: "", sort: "screened", dir: "desc", page: 1, pageSize: 10 },
  notes: { unseen: -1 },
  list: { folderId: null, q: "", filter: "all", page: 1 },
  // Last /api/browse answer per folder: revisiting a folder renders at once,
  // then refreshes in the background.
  browse: new Map(),
  roots: { q: "", filter: "all", sort: prefGet("pos-sort", "recent") },
  act: { data: null, range: prefGet("apps-range", "30"), role: "", day: null, view: "chart" },
};

function prefGet(key, fallback) {
  try { return localStorage.getItem(`rs:${key}`) || fallback; } catch { return fallback; }
}
function prefSet(key, value) {
  try { localStorage.setItem(`rs:${key}`, value); } catch { /* storage unavailable */ }
}

/* ---------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeUrl(url) {
  let u = String(url || "").trim();
  if (!u || /^mailto:/i.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch { return null; }
}

function link(url, label) {
  const safe = safeUrl(url);
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label || url)}</a>` : esc(label || url || "");
}

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
  }
  let resp;
  try { resp = await fetch(path, opts); } catch { throw new Error("Can't reach the server. Is it running?"); }
  let data = {};
  try { data = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) throw new Error(data.error || `Request failed (HTTP ${resp.status})`);
  return data;
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  return d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function secs(ms) {
  if (ms == null) return "";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

function between(startIso, endIso) {
  if (!startIso || !endIso) return "";
  const ms = new Date(endIso) - new Date(startIso);
  return isNaN(ms) || ms < 0 ? "" : secs(ms);
}

const bytes = n => n == null ? "" : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
const chips = (items, cls = "") => (items || []).length ? `<div class="chips">${items.map(i => `<span class="tag ${cls}">${esc(i)}</span>`).join("")}</div>` : "";

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" || kind === "success" ? kind : ""}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 4000);
}

const I = {
  refresh: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
  search: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  chevron: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  folder: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>`,
  warn: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`,
  move: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>`,
  close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  inbox: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
};

/* ---------------------------------------------------------------- badges */

/* Bands: the AI's 0-100 score (resume + Google Form) -> High / Medium / Low.
   High and Medium go to Zoho Recruit. Cut-offs come from /api/status. */
function bandOf(score) {
  if (score == null) return "";
  const b = state.status?.bands || { high: 75, medium: 50 };
  return score >= b.high ? "High" : score >= b.medium ? "Medium" : "Low";
}

function scoreBadge(score) {
  if (score == null) return `<span class="muted">—</span>`;
  const s = Math.round(score), band = bandOf(s);
  return `<span class="score ${band === "High" ? "hi" : band === "Medium" ? "mid" : "lo"}" title="Score ${s}/100">${band} <small>${s}</small></span>`;
}

function resultTag(s) {
  if (!s) return `<span class="muted">Not screened</span>`;
  if (s.stage && s.stage !== "done") return `<span class="stage"><span class="spinner"></span> Screening…</span>`;
  const tag = {
    passed: `<span class="tag good">To Recruit</span>`,
    rejected: `<span class="tag">Low - kept</span>`,
    failed: `<span class="tag bad" title="${esc(s.error || "")}">Failed</span>`,
    form_pending: `<span class="tag warn" title="${esc(s.workdrive_reason || "")}">Waiting for form</span>`,
    walkin: `<span class="tag blue" title="Scored on resume + HR notes; not sent to Recruit">Walk-in · app only</span>`,
  }[s.outcome] || "";
  const removed = s.workdrive_action === "deleted" ? ` <span class="tag blue">Removed</span>` : "";
  return tag + removed;
}

function fileIcon(name) {
  const ext = String(name).toLowerCase().endsWith(".docx") ? "docx" : "pdf";
  return `<span class="file-icon ${ext}">${ext.toUpperCase()}</span>`;
}

/* ---------------------------------------------------------------- status */

async function loadStatus() {
  try { state.status = await api("/api/status"); } catch (e) { state.status = { error: e.message }; }
  renderStatus();
}

function canDelete() {
  const s = state.status || {};
  return !!s.delete_enabled && ["WorkDrive.files.UPDATE", "WorkDrive.files.DELETE"]
    .every(n => (s.scopes || []).find(x => x.scope === n)?.granted);
}

function renderStatus() {
  const s = state.status;
  const problems = [];
  if (!s || s.error) problems.push("Server unreachable");
  else {
    if (!s.zoho_connected) problems.push("Zoho not connected");
    if (!s.openai_configured) problems.push("OpenAI key missing");
    const missing = (s.scopes || []).filter(x => !x.granted).map(x => x.scope);
    if (missing.length) problems.push(`Zoho permission missing: ${missing.join(", ")}`);
  }
  $("#status").innerHTML = problems.length
    ? problems.map(p => `<div class="sys-row"><span class="dot bad"></span>${esc(p)}</div>`).join("")
    : `<div class="sys-row"><span class="dot ok"></span>Connected</div>`;
  $("#banner").innerHTML = problems.length && s && !s.error
    ? `<div class="banner error">${I.warn}<div><strong>Setup needs attention</strong><p>${problems.map(esc).join(" · ")}</p></div></div>` : "";
}

/* ---------------------------------------------------------------- router */

async function route() {
  closeDrawer();
  const hash = location.hash || "#/";
  const view = $("#view");
  let m;
  const nav = (hash === "#/" || hash.startsWith("#/home")) ? "home"
    : hash.startsWith("#/applicant") ? "applicants" : hash.startsWith("#/positions") ? "positions"
    : hash.startsWith("#/settings") ? "settings" : hash.startsWith("#/forms") ? "forms"
    : hash.startsWith("#/dashboard") ? "dashboard" : hash.startsWith("#/candidates") ? "candidates"
    : hash.startsWith("#/pending") ? "pending" : hash.startsWith("#/sheets") ? "sheets"
    : hash.startsWith("#/invites") ? "invites"
    : (hash.startsWith("#/log") || hash.startsWith("#/run/")) ? "log" : "screen";
  $$(".nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
  window.scrollTo(0, 0);

  if (nav === "home") return renderHome(view);
  if ((m = hash.match(/^#\/applicant\/([^?]+)/))) return renderApplicant(view, decodeURIComponent(m[1]));
  if (nav === "applicants") return renderApplicants(view);
  if (nav === "positions") return renderPositions(view);
  if (nav === "settings") return renderSettings(view);
  if (nav === "forms") return renderForms(view);
  if (nav === "dashboard") return renderDashboard(view);
  if (nav === "candidates") return renderCandidates(view);
  if (nav === "pending") return renderPending(view);
  if (nav === "sheets") return renderSheets(view);
  if (nav === "invites") return renderInvites(view);
  if ((m = hash.match(/^#\/run\/(\d+)/))) return renderRun(view, Number(m[1]));
  if (nav === "log") return renderLog(view);
  m = hash.match(/^#\/folder\/([A-Za-z0-9]+)/);
  return renderFolder(view, m ? m[1] : null);
}

const loading = view => { view.innerHTML = `<div class="loading-block"><span class="spinner"></span> Loading…</div>`; };
const errorView = (view, msg) => { view.innerHTML = `<div class="card"><div class="empty">${I.warn}<strong>Couldn't load this page</strong>${esc(msg)}</div></div>`; };

function bindRows(root) {
  $$("[data-href]", root).forEach(el => el.addEventListener("click", e => {
    if (!e.target.closest("a, button, input")) location.hash = el.dataset.href;
  }));
  $$("[data-screening]", root).forEach(el => el.addEventListener("click", e => {
    if (!e.target.closest("a, button, input")) openScreening(Number(el.dataset.screening));
  }));
}

/* ---------------------------------------------------------------- folders */

const browseKey = folderId => folderId || "root";
const sameRoute = folderId => {
  const m = (location.hash || "#/").match(/^#\/folder\/([A-Za-z0-9]+)/);
  // The root folder page is #/files now; "#/" is Home, so a null folder must
  // only match #/files or a late refresh would paint the folder over Home.
  if (!folderId) return location.hash === "#/files";
  return (m ? m[1] : null) === folderId;
};
// Compare answers without the volatile "stale" flag, so a background refresh
// only re-renders the page when something actually changed.
const browseSig = d => JSON.stringify({ ...d, stale: undefined });

function skeletonView(view, folderId) {
  const cards = Array.from({ length: folderId ? 4 : 8 }, () => `<div class="folder-card skeleton-card" aria-hidden="true">
      <div class="row"><span class="sk sk-icon"></span><div class="grow"><span class="sk sk-line w70"></span><span class="sk sk-line w40"></span></div></div>
      <div class="folder-foot"><span class="sk sk-pill"></span><span class="sk sk-pill"></span></div></div>`).join("");
  view.innerHTML = `<div class="page-head"><div><span class="sk sk-title"></span><span class="sk sk-line w30"></span></div></div>
    ${folderId ? "" : `<div class="pos-stats">${`<div class="pos-stat skeleton-card"><span class="sk sk-line w40"></span><span class="sk sk-num"></span></div>`.repeat(4)}</div>`}
    <div class="folder-grid" aria-busy="true" aria-label="Loading">${cards}</div>`;
}

async function renderFolder(view, folderId, { quiet = false } = {}) {
  const key = browseKey(folderId);
  const cached = state.browse.get(key);
  let shown = null;
  // A cached answer paints immediately; the network answer replaces it below.
  if (cached && !quiet) { paintFolder(view, cached); shown = browseSig(cached); }
  else if (!quiet) skeletonView(view, folderId);

  let data;
  try { data = await api(`/api/browse${folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ""}`); }
  catch (e) { if (!shown) errorView(view, e.message); else toast(e.message, "error"); return; }
  if (!sameRoute(folderId)) return;  // the user navigated away meanwhile
  state.browse.set(key, data);
  if (browseSig(data) !== shown) { paintFolder(view, data); shown = browseSig(data); }
  setRefreshing(!!data.stale);

  if (data.stale) {
    // Served from the server's cache while it refreshes: pick up the live numbers.
    try {
      const live = await api(`/api/browse?live=1${folderId ? `&folder_id=${encodeURIComponent(folderId)}` : ""}`);
      if (!sameRoute(folderId)) return;
      state.browse.set(key, live);
      if (browseSig(live) !== shown) paintFolder(view, live);
    } catch { /* keep the cached view */ }
    setRefreshing(false);
  }
}

function setRefreshing(on) {
  const el = $("#refresh-state");
  if (!el) return;
  el.innerHTML = on ? `<span class="spinner"></span> Updating…` : `Up to date`;
  el.classList.toggle("busy", on);
}

function paintFolder(view, data) {
  // Keep what the user was typing when the page re-renders under them.
  const active = document.activeElement;
  const focusId = active && view.contains(active) && active.id ? active.id : null;
  const caret = focusId && typeof active.selectionStart === "number" ? active.selectionStart : null;

  if (!state.folder || state.folder.folder.id !== data.folder.id) state.selected.clear();
  if (state.list.folderId !== data.folder.id) state.list = { folderId: data.folder.id, q: "", filter: "all", page: 1 };
  const ids = new Set(data.files.map(f => f.id));
  state.selected = new Set([...state.selected].filter(id => ids.has(id)));
  state.folder = data;

  view.innerHTML = data.depth === 0 ? rootHtml(data) : folderHtml(data);
  bindFolder(view, data);
  if (data.active_run_id) { startPolling(data.active_run_id, data.folder.id); renderSelectBar(); }
  if (focusId && $(`#${focusId}`, view)) {
    const el = $(`#${focusId}`, view);
    el.focus();
    if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ }
  }
}

const isPendingFolder = f => (f.name || "").trim().toLowerCase() === (state.status?.form_pending_folder || "Form Pending").toLowerCase();
const isWalkinFolder = f => (f.name || "").trim().toLowerCase() === (state.status?.walkin_folder || "Walk-in").toLowerCase();
const isSpecialFolder = f => isPendingFolder(f) || isWalkinFolder(f);

/* Date folder names as typed by the team ("9 Oct", "7 oct 2026", "17 september",
   "19 Sept") -> a timestamp for newest-first sorting; null if not a date. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function folderDate(name) {
  const m = String(name || "").trim().match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?(?:[\s-]+(\d{4}))?$/i);
  if (!m) return null;
  const day = Number(m[1]), mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mon < 0 || day < 1 || day > 31) return null;
  const now = new Date();
  let d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, day);
  if (!m[3] && d - now > 31 * 864e5) d = new Date(now.getFullYear() - 1, mon, day);  // "28 Dec" seen in January
  return d.getTime();
}

const lastActivity = f => Math.max(Number(f.modified) || 0, f.last_activity ? Date.parse(f.last_activity) || 0 : 0);

function sortFolders(folders, depth) {
  return [...folders].sort((a, b) => {
    const rank = f => isPendingFolder(f) ? 0 : isWalkinFolder(f) ? 1 : 2;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (depth === 0) return lastActivity(b) - lastActivity(a);
    const da = folderDate(a.name), db = folderDate(b.name);
    if (da != null && db != null) return db - da;
    if (da != null || db != null) return da != null ? -1 : 1;
    return (Number(b.modified) || 0) - (Number(a.modified) || 0);
  });
}

function folderCard(f, depth) {
  if (depth === 0) return positionCard(f);
  const pending = isPendingFolder(f), walkin = isWalkinFolder(f);
  const empty = !f.folder_count && !f.resume_count && !pending && !walkin;
  const meta = walkin ? plural(f.resume_count || 0, "walk-in candidate") : [
    f.folder_count ? plural(f.folder_count, depth === 0 ? "date folder" : "folder") : "",
    f.resume_count || !f.folder_count ? plural(f.resume_count || 0, "resume") : "",
  ].filter(Boolean).join(" · ") + (pending ? " waiting for the Google Form" : "");
  const tags = [];
  if (depth === 0) {
    tags.push(f.has_jd ? `<span class="tag good">JD ✓</span>` : `<span class="tag warn">No JD</span>`);
    tags.push(f.has_sheet ? `<span class="tag good">Form sheet ✓</span>` : `<span class="tag">No form sheet</span>`);
    if (f.waiting) tags.push(`<span class="tag warn">${f.waiting} waiting for form</span>`);
  }
  if (f.unscreened && !pending) tags.push(`<span class="tag blue">${f.unscreened} not screened</span>`);
  return `<a class="folder-card ${pending ? "pending" : ""} ${walkin ? "walkin" : ""} ${empty ? "is-empty" : ""}" href="#/folder/${esc(f.id)}" data-name="${esc(f.name.toLowerCase())}">
    <div class="row"><span class="folder-icon">${I.folder}</span>
      <div style="min-width:0"><div class="folder-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="folder-meta">${meta}</div></div></div>
    ${tags.length ? `<div class="folder-foot">${tags.join("")}</div>` : ""}
  </a>`;
}

function folderGrid(folders, depth) {
  return `<div class="folder-grid">${sortFolders(folders, depth).map(f => folderCard(f, depth)).join("")}</div>`;
}

/* ---------------------------------------------------------------- positions (root) page */

const isEmptyPosition = f => !f.folder_count && !f.resume_count;

function positionCard(f) {
  const empty = isEmptyPosition(f);
  const meta = [
    f.folder_count ? plural(f.folder_count, "date folder") : "",
    f.resume_count || !f.folder_count ? plural(f.resume_count || 0, "resume") : "",
  ].filter(Boolean).join(" · ");
  const check = (ok, label) => `<span class="setup-dot ${ok ? "ok" : ""}" title="${label}: ${ok ? "set" : "not set"}">${ok ? "✓" : "–"} ${label}</span>`;
  const todo = f.unscreened ? `<span class="tag blue todo">${f.unscreened} to screen</span>`
    : f.waiting ? `<span class="tag warn todo">${f.waiting} waiting for form</span>` : "";
  return `<a class="folder-card pos-card ${empty ? "is-empty" : ""} ${f.unscreened ? "has-todo" : ""}" href="#/folder/${esc(f.id)}"
      data-id="${esc(f.id)}" title="${esc(f.name)}">
    <div class="row"><span class="folder-icon">${I.folder}</span>
      <div class="grow"><div class="folder-name clamp-2">${esc(f.name)}</div>
      <div class="folder-meta">${f.error ? `<span class="muted">Couldn't count resumes</span>` : meta}</div></div>
      <span class="pos-go" aria-hidden="true">${I.chevron}</span></div>
    <div class="folder-foot">${check(f.has_jd, "JD")}${check(f.has_sheet, "Form sheet")}<span class="spacer"></span>${todo}</div>
  </a>`;
}

const POS_FILTERS = [
  ["all", "All", () => true],
  ["todo", "To screen", f => f.unscreened > 0],
  ["nojd", "Missing JD", f => !f.has_jd],
  ["nosheet", "Missing form sheet", f => !f.has_sheet],
];
const POS_SORTS = [["recent", "Recent activity"], ["todo", "Most to screen"], ["name", "Name (A–Z)"]];

function sortPositions(list) {
  const by = state.roots.sort;
  return [...list].sort((a, b) => {
    // Empty positions always sink to the bottom.
    if (isEmptyPosition(a) !== isEmptyPosition(b)) return isEmptyPosition(a) ? 1 : -1;
    if (by === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    if (by === "todo" && (b.unscreened || 0) !== (a.unscreened || 0)) return (b.unscreened || 0) - (a.unscreened || 0);
    return lastActivity(b) - lastActivity(a);
  });
}

function rootStatsHtml(subs) {
  const toScreen = subs.reduce((n, f) => n + (f.unscreened || 0), 0);
  const withTodo = subs.filter(f => f.unscreened > 0).length;
  const noJd = subs.filter(f => !f.has_jd).length;
  const noSheet = subs.filter(f => !f.has_sheet).length;
  const stat = (filter, label, value, note, cls = "") => `<button class="pos-stat ${cls} ${state.roots.filter === filter ? "active" : ""}" data-filter="${filter}">
      <span class="label">${label}</span><span class="value">${value.toLocaleString()}</span><span class="note">${note}</span></button>`;
  return `<div class="pos-stats" role="group" aria-label="Filter positions">
    ${stat("all", "Positions", subs.length, `${subs.filter(f => !isEmptyPosition(f)).length} with resumes`)}
    ${stat("todo", "Resumes to screen", toScreen, withTodo ? `across ${plural(withTodo, "position")}` : "All caught up", toScreen ? "info" : "")}
    ${stat("nojd", "Missing job description", noJd, noJd ? "Can't be screened yet" : "All set", noJd ? "warn" : "")}
    ${stat("nosheet", "Missing form sheet", noSheet, noSheet ? "Scored on resume alone" : "All linked")}
  </div>`;
}

function rootHtml(data) {
  const subs = data.subfolders;
  return `<div class="page-head"><div><h1>Positions</h1>
        <div class="sub"><span id="refresh-state" class="refresh-state">Up to date</span></div></div>
      <div class="head-actions">
        <button class="btn" id="add-walkin">+ Add walk-in</button>
        <button class="btn" id="fetch-emails">Fetch from email</button>
        <button class="btn primary" id="new-folder" data-label="position">+ New position</button>
      </div></div>
    ${subs.length ? `${rootStatsHtml(subs)}
      <div class="pos-toolbar">
        <label class="search-box">${I.search}<input type="search" id="pos-q" placeholder="Search positions" aria-label="Search positions" value="${esc(state.roots.q)}"></label>
        <span class="spacer"></span>
        <label class="sort-box">Sort <select id="pos-sort" aria-label="Sort positions">
          ${POS_SORTS.map(([v, l]) => `<option value="${v}" ${state.roots.sort === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
        <button class="btn ghost icon-btn" id="pos-refresh" title="Reload from WorkDrive" aria-label="Reload from WorkDrive">${I.refresh}</button>
      </div>
      <div class="folder-grid" id="pos-grid"></div>
      <div class="card hidden" id="pos-none"><div class="empty"><strong>No positions match</strong><span id="pos-none-why"></span></div></div>`
      : `<div class="card"><div class="empty">${I.inbox}<strong>No positions yet</strong>Click + New position, or create folders like "Full Stack" in the WorkDrive resumes folder.</div></div>`}`;
}

function renderPositions(view, data) {
  const grid = $("#pos-grid", view);
  if (!grid) return;
  const q = state.roots.q.toLowerCase();
  const test = (POS_FILTERS.find(([k]) => k === state.roots.filter) || POS_FILTERS[0])[2];
  const list = sortPositions(data.subfolders.filter(f => test(f) && (!q || f.name.toLowerCase().includes(q))));
  grid.innerHTML = list.map(positionCard).join("");
  $("#pos-none", view).classList.toggle("hidden", list.length > 0);
  $("#pos-none-why", view).textContent = q ? `Nothing matches "${state.roots.q}".` : "No position fits this filter.";
  $$(".pos-stat", view).forEach(b => b.classList.toggle("active", b.dataset.filter === state.roots.filter));
}

function bindPositions(view, data) {
  renderPositions(view, data);
  $$(".pos-stat", view).forEach(b => b.addEventListener("click", () => {
    state.roots.filter = state.roots.filter === b.dataset.filter ? "all" : b.dataset.filter;
    renderPositions(view, data);
  }));
  $("#pos-q", view)?.addEventListener("input", e => { state.roots.q = e.target.value.trim(); renderPositions(view, data); });
  $("#pos-sort", view)?.addEventListener("change", e => {
    state.roots.sort = e.target.value; prefSet("pos-sort", e.target.value); renderPositions(view, data);
  });
  $("#pos-refresh", view)?.addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.classList.add("spinning"); setRefreshing(true);
    try {
      const live = await api("/api/browse?live=1");
      state.browse.set("root", live);
      if (sameRoute(null)) paintFolder(view, live);
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.classList.remove("spinning"); setRefreshing(false); }
  });
}

function folderHtml(data) {
  const crumbs = data.path.map((p, i) => {
    const last = i === data.path.length - 1;
    const label = i === 0 ? "Positions" : esc(p.name);
    return (i ? `<span class="sep">/</span>` : "") + (last ? `<span class="current">${label}</span>` : `<a href="${i === 0 ? "#/files" : `#/folder/${esc(p.id)}`}">${label}</a>`);
  }).join("");
  const pending = isPendingFolder(data.folder);

  return `<nav class="crumbs">${crumbs}</nav>
    <div class="page-head"><div><h1>${esc(data.folder.name)}</h1></div>
      <div class="head-actions">
        <button class="btn" id="add-walkin">+ Add walk-in</button>
        ${data.depth === 1 ? `<button class="btn" id="new-folder" data-label="date folder">+ New date folder</button>` : ""}
        <button class="btn primary" id="upload-btn">Upload resumes</button>
        <input type="file" id="upload-input" accept=".pdf,.docx" multiple hidden>
        <div class="menu-wrap">
          <button class="btn ghost icon-btn" id="folder-menu" aria-haspopup="true" aria-expanded="false" title="More actions" aria-label="More folder actions">⋯</button>
          <div class="menu" id="folder-menu-list" role="menu" hidden>
            ${isSpecialFolder(data.folder) ? "" : `<button role="menuitem" data-act="rename">${I.edit} Rename folder</button>`}
            <button role="menuitem" data-act="delete" class="danger">${I.trash} Delete folder…</button>
          </div>
        </div>
      </div></div>
    <div class="stack">
      ${setupBarHtml(data)}
      <div id="live-run"></div>
      ${data.subfolders.length ? `<div><h2 class="section-title">${data.depth === 1 ? "Date folders" : "Folders"}</h2>${folderGrid(data.subfolders, data.depth)}</div>` : ""}
      ${data.files.length ? resumesHtml(data) : data.subfolders.length ? ""
        : `<div class="card"><div class="empty">${I.inbox}<strong>No resumes here</strong>Click <b>Upload resumes</b>, or add .pdf / .docx files to this folder in WorkDrive.</div></div>`}
    </div>`;
}

function bandsLine() {
  const b = state.status?.bands || { high: 75, medium: 50 };
  return `High ${b.high}+ · Medium ${b.medium}–${b.high - 1} · Low &lt;${b.medium}. High and Medium go to Zoho Recruit.`;
}

const hasJdText = data => !!(data.jd?.jd_text || "").trim();

/* One compact line instead of two big cards: the resumes stay on the first screen. */
function setupBarHtml(data) {
  const jd = data.jd || {}, sheet = jd.form_sheet_url || "";
  const text = (jd.jd_text || "").replace(/\s+/g, " ").trim();
  return `<section class="card setup-bar">
    <div class="setup-item">
      <span class="setup-label">Job description</span>
      ${text ? `<span class="setup-text" title="${esc(text.slice(0, 600))}">${esc(text.slice(0, 110))}${text.length > 110 ? "…" : ""}</span>`
        : `<span class="tag warn">Not added - needed to screen</span>`}
      <button class="btn sm" id="jd-open">${text ? "Edit" : "Add"}</button>
    </div>
    ${isWalkinFolder(data.folder) ? `<div class="setup-item"><span class="setup-label">Walk-ins</span>
      <span class="muted small">No Google Form check · scored on resume + HR notes · stay in the app, not sent to Recruit</span></div>` : `<div class="setup-item">
      <span class="setup-label">Google Form</span>
      <span id="sheet-tag">${sheet ? sheetStatusHtml(null) : `<span class="tag">Not linked - resumes scored alone</span>`}</span>
      ${sheet ? `<a class="btn sm" href="${esc(safeUrl(sheet) || "#")}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
      <button class="btn sm" id="sheet-open">${sheet ? "Change" : "Link sheet"}</button>
    </div>`}
    <div class="setup-bands muted small">${bandsLine()}</div>
  </section>`;
}

function jdDialog(data) {
  openModal(`
    <h2>Job description · ${esc(data.role.name)}</h2>
    <p class="muted small">Every resume in this position is scored against this. ${bandsLine()}</p>
    <div class="field"><textarea id="jd-text" placeholder="Paste the job description for ${esc(data.role.name)}…">${esc(data.jd?.jd_text || "")}</textarea></div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="jd-save">Save</button>
    </div>`, { wide: true });
  $("#jd-text").focus();
  $("#jd-save").addEventListener("click", async () => {
    const btn = $("#jd-save");
    btn.disabled = true;
    try {
      await api(`/api/roles/${encodeURIComponent(data.role.id)}/jd`, { method: "PUT", body: { jd_text: $("#jd-text").value } });
      closeModal();
      toast("Job description saved", "success");
      renderFolder($("#view"), data.folder.id, { quiet: true });
    } catch (e) { toast(e.message, "error"); btn.disabled = false; }
  });
}

function sheetDialog(data) {
  const url = data.jd?.form_sheet_url || "";
  const pendingPath = `${esc(data.role.name)} / ${esc(state.status?.form_pending_folder || "Form Pending")}`;
  openModal(`
    <h2>Google Form responses · ${esc(data.role.name)}</h2>
    <p>${SHEET_HELP}</p>
    <div class="field"><label for="sheet-url">Response sheet link</label>
      <input type="text" id="sheet-url" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(url)}">
      <div class="help" id="sheet-detail">${url ? `<span class="spinner"></span> Checking the sheet…` : ""}</div></div>
    <p class="muted small">Each resume is matched to its response by email or phone. No response yet → it moves to <b>${pendingPath}</b>
      and you're notified when the form is filled. Without a link, resumes are scored on the resume alone.</p>
    <div class="modal-actions">
      ${url ? `<button class="btn ghost" id="sheet-remove">Remove link</button><span class="spacer"></span>` : ""}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="sheet-save">Save link</button>
    </div>`, { wide: true });
  const input = $("#sheet-url");
  input.focus();
  if (url) {
    api(`/api/roles/${encodeURIComponent(data.role.id)}/sheet`)
      .then(sh => { const d = $("#sheet-detail"); if (d) d.innerHTML = `${sheetStatusHtml(sh)} ${sheetDetail(sh)}`; })
      .catch(() => { const d = $("#sheet-detail"); if (d) d.innerHTML = ""; });
  }
  const submit = async value => {
    const btn = $("#sheet-save");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Reading sheet…`;
    try {
      await saveSheet(data.role.id, value);
      closeModal();
      renderFolder($("#view"), data.folder.id, { quiet: true });
    } catch (e) { toast(e.message, "error"); btn.disabled = false; btn.textContent = "Save link"; }
  };
  $("#sheet-save").addEventListener("click", () => input.value.trim() ? submit(input.value.trim()) : input.focus());
  input.addEventListener("keydown", e => { if (e.key === "Enter" && input.value.trim()) submit(input.value.trim()); });
  $("#sheet-remove")?.addEventListener("click", () => submit(""));
}

/* ---- resume list: status filter chips, search, 50 per page, sticky selection bar */

const PAGE_SIZE = 50;

/* Timeline: resumes newest first, grouped by the day they were added to WorkDrive. */
const addedAt = f => Number(f.added || f.modified) || 0;
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const isToday = ms => !!ms && dayKey(ms) === dayKey(Date.now());
function dayLabel(ms) {
  if (!ms) return "Date unknown";
  if (isToday(ms)) return "Today";
  if (dayKey(ms) === dayKey(Date.now() - 864e5)) return "Yesterday";
  const d = new Date(ms);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
const timeLabel = ms => ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

/* "Today's new": added today and not screened yet (a failed attempt counts as not screened),
   so a second upload batch the same day doesn't re-score the morning's resumes. */
const todaysNew = data => data.files.filter(f => isToday(addedAt(f)) && ["unscreened", "failed"].includes(fileStatus(f)));
const FILE_FILTERS = [["all", "All"], ["unscreened", "Not screened"], ["running", "Screening"], ["form_pending", "Waiting for form"],
  ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["failed", "Failed"]];

function fileStatus(f) {
  const s = f.last_screening;
  if (!s) return "unscreened";
  if (s.stage && s.stage !== "done") return "running";
  if (s.outcome === "form_pending") return "form_pending";
  if (s.outcome === "failed") return "failed";
  if (s.outcome === "walkin" && s.overall_score == null) return "unscreened";
  if (s.overall_score == null) return "unscreened";
  return bandOf(s.overall_score).toLowerCase();
}

function visibleFiles() {
  const q = state.list.q.toLowerCase();
  return state.folder.files.slice().sort((a, b) => addedAt(b) - addedAt(a)).filter(f => {
    if (state.list.filter !== "all" && fileStatus(f) !== state.list.filter) return false;
    if (!q) return true;
    const s = f.last_screening || {};
    return [f.name, s.candidate_name, s.email].some(v => (v || "").toLowerCase().includes(q));
  });
}

function resumesHtml(data) {
  return `<section class="card" id="resumes-card">
    <div class="card-head">
      <h2>Resumes <span class="muted" style="font-weight:400">(${data.files.length})</span></h2>
      <div class="head-actions">
        ${data.active_run_id ? `<button class="btn stop-btn" id="stop-btn">Stop screening</button>` : ""}
        <button class="btn ghost" id="rescreen-all" title="Score every resume in this folder again">Re-screen all</button>
        <button class="btn primary" id="screen-today">${I.play} Screen today's uploads</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="segmented" id="file-filters" role="group" aria-label="Filter by result"></div>
      <span class="spacer"></span>
      <input type="search" id="file-q" placeholder="Search file, name or email" aria-label="Search resumes" value="${esc(state.list.q)}">
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="check"><input type="checkbox" id="select-all" aria-label="Select all on this page"></th>
        <th>File</th><th>Added</th><th>Candidate</th><th class="num">Band</th><th>Result</th><th></th>
      </tr></thead>
      <tbody id="resume-rows"></tbody></table></div>
    <div class="pagination" id="file-pager"></div>
    ${hasJdText(data) ? "" : `<div class="card-foot muted small">Add the job description above to start screening.</div>`}
  </section>
  <div class="select-bar" id="select-bar" hidden></div>`;
}

function resumeRowHtml(f) {
  const s = f.last_screening;
  const sel = state.selected.has(f.id);
  return `<tr class="${sel ? "selected" : ""} ${s ? "clickable" : ""}" ${s ? `data-screening="${s.id}"` : ""}>
    <td class="check"><input type="checkbox" data-file="${esc(f.id)}" ${sel ? "checked" : ""} aria-label="Select ${esc(f.name)}"></td>
    <td><div class="file-cell">${fileIcon(f.name)}<div style="min-width:0">
      <div class="primary-text" title="${esc(f.name)}">${esc(f.name)}</div><div class="secondary-text">${bytes(f.size)}</div></div></div></td>
    <td class="nowrap small" title="${addedAt(f) ? esc(new Date(addedAt(f)).toLocaleString()) : ""}">${esc(timeLabel(addedAt(f))) || `<span class="muted">—</span>`}</td>
    <td>${s?.candidate_name ? `<div class="primary-text">${esc(s.candidate_name)}</div><div class="secondary-text">${esc(s.email || "")}</div>` : `<span class="muted">—</span>`}</td>
    <td class="num">${scoreBadge(s?.overall_score)}</td>
    <td>${resultTag(s)}${s?.stage === "done" ? `<div class="secondary-text" title="${esc(s.updated_at || "")}">screened ${esc(when(s.updated_at))}</div>` : ""}</td>
    <td class="row-actions"><button class="btn ghost sm" data-rename="${esc(f.id)}" title="Rename" aria-label="Rename ${esc(f.name)}">${I.edit}</button></td>
  </tr>`;
}

function renderResumeRows() {
  const data = state.folder, tbody = $("#resume-rows");
  if (!tbody) return;

  const counts = { all: data.files.length };
  data.files.forEach(f => { const k = fileStatus(f); counts[k] = (counts[k] || 0) + 1; });
  if (state.list.filter !== "all" && !counts[state.list.filter]) state.list.filter = "all";
  $("#file-filters").innerHTML = FILE_FILTERS.filter(([k]) => k === "all" || counts[k])
    .map(([k, l]) => `<button data-ff="${k}" class="${state.list.filter === k ? "on" : ""}">${l}<span class="c">${counts[k] || 0}</span></button>`).join("");
  $$("[data-ff]").forEach(b => b.addEventListener("click", () => {
    state.list.filter = b.dataset.ff;
    state.list.page = 1;
    renderResumeRows();
  }));

  const rows = visibleFiles();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.list.page = Math.min(state.list.page, pages);
  const start = (state.list.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  const perDay = {};
  rows.forEach(f => { const k = dayKey(addedAt(f)); perDay[k] = (perDay[k] || 0) + 1; });
  let lastDay = null;
  tbody.innerHTML = pageRows.length ? pageRows.map(f => {
    const k = dayKey(addedAt(f)), head = k !== lastDay;
    lastDay = k;
    return (head ? `<tr class="day-row"><td colspan="7">${esc(dayLabel(addedAt(f)))} <span class="muted">· ${plural(perDay[k], "resume")}</span></td></tr>` : "")
      + resumeRowHtml(f);
  }).join("")
    : `<tr><td colspan="7"><div class="empty">No resumes match${state.list.q ? ` "${esc(state.list.q)}"` : ""}.</div></td></tr>`;

  $$("[data-rename]", tbody).forEach(b => b.addEventListener("click", () => {
    const f = data.files.find(x => x.id === b.dataset.rename);
    if (f) renameDialog({ id: f.id, name: f.name, isFolder: false });
  }));
  $$("input[data-file]", tbody).forEach(cb => cb.addEventListener("change", () => {
    cb.checked ? state.selected.add(cb.dataset.file) : state.selected.delete(cb.dataset.file);
    renderResumeRows();
  }));
  bindRows(tbody);

  const onPage = pageRows.filter(f => state.selected.has(f.id)).length;
  const all = $("#select-all");
  all.checked = pageRows.length > 0 && onPage === pageRows.length;
  all.indeterminate = onPage > 0 && onPage < pageRows.length;

  const pager = $("#file-pager");
  pager.hidden = rows.length <= PAGE_SIZE;
  pager.innerHTML = `<span class="muted small">Showing ${rows.length ? start + 1 : 0}–${start + pageRows.length} of ${rows.length}</span>
    <span class="spacer"></span>
    <button class="btn sm" data-pg="prev" ${state.list.page <= 1 ? "disabled" : ""}>Previous</button>
    <span class="small">Page ${state.list.page} of ${pages}</span>
    <button class="btn sm" data-pg="next" ${state.list.page >= pages ? "disabled" : ""}>Next</button>`;
  $$("[data-pg]", pager).forEach(b => b.addEventListener("click", () => {
    state.list.page += b.dataset.pg === "next" ? 1 : -1;
    renderResumeRows();
    $("#resumes-card")?.scrollIntoView({ block: "start" });
  }));

  const today = todaysNew(data).length, hasJd = hasJdText(data), busy = !!state.poll;
  const st = $("#screen-today");
  st.disabled = !today || !hasJd || busy;
  st.innerHTML = `${I.play} ${today ? `Screen today's uploads (${today})` : "Today's uploads all screened"}`;
  st.title = !hasJd ? "Add the job description first" : busy ? "A screening is running" : "";
  $("#rescreen-all").disabled = !hasJd || busy;
  renderSelectBar();
}

function renderSelectBar() {
  const bar = $("#select-bar"), data = state.folder;
  if (!bar) return;
  const n = state.selected.size;
  bar.hidden = !n;
  if (!n) return;
  const busy = !!state.poll, hasJd = hasJdText(data);
  const matching = visibleFiles();
  const more = matching.length > n && !matching.every(f => state.selected.has(f.id));
  bar.innerHTML = `<span class="count">${plural(n, "resume")} selected</span>
    <span class="note">${more ? `<button class="btn link sm" id="sel-matching">Select all ${matching.length}${state.list.filter !== "all" || state.list.q ? " matching" : ""}</button> ` : ""}${
      !hasJd ? "Add the job description to screen." : busy ? "A screening is running in this folder." : ""}</span>
    <button class="btn" id="sel-clear">Clear</button>
    <button class="btn" id="sel-move" ${busy ? "disabled" : ""}>${I.move} Move</button>
    <button class="btn" id="sel-delete" ${busy ? "disabled" : ""}>${I.trash} Delete</button>
    <button class="btn primary" id="sel-run" ${!hasJd || busy ? "disabled" : ""}>${I.play} Screen ${n}</button>`;
  $("#sel-matching")?.addEventListener("click", () => { matching.forEach(f => state.selected.add(f.id)); renderResumeRows(); });
  $("#sel-clear").addEventListener("click", () => { state.selected.clear(); renderResumeRows(); });
  $("#sel-move").addEventListener("click", () => moveDialog(data));
  $("#sel-delete").addEventListener("click", () => deleteFilesDialog(data));
  $("#sel-run").addEventListener("click", () => confirmRun(data));
}

function bindFolderMenu(data) {
  const btn = $("#folder-menu"), list = $("#folder-menu-list");
  if (!btn) return;
  const close = () => { list.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", e => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    btn.setAttribute("aria-expanded", String(!list.hidden));
  });
  $$("[data-act]", list).forEach(item => item.addEventListener("click", () => {
    close();
    if (item.dataset.act === "rename") renameDialog({ id: data.folder.id, name: data.folder.name, isFolder: true });
    else deleteFolderDialog(data);
  }));
}

function bindFolder(view, data) {
  bindRows(view);
  $("#new-folder")?.addEventListener("click", () => newFolderDialog(data));
  $("#fetch-emails")?.addEventListener("click", () => fetchEmails(data));
  if ($("#fetch-emails")) {  // page opened/refreshed while a fetch is already running
    api("/api/fetch-emails/status").then(st => { if (st.running) fetchEmails(data, { attach: true }); }).catch(() => {});
  }
  $("#upload-btn")?.addEventListener("click", () => $("#upload-input").click());
  $("#upload-input")?.addEventListener("change", e => uploadResumes(data, Array.from(e.target.files || [])));
  bindFolderMenu(data);
  $("#add-walkin")?.addEventListener("click", () => walkinDialog(data.role?.id));

  if (data.depth === 0) return bindPositions(view, data);

  $("#jd-open").addEventListener("click", () => jdDialog(data));
  $("#sheet-open")?.addEventListener("click", () => sheetDialog(data));
  if (data.jd?.form_sheet_url) {
    api(`/api/roles/${encodeURIComponent(data.role.id)}/sheet`)
      .then(sh => { if ($("#sheet-tag")) $("#sheet-tag").innerHTML = sheetStatusHtml(sh); })
      .catch(() => {});
  }

  if (!$("#resume-rows")) return;
  $("#select-all").addEventListener("change", e => {
    const rows = visibleFiles().slice((state.list.page - 1) * PAGE_SIZE, state.list.page * PAGE_SIZE);
    rows.forEach(f => e.target.checked ? state.selected.add(f.id) : state.selected.delete(f.id));
    renderResumeRows();
  });
  $("#screen-today").addEventListener("click", () => {
    const ids = todaysNew(data).map(f => f.id);
    if (ids.length) confirmRun(data, { ids, title: `Screen today's ${plural(ids.length, "upload")}?`,
      note: "Only resumes added today that haven't been screened yet. Earlier resumes are left as they are." });
  });
  $("#rescreen-all").addEventListener("click", () => confirmRun(data, {
    ids: data.files.map(f => f.id), rescreen: true, title: `Re-screen all ${plural(data.files.length, "resume")}?`,
    note: `<b>Every</b> resume in this folder is scored again, including ones already scored. Use it after changing
      the job description: resumes already scored against the current JD just reuse their result (no OpenAI cost).` }));
  let timer;
  $("#file-q").addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.list.q = e.target.value.trim(); state.list.page = 1; renderResumeRows(); }, 200);
  });
  $("#stop-btn")?.addEventListener("click", () => stopScreening(data.active_run_id));
  renderResumeRows();
}

async function stopScreening(runId) {
  const btn = $("#stop-btn");
  if (!runId || !btn) return;
  btn.disabled = true;
  btn.textContent = "Stopping…";
  try {
    await api(`/api/runs/${runId}`, { method: "DELETE" });
    toast("Stopping screening");
  } catch (e) {
    toast(e.message, "error");
    btn.disabled = false;
    btn.textContent = "Stop screening";
  }
}

/* ---------------------------------------------------------------- create & upload */

function todayLabel() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function newFolderDialog(data) {
  const isDate = data.depth === 1;
  const kind = isDate ? "date folder" : "position";
  openModal(`
    <h2>New ${kind}</h2>
    <p>${isDate ? `Creates a folder inside <b>${esc(data.folder.name)}</b> in WorkDrive.` : "Creates a position folder in WorkDrive."}</p>
    <div class="field"><input type="text" id="folder-name" maxlength="100"
      placeholder="${isDate ? "e.g. 17 Sep" : "e.g. Full Stack"}" value="${isDate ? esc(todayLabel()) : ""}"></div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="create-folder">Create</button>
    </div>`);
  const input = $("#folder-name");
  input.focus();
  input.select();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    $("#create-folder").disabled = true;
    try {
      const folder = await api("/api/folders", { method: "POST", body: { parent_id: data.folder.id, name } });
      closeModal();
      toast(`Created "${folder.name}"`);
      location.hash = `#/folder/${folder.id}`;
    } catch (e) {
      toast(e.message, "error");
      $("#create-folder").disabled = false;
    }
  };
  $("#create-folder").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

let fetchPoll = null;

function fetchLabel(st) {
  if (st.phase === "scanning") return "Reading emails…";
  return st.total ? `Fetching ${st.done}/${st.total}…` : "Fetching…";
}

// Starts (or re-attaches to) the background email fetch and shows live progress.
async function fetchEmails(data, { attach = false } = {}) {
  const btn = $("#fetch-emails");
  if (!btn || fetchPoll) return;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Reading emails…`;
  const done = () => { clearInterval(fetchPoll); fetchPoll = null; };
  const reset = () => { const b = $("#fetch-emails"); if (b) { b.disabled = false; b.textContent = "Fetch from email"; } };
  let st;
  try {
    st = attach ? await api("/api/fetch-emails/status") : await api("/api/fetch-emails", { method: "POST" });
  } catch (e) { toast(e.message, "error"); return reset(); }
  fetchPoll = true;
  let misses = 0, sawRunning = true, skip = 0;
  const tick = async () => {
    if (skip > 0) { skip--; return; }  // back off while the server is failing, so we don't add to its load
    try { st = await api("/api/fetch-emails/status"); misses = 0; }
    catch {
      // Server unreachable (restarting / overloaded). Wait longer after each miss; give up after ~2 min.
      misses++;
      if (misses >= 8) {
        done(); reset();
        return toast("Lost connection to the server. It may have run out of memory and restarted. Resumes already fetched are saved - click Fetch again to continue.", "error");
      }
      skip = Math.min(2 ** misses, 20);  // ticks to skip (1.5s each): 2, 4, 8, 16, 20...
      return;
    }
    const b = $("#fetch-emails");
    if (st.running) { sawRunning = true; if (b) b.innerHTML = `<span class="spinner"></span> ${fetchLabel(st)}`; return; }
    done();
    const results = Array.isArray(st.results) ? st.results : [];
    if (st.error) toast(st.error, "error");
    else if (sawRunning && !st.total && !results.length && st.phase === "idle")
      toast("The server restarted during the fetch. Resumes already fetched are saved - click Fetch again to continue.", "error");
    else if (!st.total) toast("No new application emails.");
    else toast(`Fetched ${st.saved} of ${st.total} resumes${st.failed ? ` · ${st.failed} failed` : ""}`, st.failed ? "error" : "info");
    results.filter(r => !r.ok).slice(0, 5).forEach(r => toast(`${r.candidate || r.subject}: ${r.error}`, "error"));
    const queued = results.filter(r => r.ok).length;
    if (queued) {
      const noEmail = results.filter(r => r.ok && !r.invite_email).length;
      toast(`${plural(queued, "applicant")} added to Form invites${noEmail ? ` (${noEmail} without an email - add it there)` : ""}. Review and send the Google Form from the Form invites page.`, "success");
      loadInviteBadge();
    }
    reset();
    if (["#/", "", "#/files"].includes(location.hash) || /^#\/(home|applicants)/.test(location.hash)) route();
    loadApplicantsBadge();
  };
  fetchPoll = setInterval(tick, 1500);
  tick();
}

/* Uploads go in small batches: one short request per few files keeps the
   server responsive and memory flat, even for 200 resumes at once. */
const UPLOAD_BATCH = 5;

async function uploadResumes(data, files) {
  $("#upload-input").value = "";
  if (!files.length) return;
  const btn = $("#upload-btn");
  btn.disabled = true;
  const results = [];
  for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
    const chunk = files.slice(i, i + UPLOAD_BATCH);
    btn.innerHTML = `<span class="spinner"></span> Uploading ${Math.min(i + chunk.length, files.length)} of ${files.length}…`;
    const form = new FormData();
    chunk.forEach(f => form.append("files", f, f.name));
    let res = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try { res = await api(`/api/folders/${encodeURIComponent(data.folder.id)}/upload`, { method: "POST", body: form }); }
      catch (e) {
        if (attempt === 2) chunk.forEach(f => results.push({ name: f.name, ok: false, error: `${f.name}: ${e.message}` }));
        else await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (res) results.push(...res.results);
  }
  const ok = results.filter(r => r.ok);
  if (ok.length) toast(`Uploaded ${plural(ok.length, "resume")}`, "success");
  results.filter(r => !r.ok).slice(0, 6).forEach(r => toast(r.error, "error"));
  if (results.length - ok.length > 6) toast(`${results.length - ok.length} uploads failed in total`, "error");
  await renderFolder($("#view"), data.folder.id, { quiet: true });
  // Tick the new uploads so they're ready to screen.
  ok.filter(r => r.id).forEach(r => state.selected.add(r.id));
  renderResumeRows();
}

/* ---------------------------------------------------------------- walk-ins */

async function walkinDialog(roleId) {
  openModal(`<h2>Add walk-in candidate</h2><div class="loading-block" style="padding:30px 0"><span class="spinner"></span> Loading positions…</div>`);
  let roles;
  try { roles = (await api("/api/roles")).roles; } catch (e) { closeModal(); return toast(e.message, "error"); }
  if (!roles.length) { closeModal(); return toast("Create a position first.", "error"); }
  openModal(`
    <h2>Add walk-in candidate</h2>
    <p class="muted small">Scored against the position's job description using the resume and your notes. No Google Form check.
      Walk-ins stay in the app - they're not sent to Zoho Recruit.</p>
    <div class="form-grid">
      <div class="field span-2"><label for="wi-role">Position</label>
        <select id="wi-role">${roles.map(r => `<option value="${esc(r.id)}" ${r.id === roleId ? "selected" : ""}>${esc(r.name)}${r.has_jd ? "" : " (no JD yet)"}</option>`).join("")}</select></div>
      <div class="field"><label for="wi-name">Name *</label><input type="text" id="wi-name" maxlength="80" autocomplete="off"></div>
      <div class="field"><label for="wi-phone">Phone *</label><input type="text" id="wi-phone" inputmode="tel" maxlength="20" autocomplete="off"></div>
      <div class="field span-2"><label for="wi-email">Email</label><input type="text" id="wi-email" inputmode="email" maxlength="120" autocomplete="off"></div>
      <div class="field span-2"><label for="wi-files">Resume *</label>
        <input type="file" id="wi-files" accept=".pdf,.docx,image/*" multiple>
        <div class="help">One PDF / DOCX file, or photos of a printed resume (one photo per page - on a phone you can use the camera).
          Photos and scanned PDFs are read with AI.</div>
        <div class="small" id="wi-picked"></div></div>
      <div class="field span-2"><label for="wi-notes">HR notes</label>
        <textarea id="wi-notes" class="short" maxlength="3000" placeholder="Interview impressions, notice period, expected salary, availability…"></textarea></div>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="wi-save">Add & score</button>
    </div>`, { wide: true });
  $("#wi-name").focus();
  $("#wi-files").addEventListener("change", e => {
    const f = Array.from(e.target.files || []);
    $("#wi-picked").textContent = f.length ? f.map(x => x.name).join(", ") : "";
  });
  $("#wi-save").addEventListener("click", async () => {
    const name = $("#wi-name").value.trim(), phone = $("#wi-phone").value.trim(), email = $("#wi-email").value.trim();
    const files = Array.from($("#wi-files").files || []);
    if (!name) return $("#wi-name").focus();
    if (!phone && !email) { toast("Enter a phone number or an email.", "error"); return $("#wi-phone").focus(); }
    if (!files.length) return toast("Add the resume file or photos.", "error");
    const form = new FormData();
    form.append("role_id", $("#wi-role").value);
    form.append("name", name);
    form.append("phone", phone);
    form.append("email", email);
    form.append("notes", $("#wi-notes").value.trim());
    files.forEach(f => form.append("files", f, f.name));
    const btn = $("#wi-save");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Uploading…`;
    try {
      const res = await api("/api/walkins", { method: "POST", body: form });
      closeModal();
      if (res.warning) toast(res.warning, "error");
      else toast(`${name} added - scoring now`, "success");
      location.hash = `#/applicant/${encodeURIComponent(res.file_id)}`;
    } catch (e) { toast(e.message, "error"); btn.disabled = false; btn.textContent = "Add & score"; }
  });
}

/* ---------------------------------------------------------------- rename / move / delete */

/* ---- Google Form response sheet: one link per position. Set it on the
   position page (card below the JD) or for every position on #/sheets. */

const SHEET_HELP = `In the Google Form open <b>Responses → View in Sheets</b>, copy that sheet's link, and in the sheet set
  <b>Share → General access → Anyone with the link (Viewer)</b>.`;

function sheetStatusHtml(sh) {
  if (!sh) return `<span class="muted small"><span class="spinner"></span> Checking…</span>`;
  if (!sh.linked) return `<span class="tag warn">Not linked</span>`;
  if (!sh.ok) return `<span class="tag bad" title="${esc(sh.error)}">Can't read</span>`;
  return `<span class="tag good" title="Matching on ${esc([sh.email_column, sh.phone_column].filter(Boolean).join(" / "))}">✓ ${plural(sh.responses, "response")}</span>`;
}

function sheetDetail(sh) {
  if (!sh || !sh.linked) return "";
  if (!sh.ok) return `<span style="color:var(--bad)">${esc(sh.error)}</span>`;
  return `Matching resumes on ${[sh.email_column, sh.phone_column].filter(Boolean).map(c => `"${esc(c)}"`).join(" or ")}.`;
}

async function saveSheet(roleId, url) {
  const sh = await api(`/api/roles/${encodeURIComponent(roleId)}/sheet`, { method: "PUT", body: { form_sheet_url: url } });
  toast(url ? `Google Form sheet linked - ${plural(sh.responses, "response")} found` : "Google Form sheet removed", "success");
  return sh;
}

async function renderSheets(view) {
  loading(view);
  let data;
  try { data = await api("/api/roles"); } catch (e) { return errorView(view, e.message); }
  view.innerHTML = `
    <div class="page-head"><div><h1>Form sheets</h1>
      <div class="sub">Per position: the Google Form applicants are invited to fill, and its response sheet. Resumes are matched to responses by email or phone before scoring.</div></div></div>
    <div class="stack">
      <div class="callout info">${I.warn}<div>${SHEET_HELP}</div></div>
      <section class="card">${data.roles.length ? `<div class="table-wrap"><table class="sheets-table">
        <thead><tr><th>Position</th><th>Google Form link (sent to applicants)</th><th>Response sheet link</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.roles.map(r => `<tr data-role="${esc(r.id)}">
          <td><a href="#/folder/${esc(r.id)}"><b>${esc(r.name)}</b></a>${r.has_jd ? "" : `<div class="secondary-text">no job description yet</div>`}</td>
          <td><div class="form-link-cell">${r.form_url
              ? `<a href="${esc(safeUrl(r.form_url) || "#")}" target="_blank" rel="noopener noreferrer" class="small" title="${esc(r.form_url)}">${esc(r.form_url.replace(/^https:\/\//, "").slice(0, 38))}…</a>`
              : `<span class="tag warn">Not set</span>`}
            <button class="btn sm invite-edit">${r.form_url ? "Edit link & email" : "Add form link"}</button></div></td>
          <td><input type="text" class="sheet-input" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(r.form_sheet_url)}"></td>
          <td class="sheet-status nowrap">${r.form_sheet_url ? sheetStatusHtml(null) : sheetStatusHtml({ linked: false })}</td>
          <td class="nowrap"><button class="btn sm primary sheet-save">Save</button>
            ${r.form_sheet_url ? `<a class="btn sm" href="${esc(safeUrl(r.form_sheet_url) || "#")}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">${I.inbox}<strong>No positions yet</strong>Create position folders on the Resumes page first.</div>`}
      </section>
    </div>`;

  for (const row of $$("tr[data-role]", view)) {
    const id = row.dataset.role, input = $(".sheet-input", row), status = $(".sheet-status", row), btn = $(".sheet-save", row);
    const role = data.roles.find(r => r.id === id);
    const save = async () => {
      const url = input.value.trim();
      if (url === role.form_sheet_url) return toast("No change");
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      try {
        const sh = await saveSheet(id, url);
        role.form_sheet_url = url;
        status.innerHTML = sheetStatusHtml(sh);
      } catch (e) { toast(`${role.name}: ${e.message}`, "error"); }
      btn.disabled = false;
      btn.textContent = "Save";
    };
    btn.addEventListener("click", save);
    input.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    $(".invite-edit", row).addEventListener("click", () => inviteDialog(role, () => renderSheets(view)));
    if (role.form_sheet_url) {
      api(`/api/roles/${encodeURIComponent(id)}/sheet`)
        .then(sh => { status.innerHTML = sheetStatusHtml(sh); status.title = sh.ok ? "" : sh.error || ""; })
        .catch(() => { status.innerHTML = ""; });
    }
  }
}

function renameDialog(item) {
  const ext = item.isFolder ? "" : (item.name.match(/\.[^.]+$/) || [""])[0];
  const base = ext ? item.name.slice(0, -ext.length) : item.name;
  openModal(`
    <h2>Rename ${item.isFolder ? "folder" : "resume"}</h2>
    <div class="field"><div style="display:flex;align-items:center;gap:6px">
      <input type="text" id="rename-input" maxlength="150" value="${esc(base)}">${ext ? `<span class="muted">${esc(ext)}</span>` : ""}
    </div></div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="rename-go">Rename</button>
    </div>`);
  const input = $("#rename-input");
  input.focus();
  input.select();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    $("#rename-go").disabled = true;
    try {
      const out = await api(`/api/items/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { name: name + ext } });
      closeModal();
      toast(`Renamed to "${out.name}"`, "success");
      renderFolder($("#view"), state.folder.folder.id, { quiet: true });
    } catch (e) { toast(e.message, "error"); $("#rename-go").disabled = false; }
  };
  $("#rename-go").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

async function moveDialog(data) {
  const ids = data.files.filter(f => state.selected.has(f.id)).map(f => f.id);
  if (!ids.length) return;
  openModal(`<h2>Move ${plural(ids.length, "resume")}</h2><div class="loading-block" style="padding:30px 0"><span class="spinner"></span> Loading folders…</div>`);
  let tree;
  try { tree = (await api("/api/folders/tree")).roles; }
  catch (e) { closeModal(); return toast(e.message, "error"); }
  const opt = (id, label) => `<option value="${esc(id)}" ${id === data.folder.id ? "disabled" : ""}>${label}${id === data.folder.id ? " (current)" : ""}</option>`;
  openModal(`
    <h2>Move ${plural(ids.length, "resume")}</h2>
    <p>Choose the position or date folder to move ${ids.length === 1 ? "it" : "them"} to.</p>
    <div class="field"><select id="move-dest" size="10" style="height:auto">
      ${tree.map(r => `<optgroup label="${esc(r.name)}">${opt(r.id, esc(r.name))}${r.children.map(c => opt(c.id, `&nbsp;&nbsp;${esc(r.name)} / ${esc(c.name)}`)).join("")}</optgroup>`).join("")}
    </select></div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="move-go" disabled>Move</button>
    </div>`);
  $("#move-dest").addEventListener("change", () => { $("#move-go").disabled = !$("#move-dest").value; });
  $("#move-go").addEventListener("click", async () => {
    $("#move-go").disabled = true;
    $("#move-go").innerHTML = `<span class="spinner"></span> Moving…`;
    try {
      const res = await api("/api/files/move", { method: "POST", body: { file_ids: ids, dest_folder_id: $("#move-dest").value } });
      closeModal();
      if (res.moved) toast(`Moved ${plural(res.moved, "resume")}`, "success");
      res.results.filter(r => !r.ok).slice(0, 5).forEach(r => toast(r.error, "error"));
      state.selected.clear();
      renderFolder($("#view"), data.folder.id, { quiet: true });
    } catch (e) { toast(e.message, "error"); $("#move-go").disabled = false; $("#move-go").textContent = "Move"; }
  });
}

function deleteFilesDialog(data) {
  const files = data.files.filter(f => state.selected.has(f.id));
  if (!files.length) return;
  openModal(`
    <h2>Delete ${plural(files.length, "resume")}?</h2>
    <p>${files.length === 1 ? `<b>${esc(files[0].name)}</b> moves` : "They move"} to the WorkDrive trash, where ${files.length === 1 ? "it" : "they"} can be restored for 30 days.</p>
    ${files.length > 1 ? `<ul>${files.slice(0, 8).map(f => `<li>${esc(f.name)}</li>`).join("")}${files.length > 8 ? `<li>…and ${files.length - 8} more</li>` : ""}</ul>` : ""}
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" id="delete-go">Delete</button>
    </div>`);
  $("#delete-go").addEventListener("click", async () => {
    $("#delete-go").disabled = true;
    $("#delete-go").innerHTML = `<span class="spinner"></span> Deleting…`;
    try {
      const res = await api("/api/files/delete", { method: "POST", body: { file_ids: files.map(f => f.id) } });
      closeModal();
      if (res.deleted) toast(`Moved ${plural(res.deleted, "resume")} to WorkDrive trash`, "success");
      res.results.filter(r => !r.ok).slice(0, 5).forEach(r => toast(r.error, "error"));
      state.selected.clear();
      renderFolder($("#view"), data.folder.id, { quiet: true });
    } catch (e) { toast(e.message, "error"); $("#delete-go").disabled = false; $("#delete-go").textContent = "Delete"; }
  });
}

function deleteFolderDialog(data, after) {
  const f = data.folder;
  const inside = data.files.length + data.subfolders.reduce((n, s) => n + (s.resume_count || 0), 0);
  openModal(`
    <h2>Delete folder "${esc(f.name)}"?</h2>
    <p>The folder${inside ? ` and the <b>${plural(inside, "resume")}</b> in it` : ""}${data.subfolders.length ? ` (including ${plural(data.subfolders.length, "subfolder")})` : ""} move to the WorkDrive trash, restorable for 30 days.</p>
    <p class="muted small">Applicants whose resumes are in it are removed from the app's lists${data.depth <= 1 ? ", together with this position's job description and form choice" : ""}. Screening history stays in Activity.</p>
    <div class="field"><label for="delete-confirm">Type the folder name to confirm</label>
      <input type="text" id="delete-confirm" autocomplete="off" placeholder="${esc(f.name)}"></div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" id="delete-go" disabled>Delete folder</button>
    </div>`);
  const input = $("#delete-confirm");
  input.focus();
  input.addEventListener("input", () => { $("#delete-go").disabled = input.value.trim() !== f.name.trim(); });
  $("#delete-go").addEventListener("click", async () => {
    $("#delete-go").disabled = true;
    try {
      const out = await api(`/api/folders/${encodeURIComponent(f.id)}`, { method: "DELETE" });
      closeModal();
      toast(`"${f.name}" moved to WorkDrive trash${out.removed ? ` · ${plural(out.removed, "applicant")} removed from the app` : ""}`, "success");
      state.browse?.clear?.();
      loadApplicantsBadge();
      if (after) return after(out);
      location.hash = data.depth <= 1 ? "#/files" : `#/folder/${out.parent_id}`;
    } catch (e) { toast(e.message, "error"); $("#delete-go").disabled = false; }
  });
}

/* ---------------------------------------------------------------- run */

function confirmRun(data, opts = {}) {
  const ids = opts.ids || data.files.filter(f => state.selected.has(f.id)).map(f => f.id);
  if (!ids.length) return;
  const form = !!data.jd.form_sheet_url && !isWalkinFolder(data.folder);
  const pending = esc(`${data.role.name} / ${state.status?.form_pending_folder || "Form Pending"}`);
  openModal(`
    <h2>${opts.title || `Screen ${plural(ids.length, "resume")}?`}</h2>
    ${opts.note ? `<p>${opts.note}</p>` : ""}
    ${form ? `<p>Each resume is matched to its Google Form response by email or phone. <b>No response yet</b> → moved to <b>${pending}</b> without scoring.</p>` : ""}
    ${isWalkinFolder(data.folder) ? `<p>Walk-ins are scored on resume + HR notes and <b>stay in the app</b> - nothing goes to Recruit or is deleted.</p>`
      : `<p><b>High</b> and <b>Medium</b> candidates are saved to Zoho Recruit${canDelete() ? " and <b>permanently removed from WorkDrive</b>" : ""}. <b>Low</b> stay in WorkDrive.</p>`}
    <p class="muted small">${bandsLine()}</p>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="confirm-run">Start</button>
    </div>`);
  $("#confirm-run").addEventListener("click", async () => {
    $("#confirm-run").disabled = true;
    try {
      const body = opts.rescreen ? { folder_id: data.folder.id, rescreen: true } : { folder_id: data.folder.id, file_ids: ids };
      const { run_id } = await api("/api/runs", { method: "POST", body });
      closeModal();
      state.selected.clear();
      startPolling(run_id, data.folder.id);
      renderResumeRows();
    } catch (e) { closeModal(); toast(e.message, "error"); }
  });
}

function startPolling(runId, folderId) {
  if (state.poll && state.poll.runId === runId) return;
  stopPolling();
  state.poll = { runId, folderId, timer: null, announced: new Set(), seeded: false };
  pollOnce();
}

function stopPolling() {
  if (state.poll?.timer) clearTimeout(state.poll.timer);
  state.poll = null;
}

async function pollOnce() {
  const p = state.poll;
  if (!p) return;
  let data;
  try { data = await api(`/api/runs/${p.runId}?after_event=999999999`); }
  catch { if (state.poll === p) p.timer = setTimeout(pollOnce, 4000); return; }
  if (state.poll !== p) return;

  const r = data.run;
  announceFinished(p, data.screenings || []);
  const here = () => state.folder && state.folder.folder.id === p.folderId && $("#live-run");
  if (r.status === "running" || r.status === "cancelling") {
    if (here()) {
      const pct = r.total ? Math.round((r.processed / r.total) * 100) : 0;
      const elapsed = Date.now() - new Date(r.started_at).getTime();
      const left = r.processed && r.total > r.processed ? (elapsed / r.processed) * (r.total - r.processed) : null;
      $("#live-run").innerHTML = `<section class="card run-live"><div class="card-body" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;gap:10px"><b><span class="spinner"></span>&nbsp; ${r.status === "cancelling" ? "Stopping screening" : `Screening ${r.processed} of ${r.total}`}</b>
        <span class="muted">${r.passed} to Recruit · ${r.form_pending || 0} waiting for form · ${secs(elapsed)} elapsed${left ? ` · about ${secs(left)} left` : ""}</span></div>
        <div class="progress"><span style="width:${pct}%"></span></div></div></section>`;
    }
    p.timer = setTimeout(pollOnce, 1500);
    return;
  }
  stopPolling();
  if (r.status === "failed") toast(`Screening failed: ${r.error || "see Activity log"}`, "error");
  if (r.status === "cancelled") toast("Screening stopped", "error");
  showRunResults(r, data.screenings || []);
  if (here()) {
    await renderFolder($("#view"), p.folderId, { quiet: true });
    $("#live-run").innerHTML = "";
  }
}

/* One toast per resume as it finishes. Resumes already done when polling
   starts (e.g. page reloaded mid-run) are marked seen without a toast. */
function announceFinished(p, screenings) {
  for (const s of screenings) {
    if (s.stage !== "done" || p.announced.has(s.id)) continue;
    p.announced.add(s.id);
    if (p.seeded && s.outcome === "walkin") toast(`Walk-in ${s.candidate_name || s.filename}: ${bandOf(s.overall_score)} (${Math.round(s.overall_score)})`, "success");
    if (!p.seeded || s.outcome !== "passed") continue;
    const who = `${s.candidate_name || s.filename} is ${bandOf(s.overall_score)} (${Math.round(s.overall_score)})`;
    if (s.recruit_status === "saved") toast(s.recruit_action === "update"
      ? `✓ ${who} - already in Zoho Recruit, their record was updated`
      : `✓ ${who} and was added to Zoho Recruit as a new candidate`, "success");
    else toast(`${who} but was NOT saved to Zoho Recruit - ${s.recruit_error || "see Activity log"}`, "error");
  }
  p.seeded = true;
}

function resultRowHtml(s) {
  const tags = [];
  let note = "";
  if (s.outcome === "failed") { tags.push(`<span class="tag bad">Failed</span>`); note = s.error; }
  else if (s.outcome === "form_pending") { tags.push(`<span class="tag warn">Waiting for Google Form</span>`); note = s.workdrive_reason; }
  else if (s.outcome === "walkin") tags.push(`<span class="tag blue">Walk-in · kept in the app, not sent to Recruit</span>`);
  else if (s.outcome === "rejected") tags.push(`<span class="tag">Low - stays in WorkDrive</span>`);
  else if (s.outcome === "passed") {
    if (s.recruit_status === "saved") tags.push(s.recruit_action === "update"
      ? `<span class="tag good" title="A candidate with this email was already in Recruit - their record was updated">Updated existing candidate in Recruit</span>`
      : `<span class="tag good">New candidate in Recruit</span>`);
    else { tags.push(`<span class="tag bad">Not saved to Recruit</span>`); note = s.recruit_error; }
    if (s.workdrive_action === "deleted") tags.push(`<span class="tag blue">Removed from WorkDrive</span>`);
    else if (s.recruit_status === "saved") tags.push(`<span class="tag warn" title="${esc(s.workdrive_reason || "")}">Still in WorkDrive</span>`);
  }
  const open = s.overall_score != null;
  return `<li class="${open ? "clickable" : ""}" ${open ? `data-result="${s.id}"` : ""}>
    ${scoreBadge(s.overall_score)}
    <div class="rr-main"><div class="primary-text">${esc(s.candidate_name || s.filename)}</div>
      <div class="secondary-text">${esc(s.candidate_name ? s.filename : s.email || "")}</div>
      <div class="chips">${tags.join("")}</div>
      ${note ? `<div class="rr-note ${s.outcome === "form_pending" ? "muted" : ""}">${esc(note)}</div>` : ""}</div></li>`;
}

function showRunResults(r, screenings) {
  const saved = screenings.filter(s => s.outcome === "passed" && s.recruit_status === "saved").length;
  const unsaved = r.passed - saved;
  const walkins = screenings.filter(s => s.outcome === "walkin");
  const title = walkins.length && walkins.length === screenings.length
    ? (walkins.length === 1 ? `Walk-in scored: ${bandOf(walkins[0].overall_score)}` : `${plural(walkins.length, "walk-in")} scored`)
    : ["failed", "cancelled"].includes(r.status) ? "Screening stopped"
    : r.passed ? `${plural(r.passed, "High / Medium candidate")}` : "No High or Medium candidates";
  const summary = [
    r.passed ? `${saved} saved to Zoho Recruit${unsaved ? `, <b>${unsaved} not saved</b>` : ""}` : "",
    r.form_pending ? `<b>${r.form_pending} waiting for the Google Form</b> (moved to ${esc(state.status?.form_pending_folder || "Form Pending")})` : "",
    r.rejected ? `${r.rejected} Low` : "",
    r.failed ? `${r.failed} could not be screened` : "",
    between(r.started_at, r.finished_at) ? `took ${between(r.started_at, r.finished_at)}` : "",
  ].filter(Boolean).join(" · ");
  const order = { passed: 0, walkin: 0, failed: 1, form_pending: 2, rejected: 3 };
  const rows = [...screenings].sort((a, b) => (order[a.outcome] ?? 3) - (order[b.outcome] ?? 3) || (b.overall_score ?? -1) - (a.overall_score ?? -1));
  openModal(`
    <h2>${r.passed && !unsaved ? "✓ " : ""}${esc(title)}</h2>
    <p>${summary}</p>
    <ul class="run-results">${rows.map(resultRowHtml).join("")}</ul>
    <div class="modal-actions">
      <a class="btn" href="#/run/${r.id}" data-close>Activity log</a>
      <button class="btn primary" data-close>OK</button>
    </div>`);
  $$("#modal [data-result]").forEach(el => el.addEventListener("click", () => {
    closeModal();
    openScreening(Number(el.dataset.result));
  }));
}

/* ---------------------------------------------------------------- dashboard */

function tile(label, value, note, cls) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value ${cls || ""}">${esc(String(value))}</div>
    <div class="tile-note">${note || ""}</div></div>`;
}

async function renderDashboard(view) {
  loading(view);
  let d;
  try { d = await api("/api/dashboard"); } catch (e) { return errorView(view, e.message); }
  const t = d.totals;
  const notSaved = Math.max(0, t.passed - t.in_recruit);
  const pct = (n, of) => of ? `${Math.round((n / of) * 100)}% of screened` : "";

  view.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1>
      <div class="sub">Every resume the screener has parsed, counted once per file.</div></div></div>
    <div class="stack">
      ${appsCardShell()}
      <div class="tiles">
        ${tile("Resumes parsed", t.screened, "across all positions")}
        ${tile("High", t.band_high, pct(t.band_high, t.screened), "good")}
        ${tile("Medium", t.band_medium, pct(t.band_medium, t.screened), "mid")}
        ${tile("Low", t.band_low, pct(t.band_low, t.screened))}
        ${tile("Walk-ins", t.walkins, t.walkins ? `<a href="#/candidates" onclick="state.cand.filter='walkin'">see them</a> · app only` : "added by HR, app only")}
        ${tile("Waiting for Google Form", t.form_pending, t.form_pending ? `<a href="#/pending">see who</a>` : "everyone has filled it", t.form_pending ? "mid" : "")}
        ${tile("Could not be read", t.failed, t.failed ? "scanned PDFs or download errors" : "", t.failed ? "bad" : "")}
        ${tile("Saved to Zoho Recruit", t.in_recruit, t.passed ? `of ${plural(t.passed, "High / Medium resume")}` : "", "good")}
        ${tile("High / Medium, not in Recruit", notSaved, notSaved ? "see the list below" : "nothing pending", notSaved ? "bad" : "")}
        ${tile("Average score", t.avg_score ?? "—", t.avg_score != null ? `average band: ${bandOf(t.avg_score)}` : "")}
        ${tile("Average time per resume", t.avg_seconds ? `${t.avg_seconds}s` : "—", t.total_seconds ? `${secs(t.total_seconds * 1000)} of screening time` : "measured from this version on")}
      </div>

      <section class="card"><div class="card-head"><h2>By position</h2></div>
        ${d.roles.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Position</th><th class="num">Parsed</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th>
            <th class="num">Waiting for form</th><th class="num">In Recruit</th><th>To Recruit</th><th>Last activity</th></tr></thead>
          <tbody>${d.roles.map(r => {
            const rate = r.screened ? Math.round((r.passed / r.screened) * 100) : 0;
            return `<tr><td><b>${esc(r.role_name)}</b></td>
              <td class="num">${r.screened}</td><td class="num">${r.band_high}</td><td class="num">${r.band_medium}</td>
              <td class="num">${r.band_low}</td><td class="num">${r.form_pending}</td><td class="num">${r.in_recruit}</td>
              <td><div class="bar" title="${rate}% High or Medium"><span style="width:${rate}%"></span></div>
                <span class="muted small">${rate}%</span></td>
              <td class="muted small nowrap">${when(r.last_activity)}</td></tr>`;
          }).join("")}</tbody></table></div>` : `<div class="empty">Nothing screened yet.</div>`}
      </section>

      <section class="card"><div class="card-head"><h2>High / Medium but not in Zoho Recruit</h2></div>
        ${d.not_in_recruit.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Candidate</th><th>Position</th><th class="num">Band</th><th>Why not</th><th>Screened</th></tr></thead>
          <tbody>${d.not_in_recruit.map(c => `<tr class="clickable" data-screening="${c.id}">
            <td><div class="primary-text">${esc(c.candidate_name || c.filename)}</div><div class="secondary-text">${esc(c.email || c.filename)}</div></td>
            <td>${esc(c.role_name)}</td><td class="num">${scoreBadge(c.overall_score)}</td>
            <td class="wrap">${esc(c.recruit_error || "The Recruit push did not finish - see the Activity log")}</td>
            <td class="muted small nowrap">${when(c.updated_at)}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="empty">${I.inbox}<strong>Every High and Medium resume reached Recruit</strong></div>`}
      </section>

      <section class="card"><div class="card-head"><h2>Recent runs</h2></div>
        ${d.recent_runs.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Folder</th><th>Started</th><th class="num">Resumes</th><th class="num">To Recruit</th><th class="num">Took</th><th>Status</th></tr></thead>
          <tbody>${d.recent_runs.map(r => `<tr class="clickable" data-href="#/run/${r.id}">
            <td><b>${esc(r.folder_path.split(" / ").slice(1).join(" / "))}</b></td>
            <td class="muted nowrap">${when(r.started_at)}</td>
            <td class="num">${r.total}</td><td class="num">${r.passed}</td>
            <td class="num muted small nowrap">${esc(between(r.started_at, r.finished_at))}</td>
            <td>${runStatusTag(r)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No runs yet.</div>`}
      </section>
    </div>`;
  bindRows(view);
  loadActivity();
}

/* ---------------------------------------------------------------- applications by date (dashboard) */

const ACT_RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
const ACT_SERIES = [
  { key: "resumes", label: "Resumes received", color: "var(--series-1)" },
  { key: "responses", label: "Form responses", color: "var(--series-2)" },
];

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const shortDay = s => parseDay(s).toLocaleDateString([], { day: "numeric", month: "short" });
const longDay = s => parseDay(s).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function appsCardShell() {
  return `<section class="card apps-card" id="apps-card" aria-busy="true">
    <div class="card-head"><div><h2>Applications by date</h2>
      <div class="hint">Resumes received and Google Form responses per day.</div></div></div>
    <div class="card-body"><div class="apps-stats">${`<div class="apps-stat"><span class="sk sk-line w40"></span><span class="sk sk-num"></span></div>`.repeat(4)}</div>
      <div class="sk" style="height:220px;margin-top:18px"></div></div>
  </section>`;
}

async function loadActivity() {
  const card = $("#apps-card");
  if (!card) return;
  try { state.act.data = await api("/api/activity"); }
  catch (e) {
    card.removeAttribute("aria-busy");
    card.querySelector(".card-body").innerHTML = `<div class="empty">${I.warn}<strong>Couldn't load applications</strong>${esc(e.message)}</div>`;
    return;
  }
  if (!$("#apps-card")) return;  // left the dashboard meanwhile
  renderActivity();
}

/* Daily totals for the chosen range and position, zero-filled so quiet days still show. */
function activitySeries() {
  const d = state.act.data, role = state.act.role;
  const rows = d.rows.filter(r => !role || r.role_id === role);
  const byDay = new Map();
  for (const r of rows) {
    const b = byDay.get(r.date) || { date: r.date, resumes: 0, responses: 0, email: 0, walkin: 0, upload: 0 };
    for (const k of ["resumes", "responses", "email", "walkin", "upload"]) b[k] += r[k];
    byDay.set(r.date, b);
  }
  const today = parseDay(d.today);
  let start;
  if (state.act.range === "all") {
    const first = [...byDay.keys()].sort()[0];
    start = first ? parseDay(first) : new Date(today);
  } else {
    start = new Date(today); start.setDate(start.getDate() - Number(state.act.range) + 1);
  }
  const days = [];
  for (const t = new Date(start); t <= today; t.setDate(t.getDate() + 1)) {
    const k = isoDay(t);
    days.push(byDay.get(k) || { date: k, resumes: 0, responses: 0, email: 0, walkin: 0, upload: 0 });
  }
  return { days, byDay, rows };
}

function renderActivity() {
  const card = $("#apps-card");
  const d = state.act.data;
  if (!card || !d) return;
  card.removeAttribute("aria-busy");
  const { days, byDay, rows } = activitySeries();
  const sum = k => days.reduce((n, x) => n + x[k], 0);
  const busiest = days.reduce((best, x) => (x.resumes + x.responses > (best ? best.resumes + best.responses : 0) ? x : best), null);
  const todayRow = byDay.get(d.today) || { resumes: 0, responses: 0 };
  // Default day: today if anything came in, else the latest day with activity.
  if (!state.act.day || !(state.act.day <= d.today)) {
    const active = [...byDay.keys()].sort();
    state.act.day = byDay.has(d.today) ? d.today : active[active.length - 1] || d.today;
  }
  const rangeLabel = state.act.range === "all" ? "all time" : `last ${state.act.range} days`;
  const stat = (label, value, note) => `<div class="apps-stat"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="note">${note}</div></div>`;
  const warnings = [
    ...d.sheet_errors.map(e => `Form responses for <b>${esc(e.role_name)}</b> are missing: ${esc(e.error)}`),
    ...(d.folder_errors.length ? [`${plural(d.folder_errors.length, "folder")} couldn't be read from WorkDrive, so some resumes may be missing.`] : []),
  ];

  card.querySelector(".card-head").innerHTML = `<div><h2>Applications by date</h2>
      <div class="hint">Resumes received and Google Form responses per day.</div></div>
    <div class="apps-filters">
      <div class="segmented" role="group" aria-label="Date range">${ACT_RANGES.map(([v, l]) =>
        `<button class="${state.act.range === v ? "on" : ""}" data-range="${v}" aria-pressed="${state.act.range === v}">${l}</button>`).join("")}</div>
      <select id="apps-role" aria-label="Position"><option value="">All positions</option>
        ${d.roles.map(r => `<option value="${esc(r.id)}" ${state.act.role === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
      <label class="apps-date">On date <input type="date" id="apps-day" value="${esc(state.act.day)}" max="${esc(d.today)}"></label>
    </div>`;

  card.querySelector(".card-body").innerHTML = `
    <div class="apps-stats">
      ${stat("Resumes received", sum("resumes").toLocaleString(), rangeLabel)}
      ${stat("Form responses", sum("responses").toLocaleString(), rangeLabel)}
      ${stat("Busiest day", busiest ? shortDay(busiest.date) : "—",
        busiest ? `${plural(busiest.resumes, "resume")} · ${plural(busiest.responses, "response")}` : "nothing in this range")}
      ${stat("Today", `${todayRow.resumes} <span class="value-sep">/</span> ${todayRow.responses}`, "resumes / form responses")}
    </div>
    ${warnings.length ? `<div class="callout apps-warn">${I.warn}<div>${warnings.join("<br>")}</div></div>` : ""}
    <div class="apps-toolbar">
      <div class="apps-legend">${ACT_SERIES.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>
      <div class="segmented small" role="group" aria-label="View">
        <button class="${state.act.view === "chart" ? "on" : ""}" data-view="chart">Chart</button>
        <button class="${state.act.view === "table" ? "on" : ""}" data-view="table">Table</button></div>
    </div>
    <div id="apps-plot" class="apps-plot"></div>
    <div id="apps-day-detail"></div>
    <p class="apps-foot muted small">A resume counts on the date of its date folder (e.g. "13 Nov"); resumes outside date folders count on
      the day they were uploaded. Resumes already sent to Zoho Recruit and removed from WorkDrive are still counted.
      Form responses use the sheet's Timestamp column.</p>`;

  $$("[data-range]", card).forEach(b => b.addEventListener("click", () => { state.act.range = b.dataset.range; prefSet("apps-range", b.dataset.range); renderActivity(); }));
  $$("[data-view]", card).forEach(b => b.addEventListener("click", () => { state.act.view = b.dataset.view; renderActivity(); }));
  $("#apps-role", card).addEventListener("change", e => { state.act.role = e.target.value; renderActivity(); });
  $("#apps-day", card).addEventListener("change", e => {
    if (!e.target.value) return;
    state.act.day = e.target.value;
    // Jumping to a day outside the range widens the range so the day is on the chart.
    const { days: shown } = activitySeries();
    if (shown.length && state.act.day < shown[0].date) state.act.range = "all";
    renderActivity();
  });

  if (state.act.view === "table") renderActivityTable(days);
  else renderActivityChart(days);
  renderDayDetail(rows);
}

function selectActivityDay(day) {
  state.act.day = day;
  const input = $("#apps-day");
  if (input) input.value = day;
  $$("#apps-plot .apps-band").forEach(b => b.classList.toggle("selected", b.dataset.day === day));
  $$("#apps-plot tr[data-day]").forEach(r => r.classList.toggle("selected", r.dataset.day === day));
  renderDayDetail(activitySeries().rows);
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/* Bar with 4px rounded top corners, square at the baseline. */
function topRounded(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderActivityChart(days) {
  const host = $("#apps-plot");
  const W = Math.max(300, host.clientWidth), H = 230;
  const m = { top: 14, right: 8, bottom: 28, left: 40 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const n = days.length, band = iw / n;
  const max = niceMax(Math.max(1, ...days.map(x => Math.max(x.resumes, x.responses))));
  const y = v => m.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
  // Two bars per day with a 2px gap between them and at least 2px between days.
  const bw = Math.max(1, Math.min(16, (band - 2 - 2) / 2));
  const labelEvery = Math.max(1, Math.ceil(52 / band));

  let svg = `<svg class="apps-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Resumes received and form responses per day">`;
  svg += ticks.map(t => `<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="axis" x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${t.toLocaleString()}</text>`).join("");
  days.forEach((dd, i) => {
    const x0 = m.left + i * band, cx = x0 + band / 2;
    svg += `<g class="apps-band ${dd.date === state.act.day ? "selected" : ""}" data-i="${i}" data-day="${dd.date}" tabindex="0"
        aria-label="${esc(shortDay(dd.date))}: ${dd.resumes} resumes, ${dd.responses} form responses">
      <rect class="hit" x="${x0}" y="${m.top}" width="${band}" height="${ih}"/>`;
    ACT_SERIES.forEach((s, j) => {
      const v = dd[s.key];
      if (!v) return;
      const bx = cx - bw - 1 + j * (bw + 2);
      svg += `<path class="bar" d="${topRounded(bx, y(v), bw, y(0) - y(v))}" style="fill:${s.color}"/>`;
    });
    svg += `</g>`;
    if ((n - 1 - i) % labelEvery === 0) svg += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(shortDay(dd.date))}</text>`;
  });
  svg += `<line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"/>`;
  // Direct label on each series' peak day, so the headline numbers read without hovering.
  ACT_SERIES.forEach((s, j) => {
    const peak = days.reduce((b, x, i) => (x[s.key] > (b ? days[b.i][s.key] : 0) ? { i } : b), null);
    if (!peak) return;
    const cx = m.left + peak.i * band + band / 2, bx = cx - bw - 1 + j * (bw + 2) + bw / 2;
    svg += `<text class="peak" x="${Math.min(W - m.right - 12, Math.max(m.left + 12, bx))}" y="${y(days[peak.i][s.key]) - 5}" text-anchor="middle">${days[peak.i][s.key]}</text>`;
  });
  svg += `</svg>`;
  host.innerHTML = svg + `<div class="apps-tip" id="apps-tip" hidden></div>`;

  const tip = $("#apps-tip");
  const show = g => {
    const dd = days[Number(g.dataset.i)];
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "tip-head"; head.textContent = longDay(dd.date); tip.append(head);
    ACT_SERIES.forEach(s => {
      const row = document.createElement("div"); row.className = "tip-row";
      const key = document.createElement("i"); key.style.background = s.color;
      const val = document.createElement("b"); val.textContent = dd[s.key].toLocaleString();
      const lab = document.createElement("span"); lab.textContent = s.label;
      row.append(key, val, lab); tip.append(row);
    });
    if (dd.resumes) {
      const src = document.createElement("div"); src.className = "tip-src";
      src.textContent = [["email", "by email"], ["walkin", "walk-in"], ["upload", "uploaded"]]
        .filter(([k]) => dd[k]).map(([k, l]) => `${dd[k]} ${l}`).join(" · ");
      tip.append(src);
    }
    tip.hidden = false;
    const box = host.getBoundingClientRect(), r = g.getBoundingClientRect();
    const left = r.left - box.left + r.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, left))}px`;
    tip.style.top = `${Math.max(0, m.top - 4)}px`;
  };
  $$(".apps-band", host).forEach(g => {
    g.addEventListener("pointerenter", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("pointerleave", () => { tip.hidden = true; });
    g.addEventListener("blur", () => { tip.hidden = true; });
    g.addEventListener("click", () => selectActivityDay(g.dataset.day));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectActivityDay(g.dataset.day); } });
  });
}

function renderActivityTable(days) {
  const host = $("#apps-plot");
  const list = [...days].reverse().filter(x => x.resumes || x.responses);
  host.innerHTML = list.length ? `<div class="table-wrap apps-table"><table>
      <thead><tr><th>Date</th><th class="num">Resumes</th><th class="num">By email</th><th class="num">Walk-in</th>
        <th class="num">Uploaded</th><th class="num">Form responses</th></tr></thead>
      <tbody>${list.map(x => `<tr class="clickable ${x.date === state.act.day ? "selected" : ""}" data-day="${x.date}">
        <td class="nowrap"><b>${esc(shortDay(x.date))}</b> <span class="muted small">${esc(parseDay(x.date).toLocaleDateString([], { weekday: "short" }))}</span></td>
        <td class="num">${x.resumes}</td><td class="num">${x.email || ""}</td><td class="num">${x.walkin || ""}</td>
        <td class="num">${x.upload || ""}</td><td class="num">${x.responses}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">Nothing received in this range.</div>`;
  $$("tr[data-day]", host).forEach(r => r.addEventListener("click", () => selectActivityDay(r.dataset.day)));
}

function renderDayDetail(rows) {
  const host = $("#apps-day-detail");
  if (!host) return;
  const day = state.act.day;
  const names = new Map(state.act.data.roles.map(r => [r.id, r.name]));
  const list = rows.filter(r => r.date === day).sort((a, b) => (b.resumes + b.responses) - (a.resumes + a.responses));
  const tot = k => list.reduce((n, r) => n + r[k], 0);
  host.innerHTML = `<div class="apps-day">
    <div class="apps-day-head"><h3>${esc(longDay(day))}</h3>
      <span class="muted">${plural(tot("resumes"), "resume")} received · ${plural(tot("responses"), "form response")}</span></div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Position</th><th class="num">Resumes</th><th class="num">By email</th><th class="num">Walk-in</th>
        <th class="num">Uploaded</th><th class="num">Form responses</th></tr></thead>
      <tbody>${list.map(r => `<tr class="clickable" data-href="#/folder/${esc(r.role_id)}">
        <td><b>${esc(names.get(r.role_id) || "(deleted position)")}</b></td>
        <td class="num">${r.resumes}</td><td class="num">${r.email || ""}</td><td class="num">${r.walkin || ""}</td>
        <td class="num">${r.upload || ""}</td><td class="num">${r.responses}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty small">No resumes or form responses on this day${state.act.role ? " for this position" : ""}.</div>`}
  </div>`;
  bindRows(host);
}

let actResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(actResizeTimer);
  actResizeTimer = setTimeout(() => { if ($("#apps-card") && state.act.data && state.act.view === "chart") renderActivity(); }, 150);
});

function runStatusTag(r) {
  if (r.status === "running") return `<span class="tag blue">Running</span>`;
  if (r.status === "failed") return `<span class="tag bad">Failed</span>`;
  return `<span class="tag good">Done</span>`;
}

/* ---------------------------------------------------------------- candidates */

async function renderCandidates(view) {
  const seg = (name, options) => `<div class="segmented" role="group">${options.map(([k, l]) =>
    `<button data-${name}="${k}" class="${state.cand[name] === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Candidates</h1><div class="sub" id="cand-count"></div></div></div>
    <section class="card">
      <div class="toolbar">
        ${seg("filter", [["", "All"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["form_pending", "Waiting for form"], ["walkin", "Walk-ins"], ["failed", "Failed"]])}
        ${seg("recruit", [["", "Any Recruit status"], ["saved", "In Recruit"], ["not_saved", "Not in Recruit yet"]])}
        <select id="cand-role" aria-label="Position"><option value="">All positions</option></select>
        <span class="spacer"></span>
        <label class="muted small" for="cand-page-size">Rows</label>
        <select id="cand-page-size" aria-label="Rows per page">
          ${[10, 20, 30].map(size => `<option value="${size}" ${state.cand.pageSize === size ? "selected" : ""}>${size}</option>`).join("")}
        </select>
        <input type="search" id="cand-q" placeholder="Search name, email or file" value="${esc(state.cand.q)}">
      </div>
      <div id="cand-body"><div class="loading-block"><span class="spinner"></span> Loading…</div></div>
    </section>`;
  for (const name of ["filter", "recruit"]) {
    $$(`[data-${name}]`).forEach(b => b.addEventListener("click", () => {
      state.cand[name] = b.dataset[name];
      state.cand.page = 1;
      $$(`[data-${name}]`).forEach(x => x.classList.toggle("on", x === b));
      loadCandidates();
    }));
  }
  $("#cand-role").addEventListener("change", e => { state.cand.role = e.target.value; state.cand.page = 1; loadCandidates(); });
  $("#cand-page-size").addEventListener("change", e => {
    state.cand.pageSize = Number(e.target.value) || 10;
    state.cand.page = 1;
    loadCandidates();
  });
  let timer;
  $("#cand-q").addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.cand.q = e.target.value.trim(); state.cand.page = 1; loadCandidates(); }, 250);
  });
  loadCandidates();
}

/* Sorting is client side: the API already returns the newest 500 rows. */
const CAND_SORTS = {
  name: c => (c.candidate_name || c.filename || "").toLowerCase(),
  position: c => (c.folder_path || "").toLowerCase(),
  score: c => c.overall_score ?? -1,
  recruit: c => c.recruit_status || "",
  time: c => c.duration_ms ?? -1,
  screened: c => c.updated_at || "",
};

function sortCandidates(rows) {
  const key = CAND_SORTS[state.cand.sort] || CAND_SORTS.screened;
  const dir = state.cand.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function sortableHead(cols) {
  return `<thead><tr>${cols.map(([key, label, cls]) => {
    const on = state.cand.sort === key;
    return `<th class="${cls || ""} sortable ${on ? "sorted" : ""}" data-sort="${key}">${label}` +
      `<span class="arrow">${on ? (state.cand.dir === "asc" ? "▲" : "▼") : ""}</span></th>`;
  }).join("")}</tr></thead>`;
}

function recruitCell(c) {
  if (c.recruit_status === "saved") {
    return `<span class="tag good" title="${c.recruit_action === "update" ? "Existing candidate updated" : "Added as a new candidate"}">${c.recruit_action === "update" ? "Updated" : "Saved"}</span>`;
  }
  if (c.recruit_status === "failed") return `<span class="tag bad" title="${esc(c.recruit_error || "")}">Failed</span>`;
  if (c.outcome === "passed") return `<span class="tag warn" title="${esc(c.workdrive_reason || "The Recruit push did not complete")}">Not saved</span>`;
  if (c.outcome === "form_pending") return `<span class="muted" title="Scored after the Google Form is filled">after form</span>`;
  if (c.outcome === "walkin") return `<span class="muted" title="Walk-ins stay in the app">app only</span>`;
  return `<span class="muted">—</span>`;
}

async function loadCandidates() {
  const body = $("#cand-body");
  if (!body) return;
  const qs = new URLSearchParams();
  for (const [key, param] of [["q", "q"], ["recruit", "recruit"], ["role", "role"]]) {
    if (state.cand[key]) qs.set(param, state.cand[key]);
  }
  const f = state.cand.filter;
  if (["high", "medium", "low"].includes(f)) qs.set("band", f);
  else if (f) qs.set("outcome", f);
  let data;
  try { data = await api(`/api/candidates?${qs}`); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const select = $("#cand-role");
  if (select && select.options.length <= 1) {
    select.innerHTML = `<option value="">All positions</option>` +
      data.roles.map(r => `<option value="${esc(r.id)}" ${state.cand.role === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("");
  }
  const count = $("#cand-count");
  if (count) count.textContent = `${plural(data.candidates.length, "resume")} screened${data.candidates.length === 500 ? " (newest 500)" : ""}`;

  const sorted = sortCandidates(data.candidates);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / state.cand.pageSize));
  state.cand.page = Math.min(state.cand.page, pages);
  const start = (state.cand.page - 1) * state.cand.pageSize;
  const rows = sorted.slice(start, start + state.cand.pageSize);
  const range = total ? `${start + 1}-${Math.min(start + state.cand.pageSize, total)} of ${total}` : "0 of 0";
  body.innerHTML = data.candidates.length ? `<div class="table-wrap"><table>
    ${sortableHead([["name", "Candidate"], ["position", "Position"], ["score", "Band", "num"],
                    ["", "Result"], ["recruit", "Recruit"], ["time", "Took", "num"], ["screened", "Screened"]])}
    <tbody>${rows.map(c => `<tr class="clickable" data-screening="${c.id}">
      <td><div class="primary-text">${esc(c.candidate_name || c.filename)}</div><div class="secondary-text">${esc(c.email || c.filename)}</div></td>
      <td>${esc(c.folder_path.split(" / ").slice(1).join(" / "))}</td>
      <td class="num">${scoreBadge(c.overall_score)}</td>
      <td>${resultTag({ ...c, stage: "done" })}</td>
      <td>${recruitCell(c)}</td>
      <td class="num muted small nowrap">${esc(secs(c.duration_ms))}</td>
      <td class="muted small nowrap" title="${esc(c.updated_at || "")}">${when(c.updated_at)}</td>
    </tr>`).join("")}</tbody></table></div>
    <div class="pagination" aria-label="Candidates pagination">
      <span class="muted small">Showing ${range}</span>
      <span class="spacer"></span>
      <button class="btn sm" data-page="prev" ${state.cand.page <= 1 ? "disabled" : ""}>Previous</button>
      <span class="small">Page ${state.cand.page} of ${pages}</span>
      <button class="btn sm" data-page="next" ${state.cand.page >= pages ? "disabled" : ""}>Next</button>
    </div>`
    : `<div class="empty">${I.inbox}<strong>No candidates match these filters</strong></div>`;
  $$("[data-sort]", body).forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    state.cand.dir = state.cand.sort === key && state.cand.dir === "desc" ? "asc" : "desc";
    state.cand.sort = key;
    state.cand.page = 1;
    loadCandidates();
  }));
  $("[data-page=prev]", body)?.addEventListener("click", () => { state.cand.page--; loadCandidates(); });
  $("[data-page=next]", body)?.addEventListener("click", () => { state.cand.page++; loadCandidates(); });
  bindRows(body);
}

/* ---------------------------------------------------------------- Google Form pending */

async function renderPending(view) {
  loading(view);
  let data;
  try { data = await api("/api/form-pending"); } catch (e) { return errorView(view, e.message); }
  const w = data.watcher || {};
  const all = data.roles.flatMap(r => r.items);
  const filled = all.filter(i => i.filled_at).length;
  const ago = iso => {
    const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
  };

  view.innerHTML = `
    <div class="page-head"><div><h1>Form pending</h1>
      <div class="sub">Resumes waiting for the candidate to fill the position's Google Form. The sheets are re-checked every
        ${w.interval_minutes || 10} min${w.last_check ? ` (last check ${when(w.last_check)})` : ""}.</div></div>
      <button class="btn" id="check-now">Check sheets now</button></div>
    <div class="stack">
      ${Object.entries(w.errors || {}).map(([role, err]) => `<div class="callout">${I.warn}<div><b>${esc(role)}:</b> ${esc(err)}</div></div>`).join("")}
      <div class="tiles">
        ${tile("Waiting for the form", all.length - filled, "not filled yet", all.length - filled ? "mid" : "")}
        ${tile("Form filled - ready to screen", filled, filled ? "click Screen on the position below" : "nothing new", filled ? "good" : "")}
      </div>
      ${data.roles.length ? data.roles.map(r => {
        const ready = r.items.filter(i => i.filled_at);
        return `<section class="card">
          <div class="card-head"><h2>${esc(r.name)} <span class="muted" style="font-weight:400">(${r.items.length})</span></h2>
            <div style="display:flex;gap:8px;align-items:center">
              ${r.has_sheet ? "" : `<a class="tag bad" href="#/sheets">No Google Form sheet - add it</a>`}
              <a class="btn sm" href="#/folder/${esc(r.pending_folder_id)}">Open folder</a>
              <button class="btn primary sm" data-screen-role="${esc(r.id)}" ${ready.length ? "" : "disabled"}>${I.play} Screen ${ready.length ? plural(ready.length, "filled form") : "filled"}</button>
            </div></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Resume</th><th>Email</th><th>Phone</th><th>Waiting</th><th>Google Form</th></tr></thead>
            <tbody>${r.items.map(i => `<tr class="${i.filled_at && !i.seen ? "fresh" : ""}">
              <td><div class="file-cell">${fileIcon(i.filename)}<div style="min-width:0"><div class="primary-text" title="${esc(i.filename)}">${esc(i.filename)}</div>
                <div class="secondary-text">from ${esc(i.from_folder_path || "")}</div></div></div></td>
              <td class="small">${esc((i.emails || []).join(", ")) || `<span class="muted">—</span>`}</td>
              <td class="small nowrap">${esc((i.phones || []).join(", ")) || `<span class="muted">—</span>`}</td>
              <td class="muted small nowrap" title="since ${esc(i.pending_since)}">${ago(i.pending_since)}</td>
              <td>${i.filled_at ? `<span class="tag good" title="found ${esc(i.filled_at)}">✓ Filled ${when(i.filled_at)}</span>` : `<span class="tag warn">Not filled</span>`}</td>
            </tr>`).join("")}</tbody></table></div></section>`;
      }).join("") : `<div class="card"><div class="empty">${I.inbox}<strong>Nobody is waiting</strong>Resumes without a Google Form response land here after screening.</div></div>`}
    </div>`;

  $("#check-now").addEventListener("click", async () => {
    const b = $("#check-now");
    b.disabled = true;
    b.innerHTML = `<span class="spinner"></span> Checking…`;
    try {
      const r = await api("/api/form-pending/check", { method: "POST" });
      if (r.busy) toast("A check is already running - try again in a moment.");
      else toast(r.newly_filled ? `${plural(r.newly_filled, "candidate")} filled the form` : "No new form responses",
        r.newly_filled ? "success" : "info");
    } catch (e) { toast(e.message, "error"); }
    await loadNotifications();
    renderPending(view);
  });
  $$("[data-screen-role]").forEach(b => b.addEventListener("click", async () => {
    const role = data.roles.find(r => r.id === b.dataset.screenRole);
    const ids = role.items.filter(i => i.filled_at && i.pending_folder_id === role.pending_folder_id).map(i => i.file_id);
    if (!ids.length) return toast("These resumes aren't in the Form Pending folder - screen them from their folder.", "error");
    b.disabled = true;
    try {
      await api("/api/runs", { method: "POST", body: { folder_id: role.pending_folder_id, file_ids: ids } });
      toast(`Screening ${plural(ids.length, "resume")} with their form answers`, "success");
      location.hash = `#/folder/${role.pending_folder_id}`;
    } catch (e) { toast(e.message, "error"); b.disabled = false; }
  }));

  // Opening the page reads the "form filled" notifications.
  if (state.notes.unseen > 0) {
    api("/api/notifications/seen", { method: "POST" }).then(loadNotifications).catch(() => {});
  }
}

async function loadNotifications() {
  let n;
  try { n = await api("/api/notifications"); } catch { return; }
  const badge = $("#pending-badge");
  if (badge) {
    badge.textContent = n.unseen > 99 ? "99+" : String(n.unseen);
    badge.hidden = !n.unseen;
    badge.title = `${plural(n.unseen, "new form response")} · ${n.waiting} still waiting`;
  }
  // Toast only for responses that arrive while the app is open.
  if (state.notes.unseen >= 0 && n.unseen > state.notes.unseen) {
    n.items.slice(0, Math.min(3, n.unseen - state.notes.unseen))
      .forEach(i => toast(`📝 ${i.filename} (${i.role_name}) filled the Google Form - ready to screen`, "success"));
  }
  state.notes.unseen = n.unseen;
}

/* ---------------------------------------------------------------- log & run */

function logHtml(events) {
  if (!events.length) return `<div class="empty" style="padding:18px">No activity yet.</div>`;
  return `<div class="log">${events.map(e => `<div class="log-line ${esc(e.level)}">
    <span class="t">${esc(new Date(e.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span>
    <span class="lv ${esc(e.level)}">${esc(e.level === "delete" ? "removed" : e.level)}</span>
    <span class="m">${esc(e.message)}</span></div>`).join("")}</div>`;
}

async function renderLog(view) {
  loading(view);
  let runs, events;
  try { [runs, events] = await Promise.all([api("/api/runs?limit=50"), api("/api/events?limit=300")]); }
  catch (e) { return errorView(view, e.message); }

  view.innerHTML = `
    <div class="page-head"><div><h1>Activity log</h1></div></div>
    <div class="stack">
      <section class="card"><div class="card-head"><h2>Screening runs</h2></div>
        ${runs.runs.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Folder</th><th>When</th><th class="num">Screened</th><th class="num">To Recruit</th><th class="num">Removed</th><th class="num">Took</th><th>Status</th></tr></thead>
          <tbody>${runs.runs.map(r => `<tr class="clickable" data-href="#/run/${r.id}">
            <td><b>${esc(r.folder_path.split(" / ").slice(1).join(" / "))}</b></td>
            <td class="muted nowrap">${when(r.started_at)}</td>
            <td class="num">${r.total}</td><td class="num">${r.passed}</td><td class="num">${r.deleted}</td>
            <td class="num muted small nowrap">${esc(between(r.started_at, r.finished_at))}</td>
            <td>${runStatusTag(r)}</td>
          </tr>`).join("")}</tbody></table></div>` : `<div class="empty">No runs yet.</div>`}
      </section>
      <section class="card"><div class="card-head"><h2>Events</h2></div>${logHtml(events.events.slice().reverse())}</section>
    </div>`;
  bindRows(view);
}

async function renderRun(view, runId) {
  loading(view);
  let data;
  try { data = await api(`/api/runs/${runId}`); } catch (e) { return errorView(view, e.message); }
  const r = data.run;
  const name = esc(r.folder_path.split(" / ").slice(1).join(" / "));
  view.innerHTML = `
    <nav class="crumbs"><a href="#/log">Activity log</a><span class="sep">/</span><span class="current">${name}</span></nav>
    <div class="page-head"><div><h1>${name}</h1>
      <div class="sub">${when(r.started_at)}${between(r.started_at, r.finished_at) ? ` · took ${between(r.started_at, r.finished_at)}` : ""} · ${r.passed} High/Medium · ${r.rejected} Low${r.form_pending ? ` · ${r.form_pending} waiting for form` : ""}${r.failed ? ` · ${r.failed} failed` : ""} · ${r.deleted} removed</div></div></div>
    <div class="stack">
      ${r.error ? `<div class="callout">${I.warn}<div>${esc(r.error)}</div></div>` : ""}
      <section class="card">
        ${data.screenings.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Candidate</th><th class="num">Band</th><th>Result</th><th>Recruit</th><th class="num">Took</th></tr></thead>
          <tbody>${data.screenings.map(s => `<tr class="clickable" data-screening="${s.id}">
            <td><div class="primary-text">${esc(s.candidate_name || s.filename)}</div><div class="secondary-text">${esc(s.error || (s.outcome === "form_pending" ? s.workdrive_reason : "") || s.filename)}</div></td>
            <td class="num">${scoreBadge(s.overall_score)}</td><td>${resultTag(s)}</td>
            <td>${recruitCell(s)}</td>
            <td class="num muted small nowrap">${esc(secs(s.duration_ms))}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="empty">No resumes in this run.</div>`}
      </section>
      <section class="card"><div class="card-head"><h2>Log</h2></div>${logHtml(data.events)}</section>
    </div>`;
  bindRows(view);
}

/* ---------------------------------------------------------------- candidate drawer */

async function openScreening(id) {
  $("#drawer-body").innerHTML = `<div class="loading-block"><span class="spinner"></span> Loading…</div>`;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  try { showCandidate(await api(`/api/screenings/${id}`)); }
  catch (e) { $("#drawer-body").innerHTML = `<div class="d-body"><div class="callout">${I.warn}<div>${esc(e.message)}</div></div></div>`; }
}

function showCandidate(s) {
  $("#drawer-body").innerHTML = candidateHtml(s);
  $$("#drawer-body [data-close]").forEach(el => el.addEventListener("click", closeDrawer));
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}

function basicInfo(j) {
  if (j.basic_information) return j.basic_information;
  // Screenings saved before the basic-information format.
  const c = j.candidate || {}, prof = j.professional || {}, loc = j.location || {}, links = j.links || {};
  const [first, ...rest] = String(c.full_name || "").split(" ");
  return {
    first_name: c.first_name || first || "", last_name: c.last_name || rest.join(" "),
    contact: c.phone, email: c.email, phone: c.alternate_phone,
    location: loc.current_location || [loc.city, loc.state, loc.country].filter(Boolean).join(", "),
    linkedin_url: links.linkedin, experience_years: prof.total_experience_years,
    experience: [prof.current_job_title, prof.current_employer].filter(Boolean).join(" at "),
    portfolio_url: links.portfolio || links.website, project_urls: links.live_project_links || [],
    education_board: "", position_applied: "",
  };
}

function walkinHtml(w) {
  if (!w) return "";
  const rows = [["Name", esc(w.name)], ["Phone", esc(w.phone)], ["Email", esc(w.email)], ["Added", esc(when(w.added_at))],
    ["HR notes", `<span style="white-space:pre-wrap">${esc(w.notes)}</span>`]];
  return `<section class="card"><div class="card-head"><h3>Walk-in details</h3><span class="tag blue">App only</span></div>
    <div class="card-body"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v || `<span class="muted">—</span>`}</dd>`).join("")}</dl></div></section>`;
}

function formAnswersHtml(form) {
  if (!form || !Array.isArray(form.answers)) return "";
  return `<section class="card"><div class="card-head"><h3>Google Form response</h3>
      <span class="muted small">${form.submitted_at ? `submitted ${esc(form.submitted_at)} · ` : ""}matched by ${esc(form.matched_by || "")}</span></div>
    <div class="card-body"><dl class="qa">${form.answers.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${linkify(a)}</dd>`).join("")}</dl></div></section>`;
}

function linkify(text) {
  const t = String(text ?? "");
  return /^https?:\/\/\S+$/i.test(t.trim()) ? link(t.trim()) : esc(t);
}

function candidateHtml(s) {
  const j = s.ai_json || {};
  const b = basicInfo(j), ev = j.evaluation || {};
  const name = [b.first_name, b.last_name].filter(Boolean).join(" ") || s.candidate_name || s.filename;

  const tags = [];
  if (s.outcome === "form_pending") tags.push(resultTag({ ...s, stage: "done" }));
  else if (!s.error) {
    tags.push(resultTag({ ...s, stage: "done" }));
    if (s.recruit_status === "saved") tags.push(`<span class="tag good">Saved to Recruit</span>`);
    if (s.recruit_status === "failed") tags.push(`<span class="tag bad" title="${esc(s.recruit_error || "")}">Recruit save failed</span>`);
  }

  const urlCell = u => safeUrl(u) ? link(u) : "";
  const rows = [
    ["Salutation", esc(b.salutation)],
    ["First name", esc(b.first_name)],
    ["Last name", esc(b.last_name)],
    ["Gender", esc(b.gender)],
    ["Age (yrs)", esc(b.age_years ?? "")],
    ["Marital status", esc(b.marital_status)],
    ["Contact", esc(b.contact)],
    ["Phone", esc(b.phone)],
    ["Email", esc(b.email)],
    ["Secondary email", esc(b.secondary_email)],
    ["Address", esc([b.street, b.city, b.state, b.zip_code, b.country].filter(Boolean).join(", "))],
    ["Current location", esc(b.location)],
    ["Hometown location", esc(b.hometown_location)],
    ["LinkedIn URL", urlCell(b.linkedin_url)],
    ["Experience", esc(b.work_history ? b.experience
      : [b.experience_years != null ? `${b.experience_years} yrs` : "", b.experience].filter(Boolean).join(" · "))],
    ["Current job title", esc(b.current_job_title)],
    ["Portfolio / Project URL", [b.portfolio_url, ...(b.project_urls || [])].map(urlCell).filter(Boolean).join("<br>")],
    ["Highest qualification", esc(b.highest_qualification)],
    ["Year of clearing B.Tech / BCA / MCA", esc([b.graduation_year, b.tech_degree && `(${b.tech_degree})`].filter(Boolean).join(" "))],
    ["Education board", esc(b.education_board)],
    ["Skill set", esc((b.skills || []).join(", "))],
    ["Department", esc(b.department)],
    ["Position applied", esc(b.position_applied)],
  ];

  return `<div class="d-head"><div class="d-head-top">
      <div style="min-width:0"><div class="d-title" id="drawer-title">${esc(name)}</div>
        <div class="d-sub">${esc(s.filename)}</div></div>
      <button class="btn ghost" data-close aria-label="Close">${I.close}</button></div></div>
    <div class="d-body">
      ${s.error ? `<div class="callout">${I.warn}<div>${esc(s.error)}</div></div>` : ""}
      ${s.outcome === "form_pending" ? `<div class="callout warn">${I.warn}<div><b>Waiting for the Google Form.</b> ${esc(s.workdrive_reason || "")}
        It is scored once the candidate fills the form - see <a href="#/pending" data-close>Form pending</a>.</div></div>` : ""}
      <section class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          ${s.overall_score != null ? `<span class="score big ${bandOf(s.overall_score) === "High" ? "hi" : bandOf(s.overall_score) === "Medium" ? "mid" : "lo"}">${bandOf(s.overall_score)} <small>${Math.round(s.overall_score)}</small></span>` : ""}
          <div class="chips">${tags.join("")}</div>
        </div>
        ${s.overall_score != null ? `<div class="muted small">AI score ${ev.ai_score ?? "–"} · Skills ${ev.skill_score ?? "–"} · Experience ${ev.experience_score ?? "–"}${ev.form_score != null ? ` · <b>Google Form ${ev.form_score}</b>` : " · resume only"}</div>` : ""}
        ${ev.summary ? `<p style="margin:0;color:var(--text-2)">${esc(ev.summary)}</p>` : ""}
        ${ev.form_notes ? `<p style="margin:0;color:var(--text-2)"><b>Form:</b> ${esc(ev.form_notes)}</p>` : ""}
        ${(ev.matched_skills || []).length ? `<div><div class="muted small" style="margin-bottom:5px">Matches the job</div>${chips(ev.matched_skills, "good")}</div>` : ""}
        ${(ev.missing_skills || []).length ? `<div><div class="muted small" style="margin-bottom:5px">Missing</div>${chips(ev.missing_skills, "bad")}</div>` : ""}
      </div></section>
      ${walkinHtml(s.walkin)}
      ${formAnswersHtml(s.form_json)}
      <section class="card"><div class="card-head"><h3>Basic information</h3></div><div class="card-body">
        <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v || `<span class="muted">—</span>`}</dd>`).join("")}</dl>
      </div></section>
    </div>`;
}

/* ---------------------------------------------------------------- modal & boot */

function openModal(html, { wide = false } = {}) {
  $("#modal-body").innerHTML = html;
  $("#modal-body").classList.toggle("wide", wide);
  $("#modal").classList.add("open");
  $("#modal").setAttribute("aria-hidden", "false");
  $$("#modal [data-close]").forEach(el => el.addEventListener("click", closeModal));
}

function closeModal() {
  $("#modal").classList.remove("open");
  $("#modal").setAttribute("aria-hidden", "true");
}

const closeMenus = () => $$(".menu").forEach(m => { m.hidden = true; m.previousElementSibling?.setAttribute("aria-expanded", "false"); });
document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenus(); closeModal(); closeDrawer(); } });
$$("#drawer .drawer-scrim").forEach(el => el.addEventListener("click", closeDrawer));
$$("#modal .modal-scrim").forEach(el => el.addEventListener("click", closeModal));
window.addEventListener("hashchange", route);

const prefetching = new Set();
document.addEventListener("pointerover", e => {
  const card = e.target.closest?.("a.folder-card[href^='#/folder/']");
  if (!card) return;
  const id = card.getAttribute("href").slice("#/folder/".length);
  if (state.browse.has(id) || prefetching.has(id)) return;
  prefetching.add(id);
  api(`/api/browse?folder_id=${encodeURIComponent(id)}`)
    .then(d => { if (!state.browse.has(id)) state.browse.set(id, d); })
    .catch(() => {})
    .finally(() => prefetching.delete(id));
});




/* ---------------------------------------------------------------- Google Form invites
   Applicants fetched from email land here with the email read from their resume.
   Nothing is sent automatically: the team reviews, fixes emails, then clicks Send.
   Each position's form link + email template is set in inviteDialog (Form sheets page). */

const INVITE_STATUS = {
  ready: ["blue", "Ready"], no_email: ["warn", "No email"], sending: ["", "Sending…"], sent: ["good", "✓ Sent"],
  already_sent: ["good", "Sent earlier"], failed: ["bad", "Failed"], dismissed: ["", "Dismissed"],
};
const SOURCE_LABEL = { resume: "from resume", indeed: "from Indeed reply-to", manual: "typed in" };
const invState = { show: "open", selected: new Set(), poll: null };

async function loadInviteBadge() {
  let n;
  try { n = await api("/api/invites/status"); } catch { return; }
  const badge = $("#invites-badge");
  if (!badge) return;
  badge.textContent = n.ready > 99 ? "99+" : String(n.ready);
  badge.hidden = !n.ready;
  badge.title = `${plural(n.ready, "applicant")} ready for the Google Form`;
}

function inviteDialog(role, onSaved) {
  openModal(`<h2>Google Form invite · ${esc(role.name)}</h2><div class="loading-block" style="padding:30px 0"><span class="spinner"></span> Loading…</div>`, { wide: true });
  api(`/api/roles/${encodeURIComponent(role.id)}/invite`).then(cfg => {
    openModal(`
      <h2>Google Form invite · ${esc(role.name)}</h2>
      <p class="muted small">Sent from <b>${esc(cfg.from)}</b> to applicants you select on the Form invites page.
        Placeholders: <code>{first_name}</code> <code>{name}</code> <code>{position}</code> <code>{form_link}</code></p>
      <div class="callout ${cfg.form_url ? "info" : "warn"}"><div>${cfg.form_url
        ? `Google Form: <b>${esc(cfg.form_name || "set")}</b> · ${link(cfg.form_url, "open")}`
        : "No Google Form picked for this position yet."} Forms are managed in one place on the <a href="#/forms" data-close>Forms</a> page.</div></div>
      <div class="field"><label for="inv-subject">Email subject</label>
        <input type="text" id="inv-subject" value="${esc(cfg.invite_subject || cfg.default_subject)}"></div>
      <div class="field"><label for="inv-body">Email text</label>
        <textarea id="inv-body" rows="12">${esc(cfg.invite_body || cfg.default_body)}</textarea></div>
      <div class="modal-actions">
        <button class="btn" id="inv-reset" title="Put the standard subject and text back">Use default text</button>
        <button class="btn" id="inv-test">Save & send test to me</button>
        <span style="flex:1"></span>
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="inv-save">Save</button>
      </div>`, { wide: true });
    $("#inv-reset").addEventListener("click", () => { $("#inv-subject").value = cfg.default_subject; $("#inv-body").value = cfg.default_body; });
    const save = async () => api(`/api/roles/${encodeURIComponent(role.id)}/invite`, { method: "PUT", body: {
      invite_subject: $("#inv-subject").value, invite_body: $("#inv-body").value } });
    const busy = (b, on, label) => { b.disabled = on; b.innerHTML = on ? `<span class="spinner"></span>` : label; };
    $("#inv-save").addEventListener("click", async () => {
      const b = $("#inv-save"); busy(b, true);
      try { await save(); closeModal(); toast("Google Form invite saved", "success"); onSaved && onSaved(); }
      catch (e) { toast(e.message, "error"); busy(b, false, "Save"); }
    });
    $("#inv-test").addEventListener("click", async () => {
      const b = $("#inv-test"); busy(b, true);
      try {
        await save();
        const r = await api(`/api/roles/${encodeURIComponent(role.id)}/invite/test`, { method: "POST" });
        toast(`Test email sent to ${r.sent_to} - check that inbox`, "success");
      } catch (e) { toast(e.message, "error"); }
      busy(b, false, "Save & send test to me");
    });
  }).catch(e => { closeModal(); toast(e.message, "error"); });
}

async function renderInvites(view, { quiet = false } = {}) {
  if (!quiet) loading(view);
  let data;
  try { data = await api("/api/invites"); } catch (e) { return errorView(view, e.message); }
  const all = data.roles.flatMap(r => r.items);
  const count = st => all.filter(i => i.status === st).length;
  const open = i => !["sent", "already_sent", "dismissed"].includes(i.status);
  const sending = data.sender?.running;
  invState.selected = new Set([...invState.selected].filter(id => all.some(i => i.id === id && i.status === "ready")));

  const rowHtml = (i, role) => {
    const [cls, label] = INVITE_STATUS[i.status] || ["", i.status];
    const editable = ["ready", "no_email", "failed"].includes(i.status);
    const sendable = (i.status === "ready" || i.status === "failed") && i.email && role.form_url;
    return `<tr data-inv="${i.id}">
      <td class="check">${i.status === "ready" && role.form_url ? `<input type="checkbox" data-pick="${i.id}" ${invState.selected.has(i.id) ? "checked" : ""} aria-label="Select ${esc(i.candidate)}">` : ""}</td>
      <td><div class="primary-text">${esc(i.candidate)}</div><div class="secondary-text" title="${esc(i.file_name || "")}">${esc(i.file_name || "")}</div></td>
      <td>${editable
        ? `<input type="email" class="inv-email" value="${esc(i.email || "")}" placeholder="add email…" aria-label="Email for ${esc(i.candidate)}">`
        : esc(i.email || "")}
        <div class="secondary-text">${esc(SOURCE_LABEL[i.email_source] || "")}${i.other_emails?.length ? ` · also: ${esc(i.other_emails.join(", "))}` : ""}</div></td>
      <td class="muted small nowrap">${i.applied_at ? esc(when(i.applied_at)) : ""}</td>
      <td class="nowrap"><span class="tag ${cls}" ${i.error ? `title="${esc(i.error)}"` : ""}>${label}</span>
        ${i.sent_at ? `<div class="secondary-text">${esc(when(i.sent_at))}</div>` : ""}
        ${i.error ? `<div class="secondary-text" style="color:var(--bad);max-width:260px;white-space:normal">${esc(i.error)}</div>` : ""}</td>
      <td class="nowrap">${sendable ? `<button class="btn sm primary" data-send-one="${i.id}">Send</button>` : ""}
        ${editable ? `<button class="btn sm" data-dismiss="${i.id}" title="Don't send to this applicant">Dismiss</button>` : ""}
        ${i.status === "dismissed" ? `<button class="btn sm" data-restore="${i.id}">Undo</button>` : ""}</td>
    </tr>`;
  };

  const roles = data.roles.map(r => ({ ...r, shown: r.items.filter(i => invState.show === "all" || open(i)) })).filter(r => r.shown.length);
  view.innerHTML = `
    <div class="page-head"><div><h1>Form invites</h1>
      <div class="sub">Applicants fetched from email. Check the address, then send them the position's Google Form from
        <b>${esc(data.from)}</b>. Nobody is emailed until you click Send, and nobody gets the same form twice.</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="inv-show" aria-label="Show"><option value="open" ${invState.show === "open" ? "selected" : ""}>To do</option>
          <option value="all" ${invState.show === "all" ? "selected" : ""}>Everything (incl. sent)</option></select>
        <button class="btn primary" id="inv-send-sel" disabled>Send selected</button></div></div>
    <div class="stack">
      ${sending ? `<div class="callout info"><span class="spinner"></span><div>Sending ${data.sender.done}/${data.sender.total}…</div></div>` : ""}
      ${data.sender?.error && !sending ? `<div class="callout">${I.warn}<div>${esc(data.sender.error)}</div></div>` : ""}
      <div class="tiles">
        ${tile("Ready to send", count("ready"), count("ready") ? "select and click Send" : "nothing waiting", count("ready") ? "mid" : "")}
        ${tile("No email found", count("no_email"), count("no_email") ? "type the address in" : "all have an email", count("no_email") ? "bad" : "")}
        ${tile("Sent", count("sent") + count("already_sent"), "Google Form invites", count("sent") ? "good" : "")}
      </div>
      ${roles.length ? roles.map(r => {
        const ready = r.shown.filter(i => i.status === "ready");
        return `<section class="card" data-role="${esc(r.id)}">
          <div class="card-head"><h2>${esc(r.name)} <span class="muted" style="font-weight:400">(${r.shown.length})</span></h2>
            <div style="display:flex;gap:8px;align-items:center">
              ${r.form_url ? `<a class="btn sm" href="${esc(safeUrl(r.form_url) || "#")}" target="_blank" rel="noopener noreferrer">Open form</a>`
                : `<span class="tag bad">No Google Form link</span>`}
              <button class="btn sm" data-edit-role="${esc(r.id)}">${r.form_url ? "Edit link & email" : "Add form link"}</button>
              <button class="btn primary sm" data-send-role="${esc(r.id)}" ${ready.length && r.form_url && !sending ? "" : "disabled"}>Send to ${ready.length ? plural(ready.length, "ready applicant") : "ready"}</button>
            </div></div>
          <div class="table-wrap"><table>
            <thead><tr><th class="check"><input type="checkbox" data-pick-role="${esc(r.id)}" aria-label="Select all ready in ${esc(r.name)}" ${ready.length && r.form_url ? "" : "disabled"}></th>
              <th>Applicant</th><th>Email</th><th>Applied</th><th>Status</th><th></th></tr></thead>
            <tbody>${r.shown.map(i => rowHtml(i, r)).join("")}</tbody></table></div></section>`;
      }).join("") : `<div class="card"><div class="empty">${I.inbox}<strong>${all.length ? "All done" : "No applicants yet"}</strong>
        ${all.length ? "Everyone fetched so far has been sent the form or dismissed." : "Click <b>Fetch from email</b> on the Resumes page; fetched applicants appear here."}</div></div>`}
    </div>`;

  const selBtn = $("#inv-send-sel");
  const syncSel = () => { selBtn.disabled = sending || !invState.selected.size; selBtn.textContent = invState.selected.size ? `Send selected (${invState.selected.size})` : "Send selected"; };
  syncSel();
  const send = async (ids, label) => {
    if (!ids.length) return;
    if (!confirm(`Send the Google Form invite to ${plural(ids.length, "applicant")}${label ? ` (${label})` : ""}?`)) return;
    try {
      await api("/api/invites/send", { method: "POST", body: { ids } });
      invState.selected.clear();
      toast(`Sending ${plural(ids.length, "invite")}…`);
      watchSending(view);
    } catch (e) { toast(e.message, "error"); }
    renderInvites(view, { quiet: true });
  };

  $("#inv-show").addEventListener("change", e => { invState.show = e.target.value; renderInvites(view, { quiet: true }); });
  selBtn.addEventListener("click", () => send([...invState.selected]));
  $$("[data-pick]", view).forEach(cb => cb.addEventListener("change", () => {
    const id = Number(cb.dataset.pick);
    cb.checked ? invState.selected.add(id) : invState.selected.delete(id);
    syncSel();
  }));
  $$("[data-pick-role]", view).forEach(cb => cb.addEventListener("change", () => {
    $$(`section[data-role="${CSS.escape(cb.dataset.pickRole)}"] [data-pick]`, view).forEach(x => {
      x.checked = cb.checked;
      cb.checked ? invState.selected.add(Number(x.dataset.pick)) : invState.selected.delete(Number(x.dataset.pick));
    });
    syncSel();
  }));
  $$("[data-send-role]", view).forEach(b => b.addEventListener("click", () => {
    const r = data.roles.find(x => x.id === b.dataset.sendRole);
    send(r.items.filter(i => i.status === "ready").map(i => i.id), r.name);
  }));
  $$("[data-send-one]", view).forEach(b => b.addEventListener("click", () => send([Number(b.dataset.sendOne)])));
  $$("[data-edit-role]", view).forEach(b => b.addEventListener("click", () => {
    const r = data.roles.find(x => x.id === b.dataset.editRole);
    inviteDialog(r, () => renderInvites(view, { quiet: true }));
  }));
  const patch = async (id, body, okMsg) => {
    try { await api(`/api/invites/${id}`, { method: "PATCH", body }); if (okMsg) toast(okMsg, "success"); }
    catch (e) { toast(e.message, "error"); }
    renderInvites(view, { quiet: true });
    loadInviteBadge();
  };
  $$("[data-dismiss]", view).forEach(b => b.addEventListener("click", () => patch(b.dataset.dismiss, { dismiss: true })));
  $$("[data-restore]", view).forEach(b => b.addEventListener("click", () => patch(b.dataset.restore, { restore: true })));
  $$(".inv-email", view).forEach(input => {
    const id = input.closest("tr").dataset.inv, before = input.value.trim();
    const commit = () => { const v = input.value.trim(); if (v !== before) patch(id, { email: v }, v ? "Email saved" : "Email cleared"); };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  });
  if (sending) watchSending(view);
}

function watchSending(view) {
  if (invState.poll) return;
  invState.poll = setInterval(async () => {
    let st;
    try { st = await api("/api/invites/status"); } catch { return; }
    if (!location.hash.startsWith("#/invites")) { clearInterval(invState.poll); invState.poll = null; return; }
    if (st.running) return renderInvites(view, { quiet: true });
    clearInterval(invState.poll); invState.poll = null;
    if (st.error) toast(st.error, "error");
    else toast(`Google Form sent to ${plural(st.sent, "applicant")}${st.skipped ? ` · ${st.skipped} had it already` : ""}${st.failed ? ` · ${st.failed} failed` : ""}`, st.failed ? "error" : "success");
    loadInviteBadge();
    renderInvites(view, { quiet: true });
  }, 2000);
}

/* ======================================================================
   Simple flow (Home · Applicants · Positions)
   Gmail → Google Form → (manual) Screen → Qualified / Not qualified.
   One record per applicant comes from /api/applicants; each step has one button.
   ====================================================================== */

const hashParams = () => new URLSearchParams((location.hash.split("?")[1]) || "");
const STEP_TAG = {
  new: "blue", no_email: "bad", sent: "warn", filled: "purple", screening: "", qualified: "good",
  not_qualified: "", error: "bad",
};
const AP_TABS = [["all", "All"], ["new", "New: send form"], ["sent", "Waiting for form"],
  ["filled", "Form filled: screen"], ["qualified", "Qualified"], ["not_qualified", "Not qualified"]];
const RANGES = [["7", "Last 7 days"], ["30", "Last 30 days"], ["today", "Today"], ["all", "All time"]];
const ap = { tab: "all", role: "", source: "", q: "", range: "all", selected: new Set(), poll: null, data: null };
const SOURCES = [["gmail", "From Gmail"], ["upload", "Uploaded"], ["walkin", "Walk-in"]];

function daysAgo(iso) {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
const shortDate = iso => iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }) : "";

function stepNote(a) {
  if (a.step === "new") return a.email_source === "indeed" ? "email from Indeed" : "email from resume";
  if (a.step === "no_email") return "type the email to send the form";
  if (a.step === "sent") return `form sent ${daysAgo(a.sent_at)}`;
  if (a.step === "filled") return `answered ${daysAgo(a.form_filled_at)}`;
  if (a.step === "screening") return "scoring resume + answers";
  if (a.step === "qualified") return a.source === "walkin" ? "walk-in · app only" : a.recruit_status === "saved" ? "in Zoho Recruit" : "Recruit save pending";
  if (a.step === "not_qualified") return "kept in WorkDrive";
  if (a.step === "error") return a.error || "screening failed";
  return "";
}

function stepPill(a) {
  const label = (a.step === "qualified" || a.step === "not_qualified") && a.score != null
    ? `${a.band || a.step_label} · ${Math.round(a.score)}` : a.step_label;
  return `<span class="tag ${STEP_TAG[a.step] || ""}">${a.step === "screening" ? `<span class="spinner"></span>` : ""}${esc(label)}</span>`;
}

async function sendForms(ids) {
  if (!ids.length) return;
  if (!confirm(`Send the Google Form to ${plural(ids.length, "applicant")}?`)) return false;
  try {
    await api("/api/applicants/send-form", { method: "POST", body: { ids } });
    toast(`Sending the Google Form to ${plural(ids.length, "applicant")}…`);
    return true;
  } catch (e) { toast(e.message, "error"); return false; }
}

async function screenApplicants(ids) {
  if (!ids.length) return;
  if (!confirm(`Screen ${plural(ids.length, "applicant")} now? Each is scored on resume + Google Form answers.`)) return false;
  try {
    const r = await api("/api/applicants/screen", { method: "POST", body: { ids } });
    toast(`Screening ${plural(r.queued, "applicant")}…`);
    return true;
  } catch (e) { toast(e.message, "error"); return false; }
}

function progressCallout(p) {
  const q = p.queue || {}, s = p.sender || {}, f = p.fetch || {};
  const parts = [];
  if (f.running) parts.push(`Fetching from Gmail${f.total ? ` ${f.done}/${f.total}` : "…"}`);
  if (s.running) parts.push(`Sending forms ${s.done}/${s.total}`);
  if (q.running) parts.push(`Screening${q.total ? ` ${q.total} applicant(s)` : "…"}`);
  return parts.length ? `<div class="callout info"><span class="spinner"></span><div>${esc(parts.join(" · "))} - this page updates by itself.</div></div>` : "";
}

/* ---------------------------------------------------------------- Home */

async function renderHome(view, { quiet = false } = {}) {
  const range = hashParams().get("range") || prefGet("home-range", "7");
  if (!quiet) loading(view);
  let d;
  try { d = await api(`/api/home?range=${encodeURIComponent(range)}`); } catch (e) { return errorView(view, e.message); }
  const f = d.funnel, t = d.todo, src = d.sources;
  const pct = (n, of) => of ? Math.round(100 * n / of) : 0;
  const bar = (label, n, of, note, cls = "") => `<a class="funnel-row" href="#/applicants">
      <span class="funnel-label">${label}</span>
      <span class="funnel-track"><span class="funnel-fill ${cls}" style="width:${f.applied ? Math.max(2, pct(n, f.applied)) : 0}%"></span></span>
      <span class="funnel-num"><b>${n}</b>${note ? ` <span class="muted small">${note}</span>` : ""}</span></a>`;
  const today = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${esc(today)}</div>
        <h1>${t.send + t.no_email + t.screen ? "Here's what needs you today." : "You're all caught up."}</h1></div>
      <div class="head-actions">
        <select id="home-range" aria-label="Date range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === range ? "selected" : ""}>${l}</option>`).join("")}</select>
        <button class="btn" id="add-applicant">+ Add walk-in</button>
        <button class="btn" id="upload-resumes">Upload resumes</button>
        <button class="btn primary" id="fetch-emails">Fetch new from Gmail</button></div></div>
    <div class="stack">
      <div id="home-progress"></div>
      <section class="todo-grid" aria-label="To do">
        <div class="todo-card"><div class="todo-top"><span class="todo-num blue">1</span>New applicants</div>
          <div class="todo-big">${t.send + t.no_email} <span>applicants</span></div>
          <div class="todo-text">${t.send + t.no_email ? `Haven't got the Google Form yet.${t.no_email ? ` ${t.no_email} have no email - add it first.` : ""}${t.send_blocked ? ` ${t.send_blocked} are for positions without a Google Form.` : ""}` : "Everyone has been sent the form."}</div>
          <a class="btn ${t.send ? "primary" : ""}" href="#/applicants?tab=new">${t.send ? `Review & send form (${t.send})` : "Open"}</a></div>
        <div class="todo-card"><div class="todo-top"><span class="todo-num purple">2</span>Form filled</div>
          <div class="todo-big">${t.screen} <span>ready to screen</span></div>
          <div class="todo-text">${t.screen ? "Their answers are in. Screening scores resume + answers." : t.screening ? `${t.screening} being screened right now.` : "Nobody is waiting to be screened."}
            ${t.waiting ? `<br>${t.waiting} still haven't filled the form.` : ""}</div>
          <a class="btn ${t.screen ? "primary" : ""}" href="#/applicants?tab=filled">${t.screen ? `Review & screen (${t.screen})` : "Open"}</a></div>
        <div class="todo-card"><div class="todo-top"><span class="todo-num green">3</span>Qualified (${esc(RANGES.find(r => r[0] === range)?.[1].toLowerCase() || "")})</div>
          <div class="todo-big">${f.qualified} <span>applicants</span></div>
          <div class="todo-text">${f.high} High · ${f.medium} Medium · ${f.in_recruit} in Zoho Recruit${f.walkins ? ` · ${f.walkins} walk-in(s)` : ""}</div>
          <a class="btn" href="#/applicants?tab=qualified">See qualified</a></div>
      </section>

      <section class="card"><div class="card-head"><h2>Resumes received</h2><span class="muted small">${esc(RANGES.find(r => r[0] === range)?.[1].toLowerCase() || "")}</span></div>
        <div class="card-body"><div class="source-grid">
          <a class="source-tile" href="#/applicants?source="><div class="k">All resumes</div><div class="v">${src.gmail.received + src.upload.received + src.walkin.received}</div>
            <div class="n">${src.gmail.form_sent + src.upload.form_sent} sent the form · ${src.gmail.in_recruit + src.upload.in_recruit + src.walkin.in_recruit} in Zoho Recruit</div></a>
          ${[["gmail", "From Gmail"], ["upload", "Uploaded"], ["walkin", "Walk-ins"]].map(([k, label]) => `
          <a class="source-tile" href="#/applicants?source=${k}"><div class="k">${label}</div><div class="v">${src[k].received}</div>
            <div class="n">${k === "walkin" ? "" : `${src[k].form_sent} sent the form · `}${src[k].qualified} qualified · ${src[k].in_recruit} in Recruit</div></a>`).join("")}
        </div></div></section>

      <section class="card"><div class="card-head"><h2>From applied to qualified</h2><span class="muted small">Gmail + uploaded applicants, ${esc(RANGES.find(r => r[0] === range)?.[1].toLowerCase() || "")}</span></div>
        <div class="card-body">${f.applied ? `<div class="funnel">
          ${bar("Applied", f.applied, f.applied, "")}
          ${bar("Form sent", f.form_sent, f.applied, `${pct(f.form_sent, f.applied)}%`)}
          ${bar("Form filled", f.form_filled, f.applied, f.form_sent ? `${pct(f.form_filled, f.form_sent)}% of sent` : "")}
          ${bar("Screened", f.screened, f.applied, "")}
          ${bar("Qualified", f.qualified, f.applied, f.screened ? `${pct(f.qualified, f.screened)}% of screened` : "", "good")}
        </div>
        <div class="funnel-legend"><span>High (${state.status?.bands?.high ?? 75}+): <b>${f.high}</b></span>
          <span>Medium: <b>${f.medium}</b></span><span>Not qualified: <b>${f.not_qualified}</b></span>
          <span>In Zoho Recruit: <b>${f.in_recruit}</b></span></div>`
        : `<div class="empty">${I.inbox}<strong>No applicants in this period</strong>Click <b>Fetch new from Gmail</b> to bring in the latest applications.</div>`}</div></section>

      <section class="card"><div class="card-head"><h2>By position</h2><a href="#/positions" class="small"><b>Set up positions</b></a></div>
        ${d.positions.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Position</th><th class="num">Received</th><th class="num" title="From Gmail / uploaded / walk-in">Gmail/Upl./Walk-in</th><th class="num">Form sent</th><th class="num">Form filled</th><th class="num">Qualified</th><th class="num">In Recruit</th><th class="num">Qualify rate</th><th>Next step</th></tr></thead>
          <tbody>${d.positions.map(p => `<tr>
            <td><a href="#/applicants?role=${esc(p.id)}"><b>${esc(p.name)}</b></a>
              ${p.setup_missing.length ? `<div class="secondary-text" style="color:var(--bad)">Missing: ${esc(p.setup_missing.join(", "))}</div>` : ""}</td>
            <td class="num"><b>${p.applied}</b></td><td class="num muted">${p.gmail} · ${p.upload} · ${p.walkin}</td><td class="num">${p.form_sent}</td><td class="num">${p.filled}</td><td class="num"><b style="color:var(--good)">${p.qualified}</b></td><td class="num">${p.in_recruit}</td>
            <td class="num">${p.rate == null ? `<span class="muted small">—</span>` : `${p.rate}%`}</td>
            <td>${p.setup_missing.length ? `<a class="btn sm" href="#/positions?id=${esc(p.id)}">Finish setup</a>`
              : p.screen ? `<a class="btn sm primary" href="#/applicants?tab=filled&role=${esc(p.id)}">Screen ${p.screen}</a>`
              : p.send ? `<a class="btn sm primary" href="#/applicants?tab=new&role=${esc(p.id)}">Send form to ${p.send}</a>`
              : `<span class="muted small">All done</span>`}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="card-body"><div class="empty">${I.inbox}<strong>No positions yet</strong>They appear when Gmail brings in their first applicant.</div></div>`}
      </section>
    </div>`;

  $("#home-range").addEventListener("change", e => { prefSet("home-range", e.target.value); location.hash = `#/home?range=${e.target.value}`; });
  $("#add-applicant").addEventListener("click", () => walkinDialog());
  $("#upload-resumes").addEventListener("click", () => uploadDialog());
  $("#fetch-emails").addEventListener("click", () => fetchEmails({}));
  watchProgress(view, renderHome);
}

/* Polls background work (fetch / send / screen) and refreshes the page quietly. */
function watchProgress(view, rerender) {
  clearInterval(ap.poll);
  const tick = async () => {
    if (!view.isConnected || !(location.hash.startsWith("#/home") || location.hash.startsWith("#/applicants") || location.hash === "#/" || location.hash === "")) {
      clearInterval(ap.poll); ap.poll = null; return;
    }
    let p;
    try { p = await api("/api/applicants/progress"); } catch { return; }
    const box = $("#home-progress") || $("#ap-progress");
    const busy = p.queue?.running || p.sender?.running || p.fetch?.running;
    if (box) box.innerHTML = progressCallout(p);
    if (ap.wasBusy && !busy) { ap.wasBusy = false; loadApplicantsBadge(); rerender(view, { quiet: true }); return; }
    ap.wasBusy = busy;
  };
  ap.poll = setInterval(tick, 3000);
  tick();
}

async function loadApplicantsBadge() {
  let d;
  try { d = await api("/api/home?range=all"); } catch { return; }
  const n = d.todo.send + d.todo.no_email + d.todo.screen;
  const badge = $("#applicants-badge");
  if (!badge) return;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = !n;
  badge.title = `${d.todo.send + d.todo.no_email} to send the form · ${d.todo.screen} to screen`;
}

/* ---------------------------------------------------------------- Applicants */

async function renderApplicants(view, { quiet = false } = {}) {
  const p = hashParams();
  if (!quiet) {
    ap.tab = p.get("tab") || ap.tab || "all";
    ap.role = p.has("role") ? p.get("role") : "";
    ap.source = p.has("source") ? p.get("source") : ap.source;
    ap.selected.clear();
    loading(view);
  }
  const qs = new URLSearchParams({ tab: ap.tab, role: ap.role, source: ap.source, q: ap.q, range: ap.range });
  let d;
  try { d = await api(`/api/applicants?${qs}`); } catch (e) { return errorView(view, e.message); }
  ap.data = d;
  const formFor = Object.fromEntries(d.roles.map(r => [r.id, r.form_url]));
  const pickable = a => (a.step === "new" && formFor[a.role_id]) || a.step === "filled" || a.step === "error";
  ap.selected = new Set([...ap.selected].filter(id => d.items.some(a => a.id === id && pickable(a))));

  const action = a => {
    if (a.step === "new") return formFor[a.role_id]
      ? `<button class="btn sm primary" data-send="${esc(a.id)}">Send form</button>`
      : `<a class="btn sm" href="#/positions?id=${esc(a.role_id)}" title="This position has no Google Form yet">Pick a form</a>`;
    if (a.step === "no_email") return `<button class="btn sm" data-dismiss="${a.invite_id}">Dismiss</button>`;
    if (a.step === "filled" || a.step === "error") return `<button class="btn sm primary" data-screen="${esc(a.id)}">${a.step === "error" ? "Screen again" : "Screen"}</button>`;
    if (a.step === "sent") return `<span class="muted small">waiting</span>`;
    if (a.step === "screening") return "";
    return `<a class="btn sm" href="#/applicant/${esc(a.id)}">View</a>`;
  };
  const emailCell = a => (a.invite_id && (a.step === "new" || a.step === "no_email"))
    ? `<input type="email" class="ap-email" data-inv="${a.invite_id}" value="${esc(a.email)}" placeholder="add email…" aria-label="Email for ${esc(a.name)}">`
    : `<span class="secondary-text">${esc(a.email || "")}</span>`;

  view.innerHTML = `
    <div class="page-head"><div><h1>Applicants</h1>
      <div class="sub">Everyone from Gmail, uploads and walk-ins, in one list. Each step has one button.</div></div>
      <div class="head-actions"><button class="btn" id="add-applicant">+ Add walk-in</button>
        <button class="btn" id="upload-resumes">Upload resumes</button>
        <button class="btn primary" id="fetch-emails">Fetch new from Gmail</button></div></div>
    <div class="stack">
      <div id="ap-progress"></div>
      <div class="pill-tabs" role="tablist" aria-label="Step">${AP_TABS.map(([id, label]) => `
        <button class="pill-tab ${ap.tab === id ? "on" : ""}" role="tab" aria-selected="${ap.tab === id}" data-tab="${id}">${label}
          <span class="pill-count">${d.counts[id] ?? 0}</span></button>`).join("")}</div>
      <div class="filters">
        <label class="search-box">${I.search}<input type="search" id="ap-q" placeholder="Search name or email" aria-label="Search applicants" value="${esc(ap.q)}"></label>
        <select id="ap-role" aria-label="Position"><option value="">All positions</option>${d.roles.map(r => `<option value="${esc(r.id)}" ${r.id === ap.role ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
        <select id="ap-source" aria-label="Source"><option value="">All sources</option>${SOURCES.map(([v, l]) => `<option value="${v}" ${v === ap.source ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select id="ap-range" aria-label="Applied">${[["all", "Any time"], ...RANGES.filter(r => r[0] !== "all")].map(([v, l]) => `<option value="${v}" ${v === ap.range ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div id="ap-bulk"></div>
      <section class="card">${d.items.length ? `<div class="table-wrap"><table class="ap-table">
        <thead><tr><th class="check"><input type="checkbox" id="ap-all" aria-label="Select all"></th>
          <th>Applicant</th><th>Position</th><th>Step</th><th>Applied</th><th class="right">Next</th></tr></thead>
        <tbody>${d.items.map(a => `<tr class="${ap.selected.has(a.id) ? "selected" : ""}">
          <td class="check">${pickable(a) ? `<input type="checkbox" data-pick="${esc(a.id)}" ${ap.selected.has(a.id) ? "checked" : ""} aria-label="Select ${esc(a.name)}">` : ""}</td>
          <td><a class="primary-text" href="#/applicant/${esc(a.id)}">${esc(a.name)}</a>${a.source === "walkin" ? ` <span class="tag">Walk-in</span>` : a.source === "upload" ? ` <span class="tag">Uploaded</span>` : ` <span class="tag blue">Gmail</span>`}<div>${emailCell(a)}</div></td>
          <td class="small">${esc(a.position)}</td>
          <td>${stepPill(a)}<div class="secondary-text">${esc(stepNote(a))}</div></td>
          <td class="muted small nowrap">${esc(shortDate(a.applied_at))}</td>
          <td class="right nowrap">${action(a)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">${I.inbox}<strong>${ap.q || ap.role ? "No applicants match" : ap.tab === "all" ? "No applicants yet" : "Nobody at this step"}</strong>
            ${ap.tab === "all" && !ap.q ? "Click <b>Fetch new from Gmail</b> to bring in applications, or <b>+ Add applicant</b> for a walk-in." : ""}</div>`}
      </section>
      <div class="muted small" style="text-align:right"><a href="#/applicants?tab=dismissed" id="ap-dismissed">Dismissed applicants</a></div>
    </div>`;

  const renderBulk = () => {
    const chosen = d.items.filter(a => ap.selected.has(a.id));
    const toSend = chosen.filter(a => a.step === "new"), toScreen = chosen.filter(a => a.step === "filled" || a.step === "error");
    $("#ap-bulk").innerHTML = chosen.length ? `<div class="bulk-bar"><b>${chosen.length} selected</b><span style="flex:1"></span>
      <button class="btn ghost-dark" id="bulk-clear">Clear</button>
      ${toSend.length ? `<button class="btn primary" id="bulk-send">Send Google Form to ${toSend.length}</button>` : ""}
      ${toScreen.length ? `<button class="btn primary" id="bulk-screen">Screen ${toScreen.length}</button>` : ""}</div>` : "";
    $$("tr", view).forEach(tr => { const cb = $("[data-pick]", tr); if (cb) tr.classList.toggle("selected", cb.checked); });
    const all = $("#ap-all");
    if (all) { const picks = $$("[data-pick]", view); all.checked = picks.length > 0 && picks.every(x => x.checked); all.disabled = !picks.length; }
    $("#bulk-clear")?.addEventListener("click", () => { ap.selected.clear(); $$("[data-pick]", view).forEach(x => { x.checked = false; }); renderBulk(); });
    $("#bulk-send")?.addEventListener("click", async () => { if (await sendForms(toSend.map(a => a.id))) { ap.selected.clear(); ap.wasBusy = true; renderApplicants(view, { quiet: true }); } });
    $("#bulk-screen")?.addEventListener("click", async () => { if (await screenApplicants(toScreen.map(a => a.id))) { ap.selected.clear(); ap.wasBusy = true; renderApplicants(view, { quiet: true }); } });
  };
  renderBulk();

  const go = () => { ap.selected.clear(); renderApplicants(view, { quiet: true }); };
  $$("[data-tab]", view).forEach(b => b.addEventListener("click", () => { ap.tab = b.dataset.tab; go(); }));
  $("#ap-role").addEventListener("change", e => { ap.role = e.target.value; go(); });
  $("#ap-range").addEventListener("change", e => { ap.range = e.target.value; go(); });
  $("#ap-source").addEventListener("change", e => { ap.source = e.target.value; go(); });
  let qTimer;
  $("#ap-q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { ap.q = e.target.value.trim(); go(); }, 300); });
  $("#ap-dismissed").addEventListener("click", e => { e.preventDefault(); ap.tab = "dismissed"; go(); });
  $("#add-applicant").addEventListener("click", () => walkinDialog(ap.role || undefined));
  $("#upload-resumes").addEventListener("click", () => uploadDialog(ap.role || ""));
  $("#fetch-emails").addEventListener("click", () => fetchEmails({}));
  $$("[data-pick]", view).forEach(cb => cb.addEventListener("change", () => { cb.checked ? ap.selected.add(cb.dataset.pick) : ap.selected.delete(cb.dataset.pick); renderBulk(); }));
  $("#ap-all")?.addEventListener("change", e => { $$("[data-pick]", view).forEach(x => { x.checked = e.target.checked; e.target.checked ? ap.selected.add(x.dataset.pick) : ap.selected.delete(x.dataset.pick); }); renderBulk(); });
  $$("[data-send]", view).forEach(b => b.addEventListener("click", async () => { if (await sendForms([b.dataset.send])) { ap.wasBusy = true; renderApplicants(view, { quiet: true }); } }));
  $$("[data-screen]", view).forEach(b => b.addEventListener("click", async () => { if (await screenApplicants([b.dataset.screen])) { ap.wasBusy = true; renderApplicants(view, { quiet: true }); } }));
  $$("[data-dismiss]", view).forEach(b => b.addEventListener("click", async () => {
    try { await api(`/api/invites/${b.dataset.dismiss}`, { method: "PATCH", body: { dismiss: true } }); toast("Dismissed"); }
    catch (e) { toast(e.message, "error"); }
    renderApplicants(view, { quiet: true }); loadApplicantsBadge();
  }));
  $$(".ap-email", view).forEach(input => {
    const before = input.value.trim();
    const commit = async () => {
      const v = input.value.trim();
      if (v === before) return;
      try { await api(`/api/invites/${input.dataset.inv}`, { method: "PATCH", body: { email: v } }); toast(v ? "Email saved" : "Email cleared", "success"); }
      catch (e) { toast(e.message, "error"); }
      renderApplicants(view, { quiet: true }); loadApplicantsBadge();
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  });
  watchProgress(view, renderApplicants);
}

/* ---------------------------------------------------------------- Applicant (one person) */

async function renderApplicant(view, id) {
  loading(view);
  let a;
  try { a = await api(`/api/applicants/${encodeURIComponent(id)}`); } catch (e) { return errorView(view, e.message); }
  const done = (on, title, when, note) => `<li class="${on ? "done" : ""}"><span class="dot-step">${on ? "✓" : ""}</span>
    <div><b>${esc(title)}</b>${when || note ? `<div class="secondary-text">${esc([when ? `${shortDate(when)} ${new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "", note].filter(Boolean).join(" · "))}</div>` : ""}</div></li>`;
  const screened = a.step === "qualified" || a.step === "not_qualified";
  const steps = a.source === "walkin" ? [
    done(true, "Added as walk-in", a.applied_at, "by HR"),
    done(screened, screened ? `Screened: ${a.band || ""} ${a.score != null ? Math.round(a.score) : ""}` : "Screening", a.screened_at, "resume + HR notes"),
  ] : [
    done(true, a.source === "upload" ? "Resume uploaded" : "Applied", a.applied_at, a.source === "upload" ? "uploaded from the app" : "resume fetched from Gmail"),
    done(!!a.sent_at || ["sent", "filled", "screening", "qualified", "not_qualified"].includes(a.step), "Google Form sent", a.sent_at, a.email),
    done(!!a.form_filled_at, a.form_filled_at ? "Form filled" : "Form not filled yet", a.form_filled_at, a.form?.matched_by ? `matched by ${a.form.matched_by}` : ""),
    done(screened, screened ? `Screened: ${a.band || ""} ${a.score != null ? Math.round(a.score) : ""}` : "Not screened yet", a.screened_at, ""),
    done(a.recruit_status === "saved", a.step === "not_qualified" ? "Not sent to Zoho Recruit" : "Added to Zoho Recruit", a.recruit_status === "saved" ? a.screened_at : "", ""),
  ];
  const next = a.step === "new" ? `<button class="btn primary" id="ap-next" data-do="send">Send Google Form</button>`
    : (a.step === "filled" || a.step === "error") ? `<button class="btn primary" id="ap-next" data-do="screen">Screen now</button>` : "";

  view.innerHTML = `
    <a class="back-link" href="#/applicants">‹ All applicants</a>
    <div class="stack">
      <section class="card"><div class="card-body applicant-head">
        <div class="avatar" aria-hidden="true">${esc((a.name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase())}</div>
        <div style="flex:1 1 300px;min-width:0"><h1 style="margin:0">${esc(a.name)}</h1>
          <div class="sub">${esc(a.position)} · ${a.source === "walkin" ? "walk-in" : a.source === "upload" ? "uploaded" : "applied via Gmail"} ${esc(shortDate(a.applied_at))}</div>
          <div class="secondary-text">${esc(a.email || "no email")}</div></div>
        ${a.score != null ? `<div class="score-box ${a.band === "High" ? "hi" : a.band === "Medium" ? "mid" : "lo"}"><b>${Math.round(a.score)}</b><span>${esc(a.band)} · ${esc(a.step_label)}</span></div>` : `<div>${stepPill(a)}</div>`}
        <div class="head-actions">${a.file_name ? "" : ""}${next}</div>
      </div></section>
      <div class="detail-grid">
        <section class="card"><div class="card-head"><h2>Journey</h2></div><div class="card-body"><ol class="journey">${steps.join("")}</ol></div></section>
        <div class="stack" id="ap-right">
          ${!a.screening && a.form ? formAnswersHtml(a.form) : ""}
          ${!a.screening && !a.form ? `<section class="card"><div class="card-body"><div class="empty">${I.inbox}<strong>Not screened yet</strong>${a.step === "sent" ? "Waiting for the Google Form." : "The score and summary appear here after screening."}</div></div></section>` : ""}
        </div>
      </div>
    </div>`;

  if (a.screening) {
    const box = document.createElement("div");
    box.innerHTML = candidateHtml({ ...a.screening, walkin: a.walkin });
    $(".d-head", box)?.remove();
    $("#ap-right").innerHTML = box.querySelector(".d-body")?.innerHTML || "";
  }
  $("#ap-next")?.addEventListener("click", async e => {
    const ok = e.target.dataset.do === "send" ? await sendForms([a.id]) : await screenApplicants([a.id]);
    if (ok) setTimeout(() => renderApplicant(view, id), 1500);
  });
}

/* ---------------------------------------------------------------- Positions (set up once) */

async function renderPositions(view) {
  loading(view);
  let d;
  try { d = await api("/api/roles"); } catch (e) { return errorView(view, e.message); }
  const openId = hashParams().get("id") || "";
  const setup = r => [["Job description", r.has_jd], [r.form_name ? `Form: ${r.form_name}` : "Google Form", !!r.form_url], ["Response sheet", !!r.form_sheet_url]];
  const nSet = r => setup(r).filter(x => x[1]).length;
  const roles = d.roles.slice().sort((x, y) => nSet(x) - nSet(y) || x.name.localeCompare(y.name));

  view.innerHTML = `
    <div class="page-head"><div><h1>Positions</h1>
      <div class="sub">One WorkDrive folder per position. Gmail files each application into the folder named after the job post
        (it's created the first time). Pick a job description and a Google Form for each.</div></div>
      <div class="head-actions"><a class="btn" href="#/forms">Manage Google Forms</a><a class="btn" href="#/files">Browse files</a></div></div>
    <div class="stack">
      ${roles.length ? `<section class="pos-grid">${roles.map(r => {
        const n = nSet(r), ready = n === 3;
        return `<div class="pos-card ${r.id === openId ? "open" : ""}">
          <div class="pos-card-top"><b>${esc(r.name)}</b><span class="tag ${ready ? "good" : "warn"}">${ready ? "Ready" : `${n} of 3 set`}</span></div>
          <ul class="pos-checks">${setup(r).map(([label, okv]) => `<li class="${okv ? "ok" : ""}">${okv ? "✓" : "○"} ${esc(label)}</li>`).join("")}</ul>
          <div class="pos-card-actions"><a class="btn ${ready ? "" : "primary"}" href="#/positions?id=${esc(r.id)}">${ready ? "Edit" : "Finish setup"}</a>
            <button class="btn ghost sm" data-del-pos="${esc(r.id)}" title="Delete this position folder" aria-label="Delete ${esc(r.name)}">${I.trash}</button></div></div>`;
      }).join("")}</section>` : `<div class="card"><div class="card-body"><div class="empty">${I.inbox}<strong>No positions yet</strong>They appear when Gmail brings in their first applicant.</div></div></div>`}
      <div id="pos-editor"></div>
    </div>`;
  $$("[data-del-pos]", view).forEach(b => b.addEventListener("click", () => deletePosition(b.dataset.delPos, view)));
  if (openId) {
    const role = d.roles.find(r => r.id === openId);
    if (role) positionEditor(role, () => renderPositions(view), view);
  }
}

/* Loads the folder's contents (for the resume count) and asks before trashing it. */
async function deletePosition(id, view) {
  let data;
  try { data = await api(`/api/browse?live=1&folder_id=${encodeURIComponent(id)}`); } catch (e) { return toast(e.message, "error"); }
  deleteFolderDialog(data, () => { if (location.hash.startsWith("#/positions?")) location.hash = "#/positions"; else renderPositions(view); });
}

async function positionEditor(role, onSaved, view) {
  const box = $("#pos-editor");
  box.innerHTML = `<section class="card"><div class="card-body"><span class="spinner"></span> Loading…</div></section>`;
  let jd, inv, fm;
  try {
    [jd, inv, fm] = await Promise.all([api(`/api/roles/${encodeURIComponent(role.id)}/jd`),
      api(`/api/roles/${encodeURIComponent(role.id)}/invite`), api("/api/forms")]);
  } catch (e) { box.innerHTML = ""; return toast(e.message, "error"); }
  const subject = inv.invite_subject || inv.default_subject, body = inv.invite_body || inv.default_body;
  const preview = (body || "").replaceAll("{first_name}", "Asha").replaceAll("{name}", "Asha Verma")
    .replaceAll("{position}", role.name).replaceAll("{form_link}", inv.form_url || "[form link]");
  const stepNum = (okv, n) => `<span class="setup-num ${okv ? "ok" : ""}">${okv ? "✓" : n}</span>`;
  const formInfo = id => {
    const f = fm.forms.find(x => String(x.id) === String(id));
    if (!f) return `<span class="muted small">No form: applicants of this position can't be sent one.</span>`;
    return `<div class="form-links">
      <span>${f.form_url ? `✓ Form link · ${link(f.form_url, "open")}` : `<span style="color:var(--bad)">○ no form link</span>`}</span>
      <span>${f.sheet_url ? `✓ Response sheet · ${link(f.sheet_url, "open")}` : `<span style="color:var(--bad)">○ no response sheet</span>`}</span>
      ${f.positions.length > 1 || (f.positions.length === 1 && f.positions[0].id !== role.id) ? `<span class="muted">Also used by ${esc(f.positions.filter(p => p.id !== role.id).map(p => p.name).join(", "))}</span>` : ""}</div>`;
  };
  box.innerHTML = `<section class="card" id="pos-edit-card"><div class="card-head"><h2>Set up: ${esc(role.name)}</h2>
      <a class="small" href="#/folder/${esc(role.id)}"><b>Open files</b></a></div>
    <div class="card-body setup-steps">
      <div class="setup-step">${stepNum(!!(jd.jd_text || "").trim(), 1)}<div>
        <label for="ps-jd">Job description</label><div class="help">Every applicant is scored against this.</div>
        <textarea id="ps-jd" rows="6" placeholder="Paste the job description…">${esc(jd.jd_text || "")}</textarea></div></div>
      <div class="setup-step">${stepNum(!!(role.form_url && role.form_sheet_url), 2)}<div>
        <label for="ps-form">Google Form</label>
        <div class="help">Form links and response sheets are kept in one place, the <a href="#/forms"><b>Forms</b></a> page; one form can serve many positions.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="ps-form" style="min-width:240px"><option value="">— No form —</option>${fm.forms.map(f => `<option value="${f.id}" ${f.id === role.form_id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>
          <button class="btn" id="ps-new-form" type="button">+ New form</button></div>
        <div id="ps-form-info" style="margin-top:8px">${formInfo(role.form_id)}</div></div></div>
      <div class="setup-step"><span class="setup-num ok">✓</span><div>
        <label>Email to applicants</label><div class="help">${inv.invite_subject || inv.invite_body ? "Your own text." : "The standard text."} What the applicant sees:</div>
        <div class="mail-preview"><div class="muted small">From: ${esc(inv.from)}</div>
          <div style="font-weight:900;margin:4px 0 8px">${esc(subject.replaceAll("{position}", role.name))}</div>
          <div style="white-space:pre-line">${esc(preview)}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" id="ps-template">Edit text / send a test</button></div></div></div>
    </div>
    <div class="card-foot"><button class="btn danger-ghost" id="ps-delete">${I.trash} Delete position folder…</button><span style="flex:1"></span>
      <a class="btn" href="#/positions">Close</a><button class="btn primary" id="ps-save">Save</button></div></section>`;
  $("#pos-edit-card").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#ps-form").addEventListener("change", e => { $("#ps-form-info").innerHTML = formInfo(e.target.value); });
  $("#ps-new-form").addEventListener("click", () => formDialog(null, fm.positions, saved => {
    toast(`Form "${saved.name}" added`, "success");
    onSaved();
  }, [role.id]));
  $("#ps-template").addEventListener("click", () => inviteDialog(role, onSaved));
  $("#ps-delete").addEventListener("click", () => deletePosition(role.id, view));
  $("#ps-save").addEventListener("click", async () => {
    const btn = $("#ps-save");
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving…`;
    const jdText = $("#ps-jd").value.trim(), formId = $("#ps-form").value;
    const errors = [];
    try {
      if (jdText !== (jd.jd_text || "").trim()) await api(`/api/roles/${encodeURIComponent(role.id)}/jd`, { method: "PUT", body: { jd_text: jdText } });
    } catch (e) { errors.push(`Job description: ${e.message}`); }
    try {
      if (String(formId) !== String(role.form_id || "")) await api(`/api/roles/${encodeURIComponent(role.id)}/form`, { method: "PUT", body: { form_id: formId ? Number(formId) : null } });
    } catch (e) { errors.push(`Google Form: ${e.message}`); }
    if (errors.length) { errors.forEach(m => toast(m, "error")); btn.disabled = false; btn.textContent = "Save"; return; }
    toast(`${role.name} saved`, "success");
    onSaved();
  });
}

/* ---------------------------------------------------------------- Google Forms (one place for every form) */

async function renderForms(view) {
  loading(view);
  let d;
  try { d = await api("/api/forms"); } catch (e) { return errorView(view, e.message); }
  const without = d.positions.filter(p => !p.form_id || !d.forms.some(f => f.id === p.form_id));
  view.innerHTML = `
    <div class="page-head"><div><h1>Google Forms</h1>
      <div class="sub">Add each Google Form once, with its link and its responses sheet, then pick the positions that use it.
        One form can serve many positions.</div></div>
      <div class="head-actions"><button class="btn primary" id="add-form">+ Add form</button></div></div>
    <div class="stack">
      ${without.length ? `<div class="callout warn"><div><b>${plural(without.length, "position")} without a form:</b> ${esc(without.map(p => p.name).join(", "))}.
        Applicants for these can't be sent a form until you assign one.</div></div>` : ""}
      ${d.forms.length ? `<section class="form-list">${d.forms.map(f => `
        <div class="card form-card"><div class="card-head"><h2>${esc(f.name)}</h2>
            <span class="tag ${f.form_url && f.sheet_url ? "good" : "warn"}">${f.form_url && f.sheet_url ? "Ready" : f.form_url ? "No response sheet" : "No form link"}</span></div>
          <div class="card-body">
            <dl class="form-dl">
              <dt>Form link</dt><dd>${f.form_url ? link(f.form_url, f.form_url) : `<span class="muted">not set</span>`}</dd>
              <dt>Responses sheet</dt><dd>${f.sheet_url ? link(f.sheet_url, "open the sheet") : `<span class="muted">not set: the app can't tell who filled it</span>`}</dd>
              <dt>Used by</dt><dd>${f.positions.length ? f.positions.map(p => `<a class="chip" href="#/positions?id=${esc(p.id)}">${esc(p.name)}</a>`).join(" ") : `<span class="muted">no position yet</span>`}</dd>
            </dl></div>
          <div class="card-foot"><button class="btn danger-ghost" data-del-form="${f.id}">${I.trash} Remove</button><span style="flex:1"></span>
            <button class="btn primary" data-edit-form="${f.id}">Edit / assign positions</button></div></div>`).join("")}</section>`
      : `<div class="card"><div class="card-body"><div class="empty">${I.inbox}<strong>No forms yet</strong>Click <b>+ Add form</b>, paste the form link and its responses sheet, and tick the positions that use it.</div></div></div>`}
    </div>`;
  const reload = () => renderForms(view);
  $("#add-form").addEventListener("click", () => formDialog(null, d.positions, f => { toast(`Form "${f.name}" added`, "success"); reload(); }));
  $$("[data-edit-form]", view).forEach(b => b.addEventListener("click", () =>
    formDialog(d.forms.find(f => f.id === Number(b.dataset.editForm)), d.positions, f => { toast(`Form "${f.name}" saved`, "success"); reload(); })));
  $$("[data-del-form]", view).forEach(b => b.addEventListener("click", async () => {
    const f = d.forms.find(x => x.id === Number(b.dataset.delForm));
    if (!confirm(`Remove the form "${f.name}" from the app?${f.positions.length ? `\n\n${plural(f.positions.length, "position")} will have no form until you pick another.` : ""}\n\nThe Google Form itself is not touched.`)) return;
    try { await api(`/api/forms/${f.id}`, { method: "DELETE" }); toast(`"${f.name}" removed`, "success"); reload(); }
    catch (e) { toast(e.message, "error"); }
  }));
}

function formDialog(form, positions, onSaved, preselect = []) {
  const f = form || { name: "", form_url: "", sheet_url: "", positions: [] };
  const mine = new Set(form ? f.positions.map(p => p.id) : preselect);
  openModal(`
    <h2>${form ? `Edit form · ${esc(f.name)}` : "Add a Google Form"}</h2>
    <div class="field"><label for="fd-name">Name</label>
      <input type="text" id="fd-name" maxlength="120" value="${esc(f.name)}" placeholder="e.g. Sales form, Tech form"></div>
    <div class="field"><label for="fd-url">Google Form link (sent to applicants)</label>
      <input type="text" id="fd-url" value="${esc(f.form_url || "")}" placeholder="https://forms.gle/…">
      <div class="muted small">In the form click <b>Send</b> → the link icon → Copy.</div></div>
    <div class="field"><label for="fd-sheet">Responses sheet (how the app knows who filled it)</label>
      <input type="text" id="fd-sheet" value="${esc(f.sheet_url || "")}" placeholder="https://docs.google.com/spreadsheets/d/…">
      <div class="muted small">${SHEET_HELP}</div></div>
    <div class="field"><label>Positions that use this form</label>
      ${positions.length ? `<div class="check-list">${positions.map(p => {
        const other = p.form_id && (!form || p.form_id !== form.id);
        return `<label class="check-row"><input type="checkbox" value="${esc(p.id)}" ${mine.has(p.id) ? "checked" : ""}> ${esc(p.name)}
          ${other ? `<span class="muted small">(uses another form now; ticking moves it here)</span>` : ""}</label>`;
      }).join("")}</div>` : `<div class="muted small">No positions yet: they appear when Gmail brings the first applicant.</div>`}</div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="fd-save">${form ? "Save" : "Add form"}</button></div>`, { wide: true });
  $("#fd-name").focus();
  $("#fd-save").addEventListener("click", async () => {
    const b = $("#fd-save"); b.disabled = true; b.innerHTML = `<span class="spinner"></span> Checking the sheet…`;
    try {
      const saved = await api(form ? `/api/forms/${form.id}` : "/api/forms", { method: form ? "PUT" : "POST", body: {
        name: $("#fd-name").value, form_url: $("#fd-url").value.trim(), sheet_url: $("#fd-sheet").value.trim(),
        position_ids: $$("#modal .check-list input:checked").map(i => i.value) } });
      closeModal();
      onSaved(saved);
    } catch (e) { toast(e.message, "error"); b.disabled = false; b.textContent = form ? "Save" : "Add form"; }
  });
}

/* ---------------------------------------------------------------- Upload resumes (date-wise) */

const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const folderLabel = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };

async function uploadDialog(roleId = "") {
  openModal(`<h2>Upload resumes</h2><div class="loading-block" style="padding:30px 0"><span class="spinner"></span> Loading positions…</div>`);
  let roles;
  try { roles = (await api("/api/roles")).roles; } catch (e) { closeModal(); return toast(e.message, "error"); }
  if (!roles.length) { closeModal(); return toast("No positions yet - create a position folder first (Positions → Browse files).", "error"); }
  openModal(`
    <h2>Upload resumes</h2>
    <p class="muted small">Each resume is saved in WorkDrive under the position and date you pick, and becomes an applicant
      (email read from the resume), ready for <b>Send form → Screen</b>.</p>
    <div class="field"><label for="up-role">Position</label>
      <select id="up-role">${roles.map(r => `<option value="${esc(r.id)}" ${r.id === roleId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>
    <div class="field"><label for="up-date">Date</label>
      <input type="date" id="up-date" value="${isoToday()}" max="${isoToday()}"></div>
    <div class="field"><label for="up-files">Resumes (.pdf or .docx, up to 50)</label>
      <input type="file" id="up-files" multiple accept=".pdf,.docx"></div>
    <div class="callout info" id="up-where"><div></div></div>
    <div id="up-status" class="muted small" aria-live="polite"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="up-go" disabled>Upload</button></div>`);
  const where = () => {
    const r = roles.find(x => x.id === $("#up-role").value), date = $("#up-date").value || isoToday();
    const n = $("#up-files").files.length;
    $("#up-where div").innerHTML = `Saved to WorkDrive: <b>${esc(r?.name || "")} / ${esc(folderLabel(date))}</b>${n ? ` · ${plural(n, "file")} selected` : ""}`;
    $("#up-go").disabled = !n;
    $("#up-go").textContent = n ? `Upload ${plural(n, "resume")}` : "Upload";
  };
  ["#up-role", "#up-date", "#up-files"].forEach(sel => $(sel).addEventListener("change", where));
  where();
  $("#up-go").addEventListener("click", async () => {
    const files = [...$("#up-files").files];
    if (files.length > 50) return toast("Upload at most 50 resumes at a time.", "error");
    const btn = $("#up-go"), st = $("#up-status");
    btn.disabled = true;
    let ok = 0, noEmail = 0;
    const failed = [];
    for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
      const batch = files.slice(i, i + UPLOAD_BATCH);
      st.innerHTML = `<span class="spinner"></span> Uploading ${Math.min(i + batch.length, files.length)} of ${files.length}…`;
      const form = new FormData();
      form.append("role_id", $("#up-role").value);
      form.append("date", $("#up-date").value || isoToday());
      batch.forEach(f => form.append("files", f));
      try {
        const r = await api("/api/applicants/upload", { method: "POST", body: form });
        r.results.forEach(x => { if (x.ok) { ok++; if (!x.email) noEmail++; } else failed.push(`${x.name}: ${x.error}`); });
      } catch (e) { batch.forEach(f => failed.push(`${f.name}: ${e.message}`)); }
    }
    closeModal();
    if (ok) toast(`${plural(ok, "resume")} uploaded and added to Applicants${noEmail ? ` (${noEmail} without an email - add it there)` : ""}`, "success");
    failed.slice(0, 5).forEach(m => toast(m, "error"));
    loadApplicantsBadge();
    if (ok && !location.hash.startsWith("#/applicants")) location.hash = "#/applicants?tab=new";
    else route();
  });
}

/* ---------------------------------------------------------------- Settings: sender email */

async function renderSettings(view) {
  loading(view);
  let s;
  try { s = await api("/api/settings/email"); } catch (e) { return errorView(view, e.message); }
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Who the Google Form emails come from.</div></div></div>
    <div class="stack">
      <section class="card"><div class="card-head"><h2>Sender email</h2>
          <span class="tag ${s.custom ? "blue" : ""}">${s.custom ? "Custom sender" : "Default sender"}</span></div>
        <div class="card-body" style="max-width:640px">
          <p class="muted small" style="margin-top:0">Applicants see this as the "From" of the Google Form email. Gmail only sends from an
            account it can log into, so a different address needs that account's <b>App Password</b>
            (Google Account → Security → 2-Step Verification → App passwords). It's checked before saving.</p>
          <div class="field"><label for="se-name">Sender name</label>
            <input type="text" id="se-name" value="${esc(s.sender_name)}" placeholder="${esc(s.default_name)}"></div>
          <div class="field"><label for="se-email">Sender email (Gmail or Google Workspace)</label>
            <input type="email" id="se-email" value="${esc(s.sender_email)}" placeholder="${esc(s.default_email)}"></div>
          <div class="field"><label for="se-pass">App Password for this email</label>
            <input type="password" id="se-pass" autocomplete="new-password" placeholder="${s.custom && s.has_password ? "saved - leave empty to keep it" : "16 letters, e.g. abcd efgh ijkl mnop"}">
            <span class="help">${s.custom ? "" : `Not needed for ${esc(s.default_email)} (already set on the server).`}</span></div>
          <div class="field"><label for="se-reply">Replies go to (optional)</label>
            <input type="email" id="se-reply" value="${esc(s.reply_to)}" placeholder="e.g. hr@yourcompany.com"></div>
          <div class="callout info"><div>Fetching applications still reads the inbox <b>${esc(s.fetch_inbox)}</b>. This setting only changes who the invites are sent from.</div></div>
        </div>
        <div class="card-foot">
          ${s.custom ? `<button class="btn" id="se-reset">Use default (${esc(s.default_email)})</button><span style="flex:1"></span>` : ""}
          <button class="btn" id="se-test">Send a test to the sender</button>
          <button class="btn primary" id="se-save">Save</button></div>
      </section>
    </div>`;
  const busy = (b, on, label) => { b.disabled = on; b.innerHTML = on ? `<span class="spinner"></span> ${label}` : label; };
  $("#se-save").addEventListener("click", async () => {
    const b = $("#se-save"); busy(b, true, "Checking login…");
    try {
      const r = await api("/api/settings/email", { method: "PUT", body: {
        sender_email: $("#se-email").value.trim() || s.default_email, sender_name: $("#se-name").value.trim(),
        reply_to: $("#se-reply").value.trim(), app_password: $("#se-pass").value } });
      toast(`Invites will be sent from ${r.sender_name} <${r.sender_email}>`, "success");
      renderSettings(view);
    } catch (e) { toast(e.message, "error"); busy(b, false, "Save"); }
  });
  $("#se-test").addEventListener("click", async () => {
    const b = $("#se-test"); busy(b, true, "Sending…");
    try { const r = await api("/api/settings/email/test", { method: "POST" }); toast(`Test email sent to ${r.sent_to}`, "success"); }
    catch (e) { toast(e.message, "error"); }
    busy(b, false, "Send a test to the sender");
  });
  $("#se-reset")?.addEventListener("click", async () => {
    if (!confirm(`Send invites from ${s.default_email} again?`)) return;
    try { await api("/api/settings/email", { method: "PUT", body: { reset: true } }); toast("Back to the default sender", "success"); renderSettings(view); }
    catch (e) { toast(e.message, "error"); }
  });
}

/* ---------------------------------------------------------------- boot (last, so every function and const above exists) */

loadStatus().then(() => { if (state.folder && $("#resume-rows")) renderResumeRows(); });
route();
loadNotifications();
loadInviteBadge();
loadApplicantsBadge();
setInterval(loadStatus, 60000);
setInterval(loadNotifications, 60000);
setInterval(loadInviteBadge, 60000);
setInterval(loadApplicantsBadge, 60000);
