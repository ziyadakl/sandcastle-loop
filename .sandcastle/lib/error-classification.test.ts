/**
 * Issue #1225 — the error-classification family, lifted verbatim out of
 * `main.mts`. These tests pin the EXACT behaviour the inline predicates had, so
 * the move is provably behaviour-preserving. Several cases below exist only
 * because a real mis-classification was fixed once and must never come back —
 * each of those says which trap it guards.
 */
import { describe, expect, it } from "vitest";

import {
  STALL_RE,
  isOutputCapError,
  isPermanentError,
  isRateLimitError,
  isTransientError,
  isTransientServerError,
} from "./error-classification.js";

describe("isPermanentError", () => {
  it.each([
    "invalid_api_key",
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "model_not_found",
    "insufficient_quota",
    "account_deactivated",
  ])("matches the SDK slug %s", (slug) => {
    expect(isPermanentError(`API error: ${slug} — giving up`)).toBe(true);
  });

  it("matches the JSON-shaped numeric codes 1113 and 1110", () => {
    expect(isPermanentError('{"code": 1113, "message": "no credit"}')).toBe(
      true,
    );
    expect(isPermanentError('{"code":1110}')).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isPermanentError("INVALID_API_KEY")).toBe(true);
  });

  it("does not match ordinary prose or an unrelated numeric code", () => {
    expect(isPermanentError("the server had an error")).toBe(false);
    expect(isPermanentError('{"code": 1112}')).toBe(false);
    expect(isPermanentError("")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it.each([
    ["hyphenated prose", "rate-limit exceeded"],
    ["spaced prose", "Rate limit reached for this key"],
    ["unspaced prose", "ratelimit hit"],
    ["the bare 429 status", "request failed with status 429"],
    ["the SDK slug", "rate_limit_error"],
    ["a quota mention", "monthly quota reached"],
    ["the usage-limit phrase", "usage limit reached — try later"],
  ])("matches %s", (_label, msg) => {
    expect(isRateLimitError(msg)).toBe(true);
  });

  it("a permanent error always wins over rate-limit phrasing", () => {
    // The guard must run first, or a dead key would be retried forever as if
    // it were a passing rate-limit storm. Both strings below DO match the
    // rate-limit pattern, so removing the guard flips both assertions.
    expect(isRateLimitError("invalid_api_key: 429 returned")).toBe(false);
    expect(
      isRateLimitError("insufficient_quota (your quota is exhausted)"),
    ).toBe(false);
  });

  it("does not match an unrelated number that merely contains 429", () => {
    expect(isRateLimitError("processed 4291 rows")).toBe(false);
  });

  it("does not match unrelated prose", () => {
    expect(isRateLimitError("reviewer marked HAS_BLOCKERS")).toBe(false);
  });
});

describe("isTransientServerError", () => {
  it.each([
    ["Anthropic prose", "the server had an error while processing"],
    ["a JSON api_error type", '{"type": "api_error"}'],
    // Honest label: this row does NOT pin the JSON alternative. The standalone
    // \boverloaded_error\b rule below already matches this string, so
    // narrowing the JSON alternative leaves the row green. Kept as a
    // real-world message the predicate must recognise, not as coverage.
    [
      "a JSON overloaded_error type (matched by the standalone slug rule)",
      '{"type":"overloaded_error"}',
    ],
    ["the bare overloaded slug", "overloaded_error"],
    ["the 529 status", "status 529 returned"],
    ["service unavailable", "503 Service Unavailable"],
    ["bad gateway", "502 Bad Gateway"],
    ["gateway timeout", "504 Gateway Timeout"],
    ["the full 500 phrase", "500 Internal Server Error"],
  ])("matches %s", (_label, msg) => {
    expect(isTransientServerError(msg)).toBe(true);
  });

  it("does not match a bare 5xx-shaped number outside HTTP-error context", () => {
    // This is the case that actually pins the context anchoring: an
    // unanchored \b5\d{2}\b DOES match "port 503", so dropping the anchoring
    // flips this assertion. (The four-digit ports below do not exercise the
    // anchoring — \b5\d{2}\b cannot match 5432 or 5173 — but they are still
    // the real-world messages this predicate must stay quiet about.)
    expect(isTransientServerError("listening on port 503")).toBe(false);
    expect(isTransientServerError("connect ECONNREFUSED 127.0.0.1:5432")).toBe(
      false,
    );
    expect(isTransientServerError("vite dev server on 5173")).toBe(false);
  });

  it("a permanent error always wins", () => {
    expect(
      isTransientServerError('invalid_api_key — {"type": "api_error"}'),
    ).toBe(false);
  });
});

describe("isTransientError", () => {
  it("is true for a rate-limit error", () => {
    expect(isTransientError("429 rate limit")).toBe(true);
  });

  it("is true for a transient server error", () => {
    expect(isTransientError("503 Service Unavailable")).toBe(true);
  });

  it("is false for a permanent error", () => {
    expect(isTransientError("authentication_error")).toBe(false);
  });

  it("is false for an ordinary code-level failure", () => {
    expect(isTransientError("reviewer marked HAS_BLOCKERS")).toBe(false);
  });
});

describe("isOutputCapError", () => {
  it.each([
    ["the runtime slug", "max_tokens reached"],
    ["Anthropic prose, singular", "hit the maximum output token"],
    ["Anthropic prose, plural", "maximum output tokens exceeded"],
    ["generic truncation phrasing", "output too long"],
    // Honest label: this row does NOT pin the "exceeds the maximum output
    // tokens" alternative. The plain "maximum output tokens" rule above
    // already matches this string, so deleting that alternative leaves the
    // row green. Kept as a real-world message, not as coverage.
    [
      "the exceeds- phrasing (matched by the plain maximum-output-tokens rule)",
      "exceeds the maximum output tokens",
    ],
    ["Claude-specific phrasing", "Claude's response exceeded"],
    ["Claude-specific phrasing, no apostrophe", "Claudes response exceeded"],
  ])("matches %s", (_label, msg) => {
    expect(isOutputCapError(msg)).toBe(true);
  });

  it("does NOT match a too-high-config validation error", () => {
    // "max_tokens: 65536 exceeds the maximum of 32768" is a permanent config
    // mistake, not a runtime truncation. Retrying can never fix it. The
    // negative lookahead after max_tokens is the only thing excluding it.
    expect(
      isOutputCapError("max_tokens: 65536 exceeds the maximum of 32768"),
    ).toBe(false);
    expect(isOutputCapError("max_tokens = 4096 > 8192")).toBe(false);
  });

  it("does NOT match an HTTP 413 payload-too-large error", () => {
    // Mentions "exceeds the maximum" but is not an output truncation.
    expect(
      isOutputCapError("413: Payload exceeds the maximum allowed size"),
    ).toBe(false);
  });

  it("does not match bare unrelated words", () => {
    expect(isOutputCapError("token refreshed, output written")).toBe(false);
  });

  it("a permanent error always wins", () => {
    expect(isOutputCapError("invalid_api_key: max_tokens reached")).toBe(false);
  });
});

describe("STALL_RE", () => {
  it.each([
    ["the host wall-clock watchdog", "hard ceiling: 3600s passed"],
    ["the SDK idle message stem", "Agent idle for 300 seconds"],
    ["the SDK error tag", "AgentIdleTimeoutError"],
    ["the secondary SDK phrase", "no output received"],
    ["a node-level timeout", "connect ETIMEDOUT 10.0.0.1:443"],
  ])("matches %s", (_label, msg) => {
    expect(STALL_RE.test(msg)).toBe(true);
  });

  it("does not match a code-level failure", () => {
    expect(STALL_RE.test("reviewer marked HAS_BLOCKERS")).toBe(false);
    expect(STALL_RE.test("test assertion failed")).toBe(false);
  });

  it("carries no global flag, so repeated tests of the same string agree", () => {
    // A /g regex advances lastIndex between calls and would alternate
    // true/false across the three call sites that share this constant.
    expect(STALL_RE.global).toBe(false);
    const msg = "hard ceiling reached";
    expect(STALL_RE.test(msg)).toBe(true);
    expect(STALL_RE.test(msg)).toBe(true);
  });
});
