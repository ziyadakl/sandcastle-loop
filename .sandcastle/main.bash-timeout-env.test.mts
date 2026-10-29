import { describe, expect, it } from "vitest";
import { bashTimeoutEnv, DEFAULT_BASH_TIMEOUT_MS } from "./main.mts";

describe("bashTimeoutEnv — the builder's command cap matches the prompt's `timeout 900`", () => {
  it("fills both vars with the default when neither source sets them", () => {
    expect(bashTimeoutEnv({}, {})).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
    });
    expect(Number(DEFAULT_BASH_TIMEOUT_MS)).toBeGreaterThanOrEqual(900_000);
  });
  it("shell env wins over project .env, which wins over the default, per var", () => {
    expect(
      bashTimeoutEnv(
        { BASH_DEFAULT_TIMEOUT_MS: "300000" },
        { BASH_DEFAULT_TIMEOUT_MS: "1", BASH_MAX_TIMEOUT_MS: "1200000" },
      ),
    ).toEqual({ BASH_DEFAULT_TIMEOUT_MS: "300000", BASH_MAX_TIMEOUT_MS: "1200000" });
  });
  it("treats blank as unset", () => {
    expect(bashTimeoutEnv({ BASH_MAX_TIMEOUT_MS: "  " }, {})).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
    });
  });
  it("falls to the default when only projectEnv sets a blank value", () => {
    expect(bashTimeoutEnv({}, { BASH_DEFAULT_TIMEOUT_MS: "   " })).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
    });
  });
  it("blank shell value still lets a real project value win", () => {
    expect(
      bashTimeoutEnv(
        { BASH_MAX_TIMEOUT_MS: "   " },
        { BASH_MAX_TIMEOUT_MS: "1200000" },
      ),
    ).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: "1200000",
    });
  });
  it("resolves the two variables independently — no clamping between them", () => {
    // Claude Code's runtime takes the LARGER of the two as its effective
    // ceiling, so an operator setting only BASH_MAX_TIMEOUT_MS below our
    // 900s default must NOT pull the default down with it — that would
    // actively lower the cap below the 900s the prompt assumes.
    expect(bashTimeoutEnv({ BASH_MAX_TIMEOUT_MS: "300000" }, {})).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: DEFAULT_BASH_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: "300000",
    });
  });
});
