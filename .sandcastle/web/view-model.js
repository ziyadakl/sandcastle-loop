// @ts-nocheck
/**
 * Pure render-model for the Sandcastle lite web viewer.
 *
 * This module runs in the BROWSER (plain ESM, no build step) AND is imported by
 * vitest. It has NO DOM and NO fetch — it turns a parsed `status.json` snapshot
 * into a flat view-model the static page renders. All fusion/formatting logic
 * lives here so it can be unit-tested; `viewer.js` only does fetch + DOM.
 *
 * Field names + fusion semantics mirror T3's `sandcastleView.ts` helpers, and
 * read the v3 snapshot shape from `.sandcastle/lib/status/schema.ts`
 * (`SandcastleStatus` / `PeerStatus`). DESIGN RULE: render defensively — never
 * throw on an unknown field or a newer schemaVersion; show what we understand
 * and ignore the rest. There is deliberately NO schema-version gate (that is the
 * failure class that made T3 blank the screen).
 */

/** Staleness threshold — mirror of STALE_AFTER_MS in lib/status/schema.ts (3 min). */
export const STALE_AFTER_MS = 180_000;

/**
 * hostId → friendly label. T3 has no such map (it only title-cases), so the
 * viewer owns it. Unknown ids fall back to {@link humanizeHostId}.
 */
export const ALIAS_MAP = {
  srv1360790: "VPS",
  "ziyads-macbook-air.local": "Mac",
  "ziyads-macbook-air": "Mac",
  mac: "Mac",
  vps: "VPS",
};

/** phase → display label (mirror of T3 PHASE_LABELS). */
export const PHASE_LABELS = {
  planned: "Planned",
  implementer: "Implementing",
  reviewer: "Reviewing",
  "implementer-retry": "Retry",
  recovery: "Recovery",
  merge: "Merging",
  merged: "Merged",
  "needs-human": "Needs you",
  deferred: "Deferred",
};

/** Phases that put an issue in "Recent" rather than "Active". */
export const TERMINAL_PHASES = new Set(["merged", "needs-human", "deferred"]);

/** Cap for the Recent list. */
export const RECENT_LIMIT = 10;

/**
 * Title-case a raw hostId the way T3 does: split on -_. / whitespace, cap each
 * word. e.g. "ziyads-macbook-air" -> "Ziyads Macbook Air".
 * @param {string} hostId
 * @returns {string}
 */
export function humanizeHostId(hostId) {
  if (!hostId) return "";
  return String(hostId)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Friendly host label: alias map first, else humanize.
 * @param {string} hostId
 * @param {Record<string,string>} [aliasMap]
 * @returns {string}
 */
export function hostLabel(hostId, aliasMap = ALIAS_MAP) {
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, hostId)) {
    return aliasMap[hostId];
  }
  return humanizeHostId(hostId);
}

/**
 * True when `updatedAt` is older than STALE_AFTER_MS relative to nowMs.
 * Defensive: an unparseable/absent timestamp counts as stale.
 * @param {string|undefined} updatedAt ISO-8601
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isStale(updatedAt, nowMs) {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true; // absent/unparseable ⇒ defensively stale
  return nowMs - t > STALE_AFTER_MS;
}

/**
 * Build the flat view-model the static page renders. Pure; never throws on
 * malformed input — returns a safe, minimal model instead.
 *
 * @param {import("../lib/status/schema.js").SandcastleStatus} snap parsed status.json
 * @param {number} nowMs Date.now() at render time (injected for testability)
 * @param {Record<string,string>} [aliasMap]
 * @returns {{
 *   banner: { kind: "no-run"|"live"|"stale"|"done"|"stopped"|"unhealthy", text: string, live: boolean, activity?: string },
 *   multiHost: boolean,
 *   hosts: Array<{ hostId: string, label: string, state: string, updatedAt: string, stale: boolean, lastSeenMs: number }>,
 *   meta: { perMachine: Array<{ label: string, current: number, total: number }>, branch: string },
 *   totals: { merged: number, needsHuman: number, requeued: number, running: number },
 *   pills: Array<{ key: "merged"|"needsHuman"|"requeued", label: string, count: number, tone: "gray"|"success"|"warning"|"info" }>,
 *   active: Array<{ number: number, title: string, phase: string, phaseLabel: string, detail?: string, attention: boolean, hostLabel?: string, hostId: string }>,
 *   recent: Array<{ number: number, title: string, phaseLabel: string, age?: string, hostLabel?: string, hostId: string }>,
 *   overflowRecent: number,
 * }}
 */
/** Empty safe totals. */
function zeroTotals() {
  return { merged: 0, needsHuman: 0, requeued: 0, running: 0 };
}

/** Short relative age string ("30s", "3m", "1h", "2d") or undefined. */
function relativeAge(completedAt, nowMs) {
  const t = Date.parse(completedAt);
  if (Number.isNaN(t)) return undefined;
  const diff = Math.max(0, nowMs - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Banner kind/text/live from run state + own staleness. */
function computeBanner(state, ownStale, activity) {
  let kind;
  if (state === "running") kind = ownStale ? "stale" : "live";
  else if (state === "restarting") kind = "live";
  else if (state === "done") kind = "done";
  else if (state === "stopped") kind = "stopped";
  else if (state === "unhealthy") kind = "unhealthy";
  else kind = "no-run";

  const TEXT = {
    live: "Live",
    stale: "Stale — loop may have stopped",
    done: "Done",
    stopped: "Stopped",
    unhealthy: "Unhealthy — needs attention",
    "no-run": "No run",
  };
  const banner = { kind, text: TEXT[kind], live: kind === "live" };
  if (activity != null) banner.activity = activity;
  return banner;
}

const PILL_SPEC = [
  { key: "merged", label: "merged", tone: "success" },
  { key: "needsHuman", label: "needs you", tone: "warning" },
  { key: "requeued", label: "requeued", tone: "info" },
];

export function buildViewModel(snap, nowMs, aliasMap = ALIAS_MAP) {
  // --- Defensive: a null / structurally-broken snapshot yields a safe model. ---
  if (!snap || typeof snap !== "object" || !snap.hostId || !snap.run) {
    return {
      banner: { kind: "no-run", text: "No run", live: false },
      multiHost: false,
      hosts: [],
      meta: { perMachine: [], branch: "" },
      totals: zeroTotals(),
      pills: PILL_SPEC.map((p) => ({
        key: p.key,
        label: p.label,
        count: 0,
        tone: "gray",
      })),
      active: [],
      recent: [],
      overflowRecent: 0,
    };
  }

  const peers = Array.isArray(snap.peers) ? snap.peers : [];
  const multiHost = peers.length > 0;
  const label = (id) => hostLabel(id, aliasMap);

  // --- hosts: own first, then each peer. ---
  const hostRow = (id, state, updatedAt) => ({
    hostId: id,
    label: label(id),
    state,
    updatedAt,
    stale: isStale(updatedAt, nowMs),
    lastSeenMs: nowMs - Date.parse(updatedAt),
  });
  const hosts = [
    hostRow(snap.hostId, snap.state, snap.updatedAt),
    ...peers.map((p) => hostRow(p.hostId, p.state, p.updatedAt)),
  ];

  // --- banner (keyed to OWN host staleness). ---
  const banner = computeBanner(snap.state, hosts[0].stale, snap.activity);

  // --- meta.perMachine (own + each peer). ---
  const perMachine = [
    {
      label: label(snap.hostId),
      current: snap.run.iterations?.current ?? 0,
      total: snap.run.iterations?.total ?? 0,
    },
    ...peers.map((p) => ({
      label: label(p.hostId),
      current: p.iterations?.current ?? 0,
      total: p.iterations?.total ?? 0,
    })),
  ];

  // --- totals: field-wise sum of own + every peer (ships are disjoint). ---
  const totals = zeroTotals();
  for (const t of [snap.totals, ...peers.map((p) => p.totals)]) {
    if (!t) continue;
    totals.merged += t.merged ?? 0;
    totals.needsHuman += t.needsHuman ?? 0;
    totals.requeued += t.requeued ?? 0;
    totals.running += t.running ?? 0;
  }

  // --- pills. ---
  const pills = PILL_SPEC.map((p) => {
    const count = totals[p.key] ?? 0;
    return {
      key: p.key,
      label: p.label,
      count,
      tone: count === 0 ? "gray" : p.tone,
    };
  });

  // --- active: non-terminal issues across all hosts. ---
  const activeRow = (issue, id) => ({
    number: issue.number,
    title: issue.title,
    phase: issue.phase,
    phaseLabel: PHASE_LABELS[issue.phase] ?? issue.phase,
    detail: issue.detail,
    attention: !!issue.attention,
    hostId: id,
    hostLabel: multiHost ? label(id) : undefined,
  });
  const active = [];
  for (const issue of snap.issues ?? []) {
    if (!TERMINAL_PHASES.has(issue.phase)) active.push(activeRow(issue, snap.hostId));
  }
  for (const p of peers) {
    for (const issue of p.issues ?? []) {
      if (!TERMINAL_PHASES.has(issue.phase)) active.push(activeRow(issue, p.hostId));
    }
  }

  // --- recent: own history + own terminal issues + peer terminal issues.
  //     Dedup by number, FIRST-writer-wins; sources ordered so real history
  //     (with a true completedAt) is preferred over an issues-derived fallback. ---
  const recentRow = (data) => {
    const row = {
      number: data.number,
      title: data.title,
      phaseLabel: PHASE_LABELS[data.phase] ?? data.phase,
      hostId: data.hostId,
    };
    if (data.completedAt != null) {
      row.completedAt = data.completedAt;
      const age = relativeAge(data.completedAt, nowMs);
      if (age != null) row.age = age;
    } else {
      row.completedAt = undefined;
    }
    if (multiHost) row.hostLabel = label(data.hostId);
    return row;
  };

  const sources = [];
  // 1. own history (real completedAt; hostId falls back to own).
  for (const h of snap.history ?? []) {
    sources.push(
      recentRow({
        number: h.number,
        title: h.title,
        phase: h.phase,
        completedAt: h.completedAt,
        hostId: h.hostId ?? snap.hostId,
      }),
    );
  }
  // 2. own terminal issues (fallback completedAt = own updatedAt).
  for (const issue of snap.issues ?? []) {
    if (TERMINAL_PHASES.has(issue.phase)) {
      sources.push(
        recentRow({
          number: issue.number,
          title: issue.title,
          phase: issue.phase,
          completedAt: snap.updatedAt,
          hostId: snap.hostId,
        }),
      );
    }
  }
  // 3. peer terminal issues (fallback completedAt = peer updatedAt).
  for (const p of peers) {
    for (const issue of p.issues ?? []) {
      if (TERMINAL_PHASES.has(issue.phase)) {
        sources.push(
          recentRow({
            number: issue.number,
            title: issue.title,
            phase: issue.phase,
            completedAt: p.updatedAt,
            hostId: p.hostId,
          }),
        );
      }
    }
  }

  // Dedup by number, first-writer-wins.
  const seen = new Set();
  const deduped = [];
  for (const row of sources) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    deduped.push(row);
  }

  // Sort newest-first: a null/absent completedAt sorts FIRST, else ISO desc.
  deduped.sort((a, b) => {
    if (!a.completedAt && !b.completedAt) return 0;
    if (!a.completedAt) return -1;
    if (!b.completedAt) return 1;
    return b.completedAt < a.completedAt ? -1 : b.completedAt > a.completedAt ? 1 : 0;
  });

  const overflowRecent = Math.max(0, deduped.length - RECENT_LIMIT);
  const recent = deduped.slice(0, RECENT_LIMIT).map((r) => {
    // `completedAt` was only an internal sort key — not part of the row shape.
    const { completedAt, ...rest } = r;
    return rest;
  });

  return {
    banner,
    multiHost,
    hosts,
    meta: { perMachine, branch: snap.run.branch },
    totals,
    pills,
    active,
    recent,
    overflowRecent,
  };
}
