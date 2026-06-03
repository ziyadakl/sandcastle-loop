import { describe, it, expect } from "vitest";
import { parseSandcastleArgs } from "../.sandcastle/main.mjs";

describe("--sandbox flag", () => {
  it("defaults to 'docker' when not provided", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.sandbox).toBe("docker");
  });

  it("accepts 'docker' explicitly", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--sandbox", "docker"]);
    expect(args.sandbox).toBe("docker");
  });

  it("accepts 'mac-host'", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--sandbox", "mac-host"]);
    expect(args.sandbox).toBe("mac-host");
  });

  it("rejects unknown sandbox values with a clear error", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--sandbox", "podman"]),
    ).toThrow(/--sandbox: expected one of docker\|mac-host/);
  });
});
