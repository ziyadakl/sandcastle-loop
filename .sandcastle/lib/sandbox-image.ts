/**
 * The sandbox image: ONE name, and rebuilt at boot when its Claude Code is older
 * than the host's (spec #1368 decision 3).
 *
 * Two faults this closes:
 *  - The /sandcastle-run skill used to build `sandcastle:<folder name>` with the
 *    folder's capitals (`sandcastle:My-Project`) while the loop runs the
 *    library's lowercase `sandcastle:my-project` - a different image, so a
 *    rebuild never reached the one the loop uses. `resolveImageName` is now the
 *    only place the name is computed; `main.mts` and the
 *    `pnpm sandcastle:image-name` script both call it.
 *  - `.sandcastle/Dockerfile` installs whatever Claude is current, but Docker's
 *    layer cache freezes the old copy forever. The rebuild passes the host's
 *    version as `CLAUDE_CODE_VERSION`, a build arg declared just before the
 *    install line, which sits among the Dockerfile's LAST layers, so only the
 *    install is redone (no `--no-cache`, no new apt or chromium download).
 *
 * Every docker/claude call goes through `SandboxImageDeps`, so tests use fakes.
 * `bootSandboxImage` runs once at boot, before any ticket is claimed; never
 * mid-run.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";

/** The one place the image name is decided. `override` is `--image-name`. */
export function resolveImageName(repoRoot: string, override?: string): string {
  return override ?? defaultImageName(path.resolve(repoRoot));
}

/** `"2.1.84 (Claude Code)"` -> `"2.1.84"`; null when no version is present. */
export function parseClaudeVersion(raw: string | null | undefined): string | null {
  const m = /(\d+(?:\.\d+)+)/.exec(raw ?? "");
  return m ? m[1]! : null;
}

/** Numeric dotted compare: negative when a is older than b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface SandboxImageDeps {
  imageExists(image: string): boolean;
  /** Raw `claude --version` output from inside the image, or null on failure. */
  imageClaudeVersion(image: string): string | null;
  /** Raw `claude --version` output on the host, or null on failure. */
  hostClaudeVersion(): string | null;
  buildImage(
    image: string,
    opts: { claudeVersion: string | null },
  ): { ok: boolean; detail: string };
}

export interface BootImageOptions {
  imageName: string;
  sandbox: "docker" | "mac-host";
  dryRun: boolean;
  /**
   * When it answers true another loop is running on this server, and a rebuild
   * would retag the image under its feet (every later ticket container starts
   * from the tag). The check then stands down. Omit it for an explicit,
   * operator-run build (`pnpm sandcastle:build-image`).
   */
  otherLoopRunning?: () => boolean | Promise<boolean>;
}

export interface ImageBootLog {
  log: (m: string) => void;
  logError: (m: string) => void;
}

/** Both channels to stderr: stdout stays free for a script's one result line. */
export const stderrImageBootLog: ImageBootLog = {
  log: (m) => process.stderr.write(`${m}\n`),
  logError: (m) => process.stderr.write(`${m}\n`),
};

export type BootImageResult =
  | { ok: true; action: "skipped" | "fresh" | "built" }
  | { ok: false; action: "failed"; reason: string };

/**
 * Make the sandbox image current. Docker runtime only; a dry run touches
 * nothing. `ok:false` means the caller must stop the run before any claim.
 */
export async function bootSandboxImage(
  opts: BootImageOptions,
  io: SandboxImageDeps,
  out: ImageBootLog,
): Promise<BootImageResult> {
  if (opts.sandbox !== "docker" || opts.dryRun) {
    return { ok: true, action: "skipped" };
  }
  if (opts.otherLoopRunning && (await opts.otherLoopRunning())) {
    out.log(
      `[image] ${opts.imageName}: another loop is running on this server - leaving the image alone`,
    );
    return { ok: true, action: "skipped" };
  }
  const image = opts.imageName;
  const hostVersion = parseClaudeVersion(await io.hostClaudeVersion());
  const exists = await io.imageExists(image);

  let why: string | null = null;
  if (!exists) {
    why = "the image is missing";
  } else {
    const imageVersion = parseClaudeVersion(await io.imageClaudeVersion(image));
    if (hostVersion === null) {
      out.log(
        `[image] ${image}: host Claude version unreadable - keeping the existing image`,
      );
      return { ok: true, action: "fresh" };
    }
    if (imageVersion === null) {
      why = "its Claude Code version cannot be read";
    } else if (compareVersions(imageVersion, hostVersion) < 0) {
      why = `its Claude Code ${imageVersion} is older than the host's ${hostVersion}`;
    } else {
      out.log(`[image] ${image}: Claude Code ${imageVersion} is current`);
      return { ok: true, action: "fresh" };
    }
  }

  out.log(`[image] rebuilding ${image}: ${why}`);
  const built = await io.buildImage(image, { claudeVersion: hostVersion });
  if (!built.ok) {
    const reason = `sandbox image '${image}' could not be rebuilt (${why}): ${built.detail}`;
    out.logError(`[image] ${reason}`);
    return { ok: false, action: "failed", reason };
  }
  out.log(`[image] built ${image}`);
  return { ok: true, action: "built" };
}

/** The `docker build` argv for the loop's image. Pure; exported for tests. */
export function dockerBuildArgv(
  image: string,
  repoRoot: string,
  claudeVersion: string | null,
  uid: number,
  gid: number,
): string[] {
  return [
    "build",
    "-t",
    image,
    "--build-arg",
    `AGENT_UID=${uid}`,
    "--build-arg",
    `AGENT_GID=${gid}`,
    ...(claudeVersion
      ? ["--build-arg", `CLAUDE_CODE_VERSION=${claudeVersion}`]
      : []),
    "-f",
    path.join(repoRoot, ".sandcastle", "Dockerfile"),
    repoRoot,
  ];
}

/** Real docker + claude. The only code in this file that spawns anything. */
export function productionSandboxImageDeps(repoRoot: string): SandboxImageDeps {
  const text = (cmd: string, argv: string[]): string | null => {
    const r = spawnSync(cmd, argv, { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
  return {
    imageExists: (image) =>
      spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
        .status === 0,
    imageClaudeVersion: (image) =>
      text("docker", ["run", "--rm", "--entrypoint", "claude", image, "--version"]),
    hostClaudeVersion: () => text("claude", ["--version"]),
    buildImage: (image, o) => {
      const r = spawnSync(
        "docker",
        dockerBuildArgv(
          image,
          repoRoot,
          o.claudeVersion,
          process.getuid?.() ?? 1001,
          process.getgid?.() ?? 1001,
        ),
        { stdio: "inherit", cwd: repoRoot },
      );
      return { ok: r.status === 0, detail: `docker build exited ${r.status}` };
    },
  };
}
