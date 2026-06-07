/**
 * Pure layout math for the `sandcastle-watch` viewer, kept out of the
 * ink-dependent component so it unit-tests without a TTY (same split as the
 * `reducer.ts` ↔ `sandcastle-watch.tsx` separation).
 *
 * Why this exists: Ink renders the whole tree and lets the terminal scroll when
 * the output is taller than the viewport — which manifests as vertical jitter on
 * a short window (the dashboard's visible slice oscillates between its top and
 * bottom on every repaint). The alt screen hides scrollback but does NOT stop
 * scroll-on-overflow, so the fix is to keep the rendered height ≤ the terminal
 * height. The "recent" strip is the elastic zone; `computeRecentCap` decides how
 * many of its rows to render so the total always fits.
 */

/** Hard cap on the "recent" strip so a long history can't grow the render. */
export const RECENT_CAP = 6;

/**
 * How many "recent" rows fit in `rows` terminal lines. `coreLines` is everything
 * rendered AROUND the recent section (header, counts, the running panel at its
 * REAL body height, banner); the section's own chrome (marginTop + "recent"
 * label + rule = 3 lines) is accounted for here, and one line is reserved for
 * the "+N more" hint whenever rows are hidden. Returns 0 when nothing fits — the
 * recent section then drops out entirely. With `rows = Infinity` (headless
 * render) it returns the full wanted count, preserving pre-fix behaviour.
 */
export function computeRecentCap(opts: {
  rows: number;
  coreLines: number;
  recentTotal: number;
  hardCap?: number;
}): number {
  const hardCap = opts.hardCap ?? RECENT_CAP;
  const maxWanted = Math.min(opts.recentTotal, hardCap);
  if (maxWanted <= 0) return 0;
  const RECENT_CHROME = 3; // marginTop + "recent" label + rule
  const budget = opts.rows - opts.coreLines - RECENT_CHROME;
  // Do all wanted rows fit? (+1 if a "+N more" hint will still be needed.)
  const overflowIfAll = opts.recentTotal > maxWanted ? 1 : 0;
  if (maxWanted + overflowIfAll <= budget) return maxWanted;
  // Otherwise show as many as fit, reserving 1 line for the "+N more" hint.
  return Math.max(0, budget - 1);
}
