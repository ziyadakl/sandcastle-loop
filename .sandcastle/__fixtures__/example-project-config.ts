/**
 * Test setup: install `.sandcastle/project.example.json` as the active project
 * config before each test, and reset it after.
 *
 * Most of this suite's older tests were written against a real project's
 * layout (an `apps/*` + `packages/*` monorepo with a landing check, a test
 * database, protected paths). That layout now lives in the example settings
 * file, so those tests run with it installed. A test that is about the
 * DEFAULTS (no settings file) calls `resetProjectConfig()` itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import {
  parseProjectConfig,
  resetProjectConfig,
  setProjectConfig,
  type ProjectConfig,
} from "../lib/project-config.js";

export const EXAMPLE_PROJECT_CONFIG: ProjectConfig = parseProjectConfig(
  readFileSync(join(import.meta.dirname, "..", "project.example.json"), "utf8"),
  "project.example.json",
);

// Installed at import time too: some test files classify changes at module
// level, before any `beforeEach` runs.
setProjectConfig(EXAMPLE_PROJECT_CONFIG);
beforeEach(() => setProjectConfig(EXAMPLE_PROJECT_CONFIG));
afterEach(() => resetProjectConfig());
