import { describe, expect, it } from "vitest";

import { auditServerTarget, SERVER_TARGET_LABELS } from "./target-block.js";

const serverBlock = [
  "## What a person will see",
  "- **Call this:** refundDeal(dealId)",
  "- **Called by:** the deal detail page's refund button",
  "- **Expect this:** a 403 when the caller is not on the deal's team",
].join("\n");

describe("auditServerTarget — no target, no dispatch (#1143)", () => {
  it("STOPS a server-only ticket whose subject is absent and has no target lines", () => {
    const body = [
      "Refuse a refund from an agent on another team.",
      "Target: written, server shape — Subject absent, so the run needs an aim-point",
    ].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.shouldStop).toBe(true);
    expect(audit.missingServerTargets).toEqual([...SERVER_TARGET_LABELS]);
  });

  it("lets a server-only ticket through once all three target lines are filled", () => {
    const body = ["Refuse a cross-team refund.", serverBlock].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.shouldStop).toBe(false);
    expect(audit.missingServerTargets).toEqual([]);
  });

  it("STOPS when only some of the three lines are present", () => {
    const body = ["A ticket.", "- **Call this:** foo()", "- **Called by:** bar"].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.shouldStop).toBe(true);
    expect(audit.missingServerTargets).toEqual(["Expect this:"]);
  });

  it("does NOT stop a ticket whose subject already exists — it needs no aim-point", () => {
    const body = [
      "Tighten the existing refund guard.",
      "Target: not needed — subject exists (packages/api/src/router/deals.ts:88)",
    ].join("\n");
    expect(auditServerTarget(body).shouldStop).toBe(false);
    expect(auditServerTarget(body).subjectExistsClaimed).toBe(true);
  });

  it("does NOT stop a screen ticket — its target is the screen, not the three lines", () => {
    const body = [
      "Show the refund warning.",
      "## What a person will see",
      "- **Screen:** /deals/[id]",
      "- **What appears:** \"This refund crosses teams\"",
      "Target: written, screen shape — Subject absent, so the run needs an aim-point",
    ].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.hasScreen).toBe(true);
    expect(audit.shouldStop).toBe(false);
  });

  it("treats an empty target stub as absent — a stub is not a target", () => {
    const body = [
      "A ticket.",
      "- **Call this:**",
      "- **Called by:**",
      "- **Expect this:**",
      "Target: written, server shape — Subject absent",
    ].join("\n");
    expect(auditServerTarget(body).shouldStop).toBe(true);
  });

  it("accepts a note between the label words and the colon (#1147)", () => {
    // #1147 false-stopped on this exact shape: a parenthetical, then the whole
    // aim, then a trailing colon with nothing after it. A human reads it fine.
    const body = [
      "Warn the leader on a failed push.",
      "- **Call this:** nextQueueState()",
      "- **Called by:** the FUB sync-queue drain",
      "- **Expect this (owner routing rule, 2026-08-25), delivered as an in-app notification:**",
    ].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.shouldStop).toBe(false);
    expect(audit.missingServerTargets).toEqual([]);
  });

  it("accepts a numbered-list target line, not only a dash bullet", () => {
    const body = [
      "A ticket.",
      "1. **Call this:** refundDeal(dealId)",
      "2. **Called by:** the refund button",
      "3. **Expect this:** a 403 off-team",
    ].join("\n");
    expect(auditServerTarget(body).shouldStop).toBe(false);
  });

  it("does NOT treat a prose line that merely mentions the words as a target", () => {
    // Anchored at line start (after decoration), so a sentence that contains
    // the label words mid-line is not mistaken for a target.
    const body = [
      "We should call this feature a win, and it is called by nobody yet.",
      "Target: written, server shape — Subject absent",
    ].join("\n");
    const audit = auditServerTarget(body);
    expect(audit.shouldStop).toBe(true);
    expect(audit.missingServerTargets).toEqual([...SERVER_TARGET_LABELS]);
  });

  it("does NOT let `Screen:` match `Screenshots:` (word-boundary guard)", () => {
    const body = [
      "A server ticket.",
      "- **Screenshots:** three of them attached",
      "Target: written, server shape — Subject absent",
    ].join("\n");
    // `Screenshots` must not register as a `Screen:` target line.
    expect(auditServerTarget(body).hasScreen).toBe(false);
  });
});
