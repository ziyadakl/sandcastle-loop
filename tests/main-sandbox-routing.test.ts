import { describe, it, expect } from "vitest";
import { buildSandboxFactory } from "../.sandcastle/main.mjs";

// `buildSandboxFactory(args, containerEnv)` is a pure helper exported from
// main.mts that returns a SandboxFactoryHandles bag. It picks docker(...)
// or macHostSandbox(...) based on args.sandbox.

describe("sandbox routing by --sandbox flag", () => {
  it("returns the mac-host factory when args.sandbox === 'mac-host'", () => {
    const factory = buildSandboxFactory(
      { sandbox: "mac-host", repoRoot: "/tmp/x", imageName: "unused" } as any,
      {},
    );
    expect(factory.kind).toBe("mac-host");
  });

  it("returns the docker factory when args.sandbox === 'docker'", () => {
    const factory = buildSandboxFactory(
      { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
      {},
    );
    expect(factory.kind).toBe("docker");
  });
});
