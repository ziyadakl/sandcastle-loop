/**
 * Multi-provider dispatcher for sandcastle-loop.
 *
 * Maps model IDs (e.g. "kimi-for-coding", "glm-4.6", "claude-sonnet-4-6") to
 * the right Anthropic-compatible endpoint and the env-var pair the provider
 * expects. Per-call env injection is delivered to `sandcastle.claudeCode()`
 * via its `{ env }` option, which sandcastle merges into the agent process's
 * environment at launch time.
 *
 * Three providers supported today:
 *
 *   - anthropic (default fallback) — relies on the user's Claude Pro/Max
 *     subscription via the `claude` CLI's own OAuth credentials. No
 *     ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY override is set; we let claude
 *     find its own auth.
 *   - kimi — kimi.com Moderato plan via https://api.kimi.com/coding/, expects
 *     ANTHROPIC_API_KEY = $KIMI_API_KEY.
 *   - glm — z.ai Coding Plan via https://api.z.ai/api/anthropic, expects
 *     ANTHROPIC_AUTH_TOKEN = $GLM_API_KEY.
 *
 * Both Kimi and GLM emulate Anthropic by reading the same standard
 * ANTHROPIC_* env vars Claude Code uses, but each one expects a *different*
 * variable name to hold the key. The dispatcher gets this right per call —
 * you cannot just set both globally because they'd clobber each other.
 *
 * Codex (OpenAI's CLI) is intentionally excluded — it's a different binary
 * and would need `sandcastle.codex(...)` instead of `claudeCode(...)`. Out of
 * scope for this dispatcher.
 */

export type ProviderName = "anthropic" | "kimi" | "glm";

interface ProviderConfig {
  readonly name: ProviderName;
  /** ANTHROPIC_BASE_URL value. Undefined for anthropic — let the SDK use default. */
  readonly baseURL?: string;
  /** Which env var the provider expects to hold the key. */
  readonly authEnvName: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  /** Where in process.env to read the key from (provider-specific name). */
  readonly apiKeyFromEnv: string;
  /** When true, no key injection — claude CLI's OAuth handles auth (Pro/Max). */
  readonly subscription?: boolean;
  /** Default coding model ID for this provider, used by --provider <name>. */
  readonly defaultCodingModel: string;
}

const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    authEnvName: "ANTHROPIC_API_KEY",
    apiKeyFromEnv: "ANTHROPIC_API_KEY",
    subscription: true,
    defaultCodingModel: "claude-sonnet-4-6",
  },
  kimi: {
    name: "kimi",
    baseURL: "https://api.kimi.com/coding/",
    authEnvName: "ANTHROPIC_API_KEY",
    apiKeyFromEnv: "KIMI_API_KEY",
    defaultCodingModel: "kimi-for-coding",
  },
  glm: {
    name: "glm",
    baseURL: "https://api.z.ai/api/anthropic",
    authEnvName: "ANTHROPIC_AUTH_TOKEN",
    apiKeyFromEnv: "GLM_API_KEY",
    defaultCodingModel: "glm-4.6",
  },
};

/** Detect which provider a model ID belongs to. */
export function providerForModel(modelId: string): ProviderName {
  if (modelId.startsWith("kimi-") || modelId === "kimi-for-coding") return "kimi";
  if (modelId.startsWith("glm-")) return "glm";
  return "anthropic";
}

/**
 * Build the env-var bag to pass to `claudeCode(model, { env })`.
 * Empty object means "no override — use claude CLI's own auth" (Anthropic
 * subscription path).
 *
 * Throws if a non-Anthropic provider's key is missing from process.env, so
 * misconfiguration fails loudly at run start instead of silently calling the
 * wrong endpoint.
 */
export function envForModel(modelId: string): Record<string, string> {
  const provider = PROVIDERS[providerForModel(modelId)];
  if (provider.subscription) return {};
  const key = process.env[provider.apiKeyFromEnv];
  if (!key || key.trim() === "") {
    throw new Error(
      `provider ${provider.name} requires env var ${provider.apiKeyFromEnv} ` +
        `(model=${modelId}). Add it to .env at the repo root.`,
    );
  }
  const env: Record<string, string> = { [provider.authEnvName]: key };
  if (provider.baseURL) env.ANTHROPIC_BASE_URL = provider.baseURL;
  return env;
}

/** Resolve the default coding model for a provider name (used by --provider). */
export function defaultCodingModelFor(name: ProviderName): string {
  return PROVIDERS[name].defaultCodingModel;
}

export function isProviderName(s: string): s is ProviderName {
  return s === "anthropic" || s === "kimi" || s === "glm";
}
