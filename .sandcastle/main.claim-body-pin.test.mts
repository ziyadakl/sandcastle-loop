/**
 * Issue #958 item 2 — the issue body is pinned to a ticket's FIRST claim, so a
 * deferral retry (which re-reads the body fresh) cannot honour a `Deletes-test:`
 * line a builder added to its own ticket mid-run.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetTransientStateForTests,
  pinnedClaimBody,
} from "./main.mts";

describe("pinnedClaimBody — the body is pinned to the first claim (#958 item 2)", () => {
  beforeEach(() => {
    __resetTransientStateForTests();
  });

  it("returns and stores the fresh body on the first claim", () => {
    const got = pinnedClaimBody(958, "original body");
    expect(got.body).toBe("original body");
    expect(got.reusedFirstClaim).toBe(false);
    expect(got.changedSinceFirstClaim).toBe(false);
  });

  it("reuses the first-claim body on a later claim, ignoring a changed re-read", () => {
    pinnedClaimBody(958, "original body");
    // The deferral retry re-reads the body and finds a builder-added line.
    const retry = pinnedClaimBody(958, "original body\nDeletes-test: packages/api/src/x.test.ts");
    expect(retry.body).toBe("original body");
    expect(retry.reusedFirstClaim).toBe(true);
    expect(retry.changedSinceFirstClaim).toBe(true);
  });

  it("reports no change when the re-read matches the first claim", () => {
    pinnedClaimBody(958, "steady body");
    const retry = pinnedClaimBody(958, "steady body");
    expect(retry.body).toBe("steady body");
    expect(retry.reusedFirstClaim).toBe(true);
    expect(retry.changedSinceFirstClaim).toBe(false);
  });

  it("pins an undefined first read too — a later successful read cannot override it", () => {
    // A `gh` failure on the first claim degrades to undefined, which authorises
    // nothing. A later read that succeeds must not resurrect an authorisation.
    const first = pinnedClaimBody(958, undefined);
    expect(first.body).toBeUndefined();
    const retry = pinnedClaimBody(958, "Deletes-test: packages/api/src/x.test.ts");
    expect(retry.body).toBeUndefined();
    expect(retry.reusedFirstClaim).toBe(true);
    expect(retry.changedSinceFirstClaim).toBe(true);
  });

  it("keys per issue — one ticket's pin never leaks into another's", () => {
    pinnedClaimBody(958, "body of 958");
    const other = pinnedClaimBody(972, "body of 972");
    expect(other.body).toBe("body of 972");
    expect(other.reusedFirstClaim).toBe(false);
  });
});
