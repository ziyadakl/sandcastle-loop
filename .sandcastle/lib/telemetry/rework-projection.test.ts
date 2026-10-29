/**
 * Tests for the store → scorer bridge.
 *
 * The drift this module exists to stop is a TYPE-level one, and the typecheck
 * is what catches that (the assertion in `rework-projection.ts` fails to
 * compile if the store's outcome enum widens past the scorer's union). What is
 * left for runtime is the flattening rule itself, and the one that would
 * fabricate data if it were wrong: an escalation model must never be credited
 * for an issue it may never have touched.
 */
import { describe, expect, it } from "vitest";

import { flattenModels } from "./rework-projection.js";

describe("flattenModels", () => {
  it("takes each role's DEFAULT model and never its escalation target", () => {
    // The record states the ladder that was CONFIGURED, not the rungs climbed.
    // Crediting `opus` here would put a row in the by-model table for a model
    // that may not have run at all.
    expect(
      flattenModels({
        implementer: { default: "sonnet", escalations: ["opus"] },
        reviewer: { default: "haiku", escalations: [] },
      }),
    ).toEqual({ implementer: "sonnet", reviewer: "haiku" });
  });

  it("returns undefined for an absent ladder — absent is not empty", () => {
    expect(flattenModels(undefined)).toBeUndefined();
  });

  it("returns undefined rather than `{}` when no role is usable", () => {
    // `{}` would claim "measured, no roles"; the record made no such claim.
    expect(flattenModels({})).toBeUndefined();
    expect(flattenModels({ implementer: { default: "", escalations: [] } })).toBeUndefined();
  });

  it("drops only the unusable roles, keeping the rest", () => {
    expect(
      flattenModels({
        implementer: { default: "sonnet", escalations: [] },
        reviewer: { default: "", escalations: [] },
      }),
    ).toEqual({ implementer: "sonnet" });
  });
});
