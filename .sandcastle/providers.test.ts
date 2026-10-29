import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envForModel } from "./providers.js";

// Every sandbox now carries the pool's ANTHROPIC_AUTH_TOKEN (buildContainerEnv
// → poolEnv). Claude Code ranks ANTHROPIC_AUTH_TOKEN above ANTHROPIC_API_KEY,
// so a provider that authenticates with ANTHROPIC_API_KEY must blank it or the
// pool's word is sent to that provider instead of its own key.

describe("envForModel — per-provider auth survives the pool's ANTHROPIC_AUTH_TOKEN", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    process.env.KIMI_API_KEY = "kimi-key";
    process.env.GLM_API_KEY = "glm-key";
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("Claude models add nothing, so the pool settings stand", () => {
    expect(envForModel("claude-opus-4-1")).toEqual({});
  });

  it("Kimi blanks ANTHROPIC_AUTH_TOKEN so its ANTHROPIC_API_KEY is the one used", () => {
    expect(envForModel("kimi-for-coding")).toEqual({
      ANTHROPIC_API_KEY: "kimi-key",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
    });
  });

  it("GLM's own ANTHROPIC_AUTH_TOKEN replaces the pool's", () => {
    expect(envForModel("glm-4.6")).toEqual({
      ANTHROPIC_AUTH_TOKEN: "glm-key",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    });
  });
});
