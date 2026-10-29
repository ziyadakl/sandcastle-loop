import { describe, expect, it } from "vitest";

import {
  commitTouchedUi,
  decideUiClaimVsDiff,
} from "./story-diff-enforcement.js";

describe("commitTouchedUi", () => {
  it("is true when a .tsx / app file is in the diff", () => {
    expect(
      commitTouchedUi(["apps/nextjs/src/app/(tracker)/foo/config-chart.tsx"]),
    ).toBe(true);
    expect(commitTouchedUi(["packages/ui/src/button.tsx"])).toBe(true);
  });

  it("is false for a backend-only diff", () => {
    expect(
      commitTouchedUi(["packages/api/src/services/cashflow/compute.ts"]),
    ).toBe(false);
  });

  it("is false when git could not measure the diff", () => {
    expect(commitTouchedUi(null)).toBe(false);
  });
});

describe("decideUiClaimVsDiff", () => {
  it("FLAGS the #868 shape: a UI-touching diff certified backend-only", () => {
    const v = decideUiClaimVsDiff({
      changedFiles: [
        "apps/nextjs/src/app/(tracker)/finance/config-driven-chart.tsx",
      ],
      certification: { storyType: "backend-only", e2eRequired: false },
    });
    expect(v).not.toBeNull();
    expect(v?.commitTouchedUi).toBe(true);
    expect(v?.claimedStoryType).toBe("backend-only");
    expect(v?.screenOrFlowTouches).toEqual([
      "apps/nextjs/src/app/(tracker)/finance/config-driven-chart.tsx",
    ]);
    expect(v?.message).toContain("story-type-vs-diff-mismatch");
  });

  it("also flags a UI diff mislabelled `ui` but with e2eRequired=false", () => {
    const v = decideUiClaimVsDiff({
      changedFiles: ["packages/ui/src/date-period-picker.tsx"],
      certification: { storyType: "ui", e2eRequired: false },
    });
    expect(v).not.toBeNull();
  });

  it("passes a UI diff that honestly certified e2eRequired=true", () => {
    expect(
      decideUiClaimVsDiff({
        changedFiles: ["apps/nextjs/src/app/foo/page.tsx"],
        certification: { storyType: "ui", e2eRequired: true },
      }),
    ).toBeNull();
  });

  it("passes a genuine backend-only diff certified backend-only", () => {
    expect(
      decideUiClaimVsDiff({
        changedFiles: ["packages/api/src/services/cashflow/compute.ts"],
        certification: { storyType: "backend-only", e2eRequired: false },
      }),
    ).toBeNull();
  });

  it("does not fire on a playwright-spec repair (instrument carve-out)", () => {
    // requiredProofForDiff excludes apps/*/e2e/** from screenOrFlowTouches, so
    // a spec-only diff is not a browser demand — no false mismatch.
    expect(
      decideUiClaimVsDiff({
        changedFiles: ["apps/nextjs/e2e/finance-visible.spec.ts"],
        certification: { storyType: "infra", e2eRequired: false },
      }),
    ).toBeNull();
  });

  it("does not fire when git could not measure the diff", () => {
    expect(
      decideUiClaimVsDiff({
        changedFiles: null,
        certification: { storyType: "backend-only", e2eRequired: false },
      }),
    ).toBeNull();
  });
});
