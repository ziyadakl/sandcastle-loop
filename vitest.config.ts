import { defineConfig } from "vitest/config";

// Root suite: the installer (`bin/init.mjs`) and skill linker (`skills/install.sh`).
// The loop's own suite lives in `.sandcastle/` and runs with
// `vitest run --root .sandcastle` (see package.json `test:loop`).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
