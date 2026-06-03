import { describe, it, expect } from "vitest";
import { buildSandboxProvider } from "../.sandcastle/lib/sandbox-provider.js";

// `buildSandboxProvider(args, containerEnv, dockerConfig?)` is a pure helper
// that returns a uniform SandboxProvider shape regardless of which provider
// is selected. Both docker and mac-host expose the same topLevelRun /
// createSandbox methods.

const DUMMY_DOCKER_CONFIG = {
  hooks: {},
  copyToWorktree: ["node_modules"],
  copyToWorktreeMs: 600_000,
  completionSignal: ["<promise>COMPLETE</promise>"],
};

describe("sandbox routing by --sandbox flag", () => {
  it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'mac-host'", () => {
    const provider = buildSandboxProvider(
      { sandbox: "mac-host", repoRoot: "/tmp/x", imageName: "unused" } as any,
      {},
    );
    expect(typeof provider.topLevelRun).toBe("function");
    expect(typeof provider.createSandbox).toBe("function");
  });

  it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'docker'", () => {
    const provider = buildSandboxProvider(
      { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
      {},
      DUMMY_DOCKER_CONFIG,
    );
    expect(typeof provider.topLevelRun).toBe("function");
    expect(typeof provider.createSandbox).toBe("function");
  });

  it("throws when docker is selected without a dockerConfig", () => {
    expect(() =>
      buildSandboxProvider(
        { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
        {},
      ),
    ).toThrow();
  });
});
