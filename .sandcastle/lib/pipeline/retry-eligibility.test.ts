/**
 * Issue #1216 — the pure "can a builder retry even happen?" decision,
 * lifted out of `runIssuePipeline` in `main.mts`. Behaviour preserved
 * exactly: see `retry-eligibility.ts` for the original inline code.
 */
import { describe, expect, it } from "vitest";

import { decideRetryEligibility } from "./retry-eligibility.js";

describe("decideRetryEligibility", () => {
  it("retry enabled with both escalation models available — can retry", () => {
    expect(
      decideRetryEligibility({
        retryEnabled: true,
        implementerEscalations: 2,
        reviewerEscalations: 1,
      }),
    ).toEqual({ canRetry: true });
  });

  it("retry disabled (--no-retry), even with escalation models available", () => {
    expect(
      decideRetryEligibility({
        retryEnabled: false,
        implementerEscalations: 2,
        reviewerEscalations: 2,
      }),
    ).toEqual({
      canRetry: false,
      why: "retry disabled (--no-retry)",
    });
  });

  it("retry enabled but no implementer escalation model", () => {
    expect(
      decideRetryEligibility({
        retryEnabled: true,
        implementerEscalations: 0,
        reviewerEscalations: 2,
      }),
    ).toEqual({
      canRetry: false,
      why: "no escalation model available for implementer or reviewer",
    });
  });

  it("retry enabled but no reviewer escalation model", () => {
    expect(
      decideRetryEligibility({
        retryEnabled: true,
        implementerEscalations: 2,
        reviewerEscalations: 0,
      }),
    ).toEqual({
      canRetry: false,
      why: "no escalation model available for implementer or reviewer",
    });
  });

  it("retry disabled AND no escalation models — --no-retry reason takes precedence", () => {
    expect(
      decideRetryEligibility({
        retryEnabled: false,
        implementerEscalations: 0,
        reviewerEscalations: 0,
      }),
    ).toEqual({
      canRetry: false,
      why: "retry disabled (--no-retry)",
    });
  });
});
