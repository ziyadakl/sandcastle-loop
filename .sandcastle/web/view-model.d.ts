/**
 * Type declarations for the browser-ESM render-model (`view-model.js`).
 *
 * The runtime module is plain `.js` (no build step, runs in the browser). This
 * companion `.d.ts` gives TypeScript consumers — the vitest suite and any future
 * TS importer — a real typed contract for the same shape documented in the JS
 * JSDoc. Keep the two in sync on any shape change.
 */

export type BannerKind =
  | "no-run"
  | "live"
  | "stale"
  | "done"
  | "stopped"
  | "unhealthy";

export type PillTone = "gray" | "success" | "warning" | "info";

export interface HostRow {
  hostId: string;
  label: string;
  state: string;
  updatedAt: string;
  stale: boolean;
  lastSeenMs: number;
}

export interface PerMachine {
  label: string;
  current: number;
  total: number;
}

export interface Totals {
  merged: number;
  needsHuman: number;
  requeued: number;
  running: number;
}

export interface Pill {
  key: "merged" | "needsHuman" | "requeued";
  label: string;
  count: number;
  tone: PillTone;
}

export interface ActiveRow {
  number: number;
  title: string;
  phase: string;
  phaseLabel: string;
  detail?: string;
  attention: boolean;
  hostLabel?: string;
  hostId: string;
}

export interface RecentRow {
  number: number;
  title: string;
  phaseLabel: string;
  age?: string;
  hostLabel?: string;
  hostId: string;
}

export interface ViewModel {
  banner: { kind: BannerKind; text: string; live: boolean; activity?: string };
  multiHost: boolean;
  hosts: HostRow[];
  meta: { perMachine: PerMachine[]; branch: string };
  totals: Totals;
  pills: Pill[];
  active: ActiveRow[];
  recent: RecentRow[];
  overflowRecent: number;
}

export const STALE_AFTER_MS: number;
export const ALIAS_MAP: Record<string, string>;
export const PHASE_LABELS: Record<string, string>;
export const TERMINAL_PHASES: Set<string>;
export const RECENT_LIMIT: number;

export function humanizeHostId(hostId: string): string;
export function hostLabel(hostId: string, aliasMap?: Record<string, string>): string;
export function isStale(updatedAt: string | undefined, nowMs: number): boolean;
export function buildViewModel(
  snap: unknown,
  nowMs: number,
  aliasMap?: Record<string, string>,
): ViewModel;
