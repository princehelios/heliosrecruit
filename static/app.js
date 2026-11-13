"use strict";

/* ==========================================================================
   Resume Screener UI (simple)
   Routes:  #/dashboard        totals, per-position stats, resumes not in Recruit
            #/                 positions (role folders)
            #/folder/<id>      position or date folder: JD, resumes, screen
            #/candidates       screened candidates
            #/pending          resumes waiting for the Google Form
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
};

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
  const nav = hash.startsWith("#/dashboard") ? "dashboard" : hash.startsWith("#/candidates") ? "candidates"
    : hash.startsWith("#/pending") ? "pending" : hash.startsWith("#/sheets") ? "sheets"
    : (hash.startsWith("#/log") || hash.startsWith("#/run/")) ? "log" : "screen";
  $$(".nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
  window.scrollTo(0, 0);

  if (nav === "dashboard") return renderDashboard(view);
  if (nav === "candidates") return renderCandidates(view);
  if (nav === "pending") return renderPending(view);
  if (nav === "sheets") return renderSheets(view);
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

async function renderFolder(view, folderId, { quiet = false } = {}) {
  if (!quiet) loading(view);
  let data;
  try { data = await api(`/api/browse${folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ""}`); }
  catch (e) { return errorView(view, e.message); }

  if (!state.folder || state.folder.folder.id !== data.folder.id) state.selected.clear();
  if (state.list.folderId !== data.folder.id) state.list = { folderId: data.folder.id, q: "", filter: "all", page: 1 };
  const ids = new Set(data.files.map(f => f.id));
  state.selected = new Set([...state.selected].filter(id => ids.has(id)));
  state.folder = data;

  view.innerHTML = data.depth === 0 ? rootHtml(data) : folderHtml(data);
  bindFolder(view, data);
  if (data.active_run_id) { startPolling(data.active_run_id, data.folder.id); renderSelectBar(); }
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

function rootHtml(data) {
  return `<div class="page-head"><div><h1>Positions</h1><div class="sub">Most recently active first.</div></div>
      <div class="head-actions">
        ${data.subfolders.length > 6 ? `<input type="search" id="pos-q" placeholder="Search positions" aria-label="Search positions">` : ""}
        <button class="btn" id="add-walkin">+ Add walk-in</button>
        <button class="btn" id="fetch-emails">Fetch from email</button>
        <button class="btn primary" id="new-folder" data-label="position">+ New position</button>
      </div></div>
    ${data.subfolders.length ? folderGrid(data.subfolders, 0) + `<div class="empty hidden" id="pos-none">No positions match.</div>`
      : `<div class="card"><div class="empty">${I.inbox}<strong>No positions yet</strong>Click + New position, or create folders like "Full Stack" in the WorkDrive resumes folder.</div></div>`}`;
}

function folderHtml(data) {
  const crumbs = data.path.map((p, i) => {
    const last = i === data.path.length - 1;
    const label = i === 0 ? "Positions" : esc(p.name);
    return (i ? `<span class="sep">/</span>` : "") + (last ? `<span class="current">${label}</span>` : `<a href="${i === 0 ? "#/" : `#/folder/${esc(p.id)}`}">${label}</a>`);
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

  if (data.depth === 0) {
    $("#pos-q")?.addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      $$(".folder-card", view).forEach(c => { const hit = !q || c.dataset.name.includes(q); c.hidden = !hit; shown += hit; });
      $("#pos-none")?.classList.toggle("hidden", shown > 0);
    });
    return;
  }

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
    reset();
    if (location.hash === "#/" || location.hash === "") route();
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
      location.hash = `#/folder/${res.folder_id}`;
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
      <div class="sub">One Google Form response sheet per position. Resumes are matched to responses by email or phone before scoring.</div></div></div>
    <div class="stack">
      <div class="callout info">${I.warn}<div>${SHEET_HELP}</div></div>
      <section class="card">${data.roles.length ? `<div class="table-wrap"><table class="sheets-table">
        <thead><tr><th>Position</th><th>Response sheet link</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.roles.map(r => `<tr data-role="${esc(r.id)}">
          <td><a href="#/folder/${esc(r.id)}"><b>${esc(r.name)}</b></a>${r.has_jd ? "" : `<div class="secondary-text">no job description yet</div>`}</td>
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

function deleteFolderDialog(data) {
  const f = data.folder;
  const inside = data.files.length + data.subfolders.reduce((n, s) => n + (s.resume_count || 0), 0);
  openModal(`
    <h2>Delete folder "${esc(f.name)}"?</h2>
    <p>The folder${inside ? ` and the <b>${plural(inside, "resume")}</b> in it` : ""}${data.subfolders.length ? ` (including ${plural(data.subfolders.length, "subfolder")})` : ""} move to the WorkDrive trash, restorable for 30 days.</p>
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
      toast(`"${f.name}" moved to WorkDrive trash`, "success");
      location.hash = data.depth <= 1 ? "#/" : `#/folder/${out.parent_id}`;
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
}

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

loadStatus().then(() => { if (state.folder && $("#resume-rows")) renderResumeRows(); });
route();
loadNotifications();
setInterval(loadStatus, 60000);
setInterval(loadNotifications, 60000);
