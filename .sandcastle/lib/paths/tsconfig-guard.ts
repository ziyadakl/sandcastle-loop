/**
 * A CONTENT-level companion to the path-based protected-path lock
 * (`protected-paths.ts`) for a check's TypeScript config files — the exact
 * analogue of `e2e-script-guard.ts`, one file over, for a different door into
 * the same hole (issue #1135, MEDIUM 1).
 *
 * ## The hole this closes
 *
 * `check-freeze.ts` freezes three tsconfigs that decide what a graded check
 * SEES — `apps/nextjs/e2e/tsconfig.json`, `apps/nextjs/e2e/checks/tsconfig.json`
 * (browser), and a unit check's `${pkg}/tsconfig.json`. At GRADE time the
 * freeze restores them, so the check runs against the accepted copy. But the
 * SHIP-time lock (`enforceProtectedPaths`) only reverts paths on
 * `DEFAULT_PROTECTED_PATH_GLOBS`, and none of those three are on it. So a
 * builder that edits a tsconfig's `compilerOptions.paths` remap (redirecting a
 * check's import to a passing stub) or its `include`/`exclude` (so the check is
 * no longer collected) was flagged as drift by `frozenCheckDrift` and then
 * SHIPPED anyway once the graded run — which used the restored copy — passed.
 *
 * ## Why not a plain protected-path glob
 *
 * The same reason `apps/nextjs/package.json` is guarded by FIELD rather than by
 * glob. The two `apps/nextjs/e2e/**` tsconfigs are check infrastructure no
 * feature ticket touches, but a unit check's `${pkg}/tsconfig.json` is an
 * ORDINARY package config that feature work legitimately edits (a new
 * `compilerOptions` flag, a `jsx` mode). Blanket-protecting it the way
 * `playwright.config.ts` is protected would silently REVERT every such edit on
 * the file's first byte-for-byte restore — the byte-for-byte glob restore was
 * deliberately rejected here as worse than the hole. So this compares only the
 * THREE fields that decide what a graded run sees — `compilerOptions.paths`,
 * `include`, `exclude` — leaving the rest of the file free to change. A change
 * to any of the three is the same class of tamper as editing the check file
 * itself, just through the config that resolves the check's imports.
 *
 * ## Where it's wired in
 *
 * `main.mts`'s `enforceProtectedPaths` calls {@link tsconfigGradingTampered}
 * for each of the frozen tsconfig seeds ({@link frozenTsconfigSeedsFor} in
 * `check-freeze.ts`) that the shipped diff touched, and — if it fires — adds
 * that path to the SAME `violations` list the glob lock feeds. That reuses
 * every downstream mechanism unchanged (`noteChecksTampered`, the twice-and-
 * stop rule, `restoreProtectedPaths` restoring the whole file byte-for-byte
 * from `preSha`, then re-grading). One lock, a third detection strategy beside
 * the glob scan and the `scripts.e2e` field guard.
 *
 * ## Fail-safe, exactly like `e2eScriptTampered`
 *
 * A read the guard cannot make sense of on EITHER side — unreadable blob,
 * unparsable text, a `compilerOptions` that is present but not an object — is a
 * VIOLATION, never a pass. A broken read and a real tamper look identical, so
 * "we could not look" resolves the same way `pathContentChangedBetween` and
 * `e2eScriptTampered` already resolve it: to `true`. The cost of a false
 * positive is a restore of the accepted copy plus a re-grade — the safe
 * direction; the cost of a false negative is a rigged check shipping green.
 */

import { execFileSync } from "node:child_process";

/**
 * One read attempt's outcome. `ok: true` carries a CANONICAL string over the
 * three graded fields, stable under key order and whitespace, so two readings
 * that mean the same thing compare equal. `ok: false` is an ambiguous read the
 * guard could not interpret — see {@link tsconfigGradingTampered} for why that
 * is NOT folded into "the fields are absent".
 */
type TsconfigRead =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false };

/**
 * The tsconfig fields that decide what a graded check SEES, and the only ones
 * this guard compares. `compilerOptions.paths` resolves the check's imports (a
 * remap points them at a passing stub); `include`/`exclude` decide whether the
 * check is collected to run at all.
 */
function gradingFieldsOf(parsed: Record<string, unknown>): TsconfigRead {
  const co = parsed.compilerOptions;
  if (co !== undefined && (typeof co !== "object" || co === null)) {
    return { ok: false };
  }
  const paths = (co as { paths?: unknown } | undefined)?.paths;
  return {
    ok: true,
    key: stableStringify({
      paths: paths ?? null,
      include: parsed.include ?? null,
      exclude: parsed.exclude ?? null,
    }),
  };
}

/**
 * A deterministic string for any JSON value, with object keys sorted at every
 * level, so `{ "@b": …, "@a": … }` and `{ "@a": …, "@b": … }` — a pure
 * reformat of a `paths` map — produce the same string and never read as a
 * tamper.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Strip `//` and block comments and trailing commas from JSONC so `JSON.parse`
 * accepts a real tsconfig (which is JSONC, not JSON — `e2e/checks/tsconfig.json`
 * carries a paragraph of `//` comments). String literals are respected: a `//`
 * or `/*` INSIDE a string is left alone, and escapes inside strings are
 * honoured so an escaped quote does not end the string early.
 */
function jsoncToJson(raw: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character verbatim; it can never close the string.
        i += 1;
        if (i < raw.length) out += raw[i];
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      // Keep the newline so line numbers and token separation survive.
      if (i < raw.length) out += raw[i];
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 1; // land on the closing '/'
      continue;
    }
    out += ch;
  }
  // Trailing commas — `,` followed only by whitespace before a `}` or `]` —
  // are legal JSONC but not JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Read `tsconfigPath`'s graded fields at `sha`. */
function gradingFieldsAt(
  worktreePath: string,
  sha: string,
  tsconfigPath: string,
): TsconfigRead {
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${sha}:${tsconfigPath}`], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsoncToJson(raw));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };
  return gradingFieldsOf(parsed as Record<string, unknown>);
}

/**
 * Did any of `tsconfigPath`'s graded fields (`compilerOptions.paths`,
 * `include`, `exclude`) change between `baseSha` and `headSha`?
 *
 * Fail-safe: an unreadable or unparsable read on EITHER side is a violation,
 * never a pass — see the module header. Callers are expected to invoke this
 * only when `tsconfigPath` is already known to be inside the diff being
 * examined (mirrors `e2eScriptTampered`'s contract), so this stays a pure
 * two-read comparison with no diff opinion of its own.
 */
export function tsconfigGradingTampered(
  worktreePath: string,
  baseSha: string,
  headSha: string,
  tsconfigPath: string,
): boolean {
  const before = gradingFieldsAt(worktreePath, baseSha, tsconfigPath);
  const after = gradingFieldsAt(worktreePath, headSha, tsconfigPath);
  if (!before.ok || !after.ok) return true;
  return before.key !== after.key;
}
