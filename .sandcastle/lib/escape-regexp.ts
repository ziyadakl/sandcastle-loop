/**
 * Escape every regex-significant character in `s`, so `new RegExp(...)`
 * matches it literally (a path's `.` must never match any character).
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
