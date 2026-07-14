import { describe, it, expect } from "vitest";
import { hostname } from "node:os";
import {
  resolveHostId,
  resolveLockTtlSec,
  DEFAULT_LOCK_TTL_SEC,
} from "../src/host-id.js";

describe("resolveHostId", () => {
  it("uses SANDCASTLE_HOST_ID when set (trimmed)", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_HOST_ID" ? "  build-box-01  " : undefined;
    expect(resolveHostId(getEnv)).toBe("build-box-01");
  });

  it("does not depend on real process.env when env is set", () => {
    // fake env supplies the value; injecting a throwing hostname proves we
    // never fall through to os.hostname() when the env var is present.
    const getEnv = (k: string) =>
      k === "SANDCASTLE_HOST_ID" ? "ci-runner" : undefined;
    const hostname = () => {
      throw new Error("hostname should not be called when env is set");
    };
    expect(resolveHostId(getEnv, hostname)).toBe("ci-runner");
  });

  it("falls back to hostname when env is unset", () => {
    const getEnv = () => undefined;
    expect(resolveHostId(getEnv, () => "my-mac")).toBe("my-mac");
  });

  it("falls back to hostname when env is empty/whitespace", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_HOST_ID" ? "   " : undefined;
    expect(resolveHostId(getEnv, () => "fallback-host")).toBe("fallback-host");
  });

  it("sanitizes uppercase, spaces and slashes into a valid branch fragment", () => {
    const getEnv = () => undefined;
    expect(resolveHostId(getEnv, () => "My Host/Name")).toBe("my-host-name");
  });

  it("collapses repeated separators and trims leading/trailing dashes", () => {
    const getEnv = () => undefined;
    expect(resolveHostId(getEnv, () => "--Foo___Bar!!!Baz--")).toBe(
      "foo-bar-baz",
    );
  });

  it("preserves already-safe branch-name characters", () => {
    const getEnv = () => undefined;
    expect(resolveHostId(getEnv, () => "host.local_1-2")).toBe(
      "host.local_1-2",
    );
  });

  it("caps the length at 40 chars", () => {
    const getEnv = () => undefined;
    const long = "a".repeat(80);
    const out = resolveHostId(getEnv, () => long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe("a".repeat(40));
  });

  it("returns a non-empty, branch-safe string from the real hostname", () => {
    const out = resolveHostId(() => undefined);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/^[a-z0-9._-]+$/);
    // sanity: derived from the real hostname
    expect(typeof hostname()).toBe("string");
  });
});

describe("resolveLockTtlSec", () => {
  it("defaults to DEFAULT_LOCK_TTL_SEC (900) when unset", () => {
    expect(DEFAULT_LOCK_TTL_SEC).toBe(900);
    expect(resolveLockTtlSec(() => undefined)).toBe(900);
  });

  it("uses a valid positive integer override", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "300" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(300);
  });

  it("trims surrounding whitespace on a valid value", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "  120  " : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(120);
  });

  it("falls back to default on non-numeric garbage", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "abc" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(900);
  });

  it("falls back to default on zero", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "0" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(900);
  });

  it("falls back to default on a negative value", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "-30" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(900);
  });

  it("falls back to default on a non-integer value", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "12.5" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(900);
  });

  it("falls back to default on an empty string", () => {
    const getEnv = (k: string) =>
      k === "SANDCASTLE_LOCK_TTL_SEC" ? "" : undefined;
    expect(resolveLockTtlSec(getEnv)).toBe(900);
  });
});
