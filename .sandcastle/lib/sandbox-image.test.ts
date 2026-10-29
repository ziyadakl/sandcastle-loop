/**
 * Spec #1368 decision 3 — one image name, rebuilt when its Claude Code is older
 * than the host's. Tests sit at the outside seam: `bootSandboxImage` with a
 * fake `SandboxImageDeps` (no real docker, no real claude).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootSandboxImage,
  parseClaudeVersion,
  resolveImageName,
  type SandboxImageDeps,
} from "./sandbox-image.js";

const IMAGE = "sandcastle:my-project";

function fakeDeps(init: {
  exists: boolean;
  imageVersion?: string | null;
  hostVersion?: string | null;
  buildOk?: boolean;
}): { deps: SandboxImageDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: SandboxImageDeps = {
    imageExists: (image) => {
      calls.push(`exists ${image}`);
      return init.exists;
    },
    imageClaudeVersion: (image) => {
      calls.push(`image-version ${image}`);
      return init.imageVersion ?? null;
    },
    hostClaudeVersion: () => {
      calls.push("host-version");
      return init.hostVersion ?? null;
    },
    buildImage: (image, opts) => {
      calls.push(`build ${image} claude=${opts.claudeVersion ?? "none"}`);
      return { ok: init.buildOk ?? true, detail: "boom" };
    },
  };
  return { deps, calls };
}

const base = { imageName: IMAGE, sandbox: "docker" as const, dryRun: false };
const quiet = { log: () => undefined, logError: () => undefined };

describe("resolveImageName", () => {
  it("lowercases the repo folder name, whatever its capitals", () => {
    expect(resolveImageName("/home/you/dev/my-project")).toBe(
      "sandcastle:my-project",
    );
  });
  it("an explicit --image-name wins verbatim", () => {
    expect(resolveImageName("/x/my-project", "mine:Tag")).toBe("mine:Tag");
  });
});

describe("parseClaudeVersion", () => {
  it("reads the number out of `claude --version` output", () => {
    expect(parseClaudeVersion("2.1.84 (Claude Code)\n")).toBe("2.1.84");
  });
  it("returns null for output with no version in it", () => {
    expect(parseClaudeVersion("command not found")).toBeNull();
  });
});

describe("bootSandboxImage", () => {
  it("rebuilds, with the host's version as a cache-busting arg, when the image's Claude is older", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.80 (Claude Code)",
      hostVersion: "2.1.84 (Claude Code)",
    });
    const r = await bootSandboxImage(base, deps, quiet);
    expect(r.ok).toBe(true);
    expect(calls).toContain(`build ${IMAGE} claude=2.1.84`);
  });

  it("does not rebuild when the image is as new as the host", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.84 (Claude Code)",
      hostVersion: "2.1.84 (Claude Code)",
    });
    const r = await bootSandboxImage(base, deps, quiet);
    expect(r).toMatchObject({ ok: true, action: "fresh" });
    expect(calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  it("does not rebuild when the image is NEWER than the host", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.2.0",
      hostVersion: "2.1.84",
    });
    await bootSandboxImage(base, deps, quiet);
    expect(calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  it("compares versions as numbers, not text (2.1.9 is older than 2.1.10)", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.9",
      hostVersion: "2.1.10",
    });
    await bootSandboxImage(base, deps, quiet);
    expect(calls).toContain(`build ${IMAGE} claude=2.1.10`);
  });

  it("builds a missing image", async () => {
    const { deps, calls } = fakeDeps({
      exists: false,
      hostVersion: "2.1.84",
    });
    const r = await bootSandboxImage(base, deps, quiet);
    expect(r).toMatchObject({ ok: true, action: "built" });
    expect(calls).toContain(`build ${IMAGE} claude=2.1.84`);
  });

  it("rebuilds an image whose Claude version cannot be read", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: null,
      hostVersion: "2.1.84",
    });
    await bootSandboxImage(base, deps, quiet);
    expect(calls).toContain(`build ${IMAGE} claude=2.1.84`);
  });

  it("keeps a present image when the host's version cannot be read (nothing to compare)", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.80",
      hostVersion: null,
    });
    const r = await bootSandboxImage(base, deps, quiet);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  it("a failed rebuild is NOT ok, and says why", async () => {
    const { deps } = fakeDeps({
      exists: true,
      imageVersion: "2.1.80",
      hostVersion: "2.1.84",
      buildOk: false,
    });
    const errors: string[] = [];
    const r = await bootSandboxImage(base, deps, {
      log: () => undefined,
      logError: (m) => errors.push(m),
    });
    expect(r).toMatchObject({ ok: false, action: "failed" });
    expect(errors.join("\n")).toContain("boom");
  });

  it("touches no docker or claude under mac-host", async () => {
    const { deps, calls } = fakeDeps({ exists: false, hostVersion: "9.9.9" });
    const r = await bootSandboxImage({ ...base, sandbox: "mac-host" }, deps, quiet);
    expect(r).toMatchObject({ ok: true, action: "skipped" });
    expect(calls).toEqual([]);
  });

  it("touches no docker or claude, and says so, when another loop is already running", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.80",
      hostVersion: "2.1.84",
    });
    const logs: string[] = [];
    const r = await bootSandboxImage(
      { ...base, otherLoopRunning: () => true },
      deps,
      { log: (m) => logs.push(m), logError: () => undefined },
    );
    expect(r).toMatchObject({ ok: true, action: "skipped" });
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/another loop/i);
  });

  it("still checks the image when no other loop is running", async () => {
    const { deps, calls } = fakeDeps({
      exists: true,
      imageVersion: "2.1.80",
      hostVersion: "2.1.84",
    });
    const r = await bootSandboxImage(
      { ...base, otherLoopRunning: () => false },
      deps,
      quiet,
    );
    expect(r).toMatchObject({ ok: true, action: "built" });
    expect(calls).toContain(`build ${IMAGE} claude=2.1.84`);
  });

  it("touches no docker or claude on a dry run", async () => {
    const { deps, calls } = fakeDeps({ exists: false, hostVersion: "9.9.9" });
    const r = await bootSandboxImage({ ...base, dryRun: true }, deps, quiet);
    expect(r).toMatchObject({ ok: true, action: "skipped" });
    expect(calls).toEqual([]);
  });
});

describe("pnpm sandcastle:image-name", () => {
  const script = path.resolve(import.meta.dirname, "../scripts/image-name.mts");
  const run = (...argv: string[]) =>
    execFileSync("pnpm", ["exec", "tsx", script, ...argv], {
      encoding: "utf8",
      cwd: path.resolve(import.meta.dirname, "../.."),
    });

  it("prints exactly the lowercase name the loop would run for that repo", () => {
    expect(run("--repo-root", "/srv/Some-Repo")).toBe("sandcastle:some-repo\n");
  });
  it("prints an explicit --image-name verbatim", () => {
    expect(run("--image-name", "x:Y")).toBe("x:Y\n");
  });
});

describe("wiring in main.mts (source-text rot-guard)", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "../main.mts"),
    "utf8",
  );
  it("main.mts never computes the image name itself", () => {
    expect(src).not.toContain("defaultImageName");
  });
  it("the boot step runs before preflight, and a failure stops the run", () => {
    const boot = src.indexOf("await bootSandboxImage(");
    const pre = src.indexOf("const pre = preflight(args);");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(pre);
    expect(src.slice(boot, pre)).toContain(
      "if (!imageBoot.ok) process.exit(2)",
    );
  });
  it("the boot step is told to stand down when another loop runs", () => {
    const boot = src.indexOf("await bootSandboxImage(");
    const pre = src.indexOf("const pre = preflight(args);");
    expect(src.slice(boot, pre)).toContain(
      "otherLoopRunning: anotherLoopRunsOnThisServer",
    );
  });
  it("the Dockerfile installs Claude after the Playwright layers, so a new Claude never redoes them", () => {
    const df = readFileSync(
      path.resolve(import.meta.dirname, "../Dockerfile"),
      "utf8",
    );
    const claude = df.indexOf("ARG CLAUDE_CODE_VERSION");
    expect(claude).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(df.indexOf("corepack enable"));
    expect(claude).toBeGreaterThan(df.indexOf("install-deps chromium"));
    expect(claude).toBeGreaterThan(df.indexOf("install chromium\n"));
  });
  it("the Dockerfile consumes the cache-busting build arg on the install line", () => {
    const df = readFileSync(
      path.resolve(import.meta.dirname, "../Dockerfile"),
      "utf8",
    );
    expect(df).toMatch(
      /ARG CLAUDE_CODE_VERSION=\s*\nRUN curl .*install\.sh.*\$\{CLAUDE_CODE_VERSION\}/,
    );
  });
});
