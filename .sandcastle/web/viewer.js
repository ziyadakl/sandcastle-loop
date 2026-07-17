// @ts-nocheck
/**
 * Runtime wiring for the Sandcastle lite web viewer.
 *
 * The ONLY impure layer: polls status.json, calls the pure `buildViewModel`, and
 * patches the static skeleton's slots (see the SLOT CONTRACT comment in
 * index.html). No fusion/formatting logic here — that all lives in view-model.js.
 *
 * Resilience rules:
 *  - A fetch/parse failure NEVER blanks the last good render; it shows a small,
 *    unobtrusive "can't reach status — retrying" note and keeps polling.
 *  - No schema-version gate: whatever buildViewModel returns is rendered.
 */
import { buildViewModel } from "./view-model.js";

const POLL_MS = 2000;

/**
 * Where to read the snapshot. Default `../status.json` resolves to the sibling
 * of the `web/` dir (the deploy serves root at `.sandcastle/`, so /web/index.html
 * → /status.json). Override with `?status=<url>` for local testing (e.g. a
 * status.json placed next to index.html: `?status=status.json`).
 */
const STATUS_URL =
  new URLSearchParams(location.search).get("status") || "../status.json";

/** phase/attention → badge tone. */
function phaseTone(phase, attention) {
  if (attention || phase === "needs-human") return "warning";
  if (phase === "merged") return "success";
  if (phase === "reviewer" || phase === "merge") return "info";
  return "gray";
}

const $ = (id) => document.getElementById(id);
function clone(tplId) {
  return $(tplId).content.firstElementChild.cloneNode(true);
}
function setText(el, text) {
  if (el) el.textContent = text;
}
function show(el, on) {
  if (el) el.hidden = !on;
}

function renderHostsStrip(hosts) {
  const strip = $("hosts-strip");
  strip.replaceChildren();
  for (const h of hosts) {
    const dot = clone("tpl-host-dot");
    dot.classList.toggle("is-live", !h.stale);
    dot.classList.toggle("is-stale", h.stale);
    dot.title = h.stale ? `${h.label} — stale` : `${h.label} — live`;
    setText(dot.querySelector(".host-dot__label"), h.label);
    strip.appendChild(dot);
  }
}

function renderBanner(banner) {
  const el = $("banner");
  el.dataset.kind = banner.kind;
  show($("banner-dot"), !!banner.live);
  setText($("banner-text"), banner.text);
  setText($("banner-activity"), banner.activity ? ` · ${banner.activity}` : "");
}

function renderMeta(meta) {
  const line = meta.perMachine
    .map((m) => `${m.label} ${m.current}/${m.total}`)
    .join(" · ");
  setText($("meta-iterations"), line || "—");
  setText($("meta-branch"), meta.branch || "—");
}

function renderPills(pills) {
  const box = $("pills");
  box.replaceChildren();
  for (const p of pills) {
    const el = clone("tpl-pill");
    el.dataset.tone = p.tone;
    setText(el.querySelector(".pill__count"), String(p.count));
    setText(el.querySelector(".pill__label"), p.label);
    box.appendChild(el);
  }
}

function renderIssueRow(row, { recent }) {
  const el = clone("tpl-issue-row");
  el.classList.toggle("is-attention", !!row.attention);
  setText(el.querySelector(".issue-row__num"), `#${row.number}`);

  const host = el.querySelector(".issue-row__host");
  if (row.hostLabel) {
    setText(host, row.hostLabel);
    show(host, true);
  } else {
    show(host, false);
  }

  setText(el.querySelector(".issue-row__title"), row.title);

  const detail = el.querySelector(".issue-row__detail");
  if (row.detail) {
    setText(detail, row.detail);
    show(detail, true);
  } else {
    show(detail, false);
  }

  const age = el.querySelector(".issue-row__age");
  if (recent && row.age) {
    setText(age, row.age);
    show(age, true);
  } else {
    show(age, false);
  }

  const phase = el.querySelector(".issue-row__phase");
  setText(phase, row.phaseLabel);
  phase.dataset.tone = phaseTone(row.phase, row.attention);
  return el;
}

function renderList(containerId, emptyId, rows, opts) {
  const box = $(containerId);
  box.replaceChildren();
  for (const row of rows) box.appendChild(renderIssueRow(row, opts));
  show($(emptyId), rows.length === 0);
}

function render(vm, snap) {
  setText($("run-title"), snap?.run?.repo || "Sandcastle");
  document.title = snap?.run?.repo
    ? `${snap.run.repo} · Sandcastle`
    : "Sandcastle";
  renderHostsStrip(vm.hosts);
  renderBanner(vm.banner);
  renderMeta(vm.meta);
  renderPills(vm.pills);
  renderList("active-list", "active-empty", vm.active, { recent: false });
  renderList("recent-list", "recent-empty", vm.recent, { recent: true });
  show($("recent-overflow"), vm.overflowRecent > 0);
  setText($("recent-overflow-count"), String(vm.overflowRecent));
}

// --- connection note: created lazily, never part of the static skeleton so a
//     fetch fault can't blank the last good render. Inline-styled to stay
//     self-contained (no external CSS dependency). ---
let connNote;
function setConnNote(message) {
  if (!connNote) {
    connNote = document.createElement("div");
    connNote.className = "conn-note";
    connNote.setAttribute("role", "status");
    connNote.style.cssText =
      "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);" +
      "background:rgba(239,68,68,0.16);color:#f87171;border:1px solid rgba(239,68,68,0.3);" +
      "padding:.35rem .7rem;border-radius:.5rem;font-size:.75rem;z-index:10;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;";
    document.body.appendChild(connNote);
  }
  if (message) {
    connNote.textContent = message;
    connNote.hidden = false;
  } else {
    connNote.hidden = true;
  }
}

let rendered = false;

async function tick() {
  try {
    const res = await fetch(`${STATUS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    render(buildViewModel(snap, Date.now()), snap);
    rendered = true;
    setConnNote(null);
  } catch (err) {
    // Keep the last good render; just surface that we're reconnecting.
    setConnNote(
      rendered
        ? "can't reach status — retrying…"
        : "waiting for status… (can't reach status.json yet)",
    );
  }
}

tick();
setInterval(tick, POLL_MS);
