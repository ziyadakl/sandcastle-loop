import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContainerEnv, loadDotenv } from "./main.mts";

// The loop draws from the account pool (CLIProxyAPI) instead of one saved
// subscription token. Claude Code ranks ANTHROPIC_AUTH_TOKEN above
// CLAUDE_CODE_OAUTH_TOKEN, and ANTHROPIC_BASE_URL sends every request to the
// pool. On the Docker path only named keys cross into the container, so both
// must be forwarded explicitly (example/loop#27).

describe("buildContainerEnv — the pool settings reach every sandbox", () => {
  it("forwards ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN when both are set", () => {
    const env = buildContainerEnv(
      {},
      {},
      { ANTHROPIC_BASE_URL: "http://pool:8317", ANTHROPIC_AUTH_TOKEN: "placeholder" },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://pool:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("placeholder");
  });

  it("adds neither key when they are unset or blank", () => {
    const env = buildContainerEnv({}, {}, { ANTHROPIC_BASE_URL: "  " });
    expect("ANTHROPIC_BASE_URL" in env).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
  });

  it("a host-level pool setting wins over one leaked in through the project .env", () => {
    const env = buildContainerEnv(
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      {},
      { ANTHROPIC_BASE_URL: "http://pool:8317", ANTHROPIC_AUTH_TOKEN: "placeholder" },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://pool:8317");
  });
});

describe("loadDotenv — pool settings come only from the sandcastle settings files", () => {
  // A Claude desktop-app session exports ANTHROPIC_BASE_URL=https://api.anthropic.com
  // into the shells it spawns. A loop launched from such a shell must still use
  // the pool address from the settings file, and must not hand the shell's copy
  // to mac-host agents (they inherit process.env wholesale).
  let dir: string;
  let saved: NodeJS.ProcessEnv;
  let logs: string[];

  beforeEach(() => {
    saved = { ...process.env };
    dir = mkdtempSync(path.join(tmpdir(), "pool-env-"));
    mkdirSync(path.join(dir, "xdg", "sandcastle"), { recursive: true });
    mkdirSync(path.join(dir, "repo"), { recursive: true });
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    delete process.env.SANDCASTLE_ENV_FILE;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });

  const writeHostEnv = (body: string) =>
    writeFileSync(path.join(dir, "xdg", "sandcastle", ".env"), body);

  it("logs each pool setting's source by name, never its value", () => {
    writeHostEnv("ANTHROPIC_BASE_URL=http://pool:8317\nANTHROPIC_AUTH_TOKEN=secret-word\n");
    loadDotenv(path.join(dir, "repo"));
    expect(process.env.ANTHROPIC_BASE_URL).toBe("http://pool:8317");
    expect(logs).toContain("[env] ANTHROPIC_BASE_URL ← ~/.config/sandcastle/.env");
    expect(logs).toContain("[env] ANTHROPIC_AUTH_TOKEN ← ~/.config/sandcastle/.env");
    expect(logs.join("\n")).not.toContain("secret-word");
  });

  it("the settings file replaces a launching shell's stray ANTHROPIC_BASE_URL", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    writeHostEnv("ANTHROPIC_BASE_URL=http://pool:8317\nANTHROPIC_AUTH_TOKEN=placeholder\n");
    loadDotenv(path.join(dir, "repo"));
    expect(process.env.ANTHROPIC_BASE_URL).toBe("http://pool:8317");
    expect(logs).toContain("[env] ANTHROPIC_BASE_URL ← ~/.config/sandcastle/.env");
  });

  it("drops a shell-only pool setting so it cannot reach mac-host agents", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    writeHostEnv("");
    loadDotenv(path.join(dir, "repo"));
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(
      logs.some((l) => l.includes("ANTHROPIC_BASE_URL") && l.includes("ignored")),
    ).toBe(true);
  });
});
