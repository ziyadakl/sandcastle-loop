#!/usr/bin/env tsx

/**
 * `pnpm sandcastle:image-name [--repo-root DIR] [--image-name NAME]` prints
 * exactly the sandbox image name the loop runs, nothing else (so a skill can do
 * `IMAGE=$(pnpm -s sandcastle:image-name)`). Same function the loop uses
 * (`resolveImageName`), so the two can never disagree (spec #1368 decision 3).
 *
 * `pnpm sandcastle:build-image [same flags]` makes that image current: builds it
 * if missing or if its Claude Code is older than the host's, else does nothing.
 * Exits 1 when the build fails.
 */
import { parseArgs } from "node:util";
import {
  bootSandboxImage,
  productionSandboxImageDeps,
  resolveImageName,
  stderrImageBootLog,
} from "../lib/sandbox-image.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "repo-root": { type: "string" },
    "image-name": { type: "string" },
    build: { type: "boolean" },
  },
});

const repoRoot = values["repo-root"] ?? process.cwd();
const image = resolveImageName(repoRoot, values["image-name"]);

if (values.build || positionals[0] === "build") {
  const r = await bootSandboxImage(
    { imageName: image, sandbox: "docker", dryRun: false },
    productionSandboxImageDeps(repoRoot),
    stderrImageBootLog,
  );
  if (!r.ok) process.exit(1);
}
process.stdout.write(`${image}\n`);
