import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import { z } from 'zod';

export const HealModeSchema = z.enum(['auto', 'suggest', 'off']);

export const LlmProviderEnum = z.enum([
  'none',
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
]);

/** LLM provider config. Provider selection is config + env vars only —
 * switching providers never requires code changes (spec §2). */
export const LlmConfigSchema = z
  .object({
    provider: LlmProviderEnum.default('none'),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().default('SENTINEL_LLM_API_KEY'),
    timeoutMs: z.number().int().positive().default(30_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    /** Deterministic exponential backoff base (no jitter — replayability). */
    backoffBaseMs: z.number().int().positive().default(500),
    circuitBreakerThreshold: z.number().int().positive().default(3),
    maxSpendUsdPerRun: z.number().positive().default(2),
    supportsVision: z.boolean().optional(),
    /** USD per million tokens for cost accounting (0 = local/unknown backend). */
    inputCostPerMTok: z.number().min(0).default(0),
    outputCostPerMTok: z.number().min(0).default(0),
    /** Malformed-JSON repair attempts before treating as low confidence (spec §2). */
    maxRepairAttempts: z.number().int().min(0).max(5).default(2),
    /** Character budget for the pruned candidate list sent to the LLM. */
    domCharBudget: z.number().int().positive().default(24_000),
    /** Output budget per call. Reasoning models (e.g. Gemma 4) spend a chunk of
     * this on <thought> blocks before the JSON answer — keep it generous. */
    maxOutputTokens: z.number().int().positive().default(1_024),
  })
  .default({});

export const SentinelConfigSchema = z.object({
  /** Directory holding sentinel.db and artifacts. Relative to the config file. */
  stateDir: z.string().default('.sentinel'),
  dbFile: z.string().default('sentinel.db'),
  testIdAttribute: z.string().default('data-testid'),
  /** First-attempt timeout before the healing pipeline engages. Deliberately
   * shorter than Playwright's 30s default so drift is detected quickly. */
  actionTimeoutMs: z.number().int().positive().default(5_000),
  capture: z
    .object({
      enabled: z.boolean().default(true),
      ringBufferSize: z.number().int().min(1).max(50).default(5),
      screenshots: z.boolean().default(true),
      domSnapshots: z.boolean().default(true),
      /** Blur input/textarea/select content (plus redaction selectors) in every
       * screenshot BEFORE capture — screenshots reach the LLM in Tier 3 and
       * must never carry typed values (spec §10). */
      maskInputsInScreenshots: z.boolean().default(true),
    })
    .default({}),
  healing: z
    .object({
      mode: HealModeSchema.default('auto'),
      /** Tier 1 fuzzy-match acceptance threshold (spec default 0.85). */
      tier1Threshold: z.number().min(0).max(1).default(0.85),
      /** Tier 0 cached-alternate verification floor. */
      tier0VerifyThreshold: z.number().min(0).max(1).default(0.6),
      /** Confidence policy boundaries (spec §6). */
      autoApplyThreshold: z.number().min(0).max(1).default(0.9),
      applyFloor: z.number().min(0).max(1).default(0.6),
      /** If the runner-up candidate scores within this margin of the winner,
       * the situation is ambiguous → confidence is capped below the apply floor. */
      ambiguityMargin: z.number().min(0).max(1).default(0.03),
      maxHealsPerTest: z.number().int().positive().default(3),
      maxHealsPerRun: z.number().int().positive().default(20),
      maxCollectElements: z.number().int().positive().default(300),
    })
    .default({}),
  diagnosis: z
    .object({
      /** Statistical flake detection (pass+fail on the same git SHA). Disable
       * only when the app under test changes independently of the test repo's
       * SHA (e.g. the chaos harness, apps deployed on their own cadence). */
      flakeDetection: z.boolean().default(true),
      /** Below this best-similarity, the element is considered genuinely absent. */
      driftFloor: z.number().min(0).max(1).default(0.5),
      /** Assertion guard: healed assertion targets must carry this much of the
       * original text content. Never lowered below 0.5 — golden rule. */
      assertionTextGuard: z.number().min(0.5).max(1).default(0.8),
      retriesOnEnvironment: z.number().int().min(0).max(5).default(2),
    })
    .default({}),
  redaction: z
    .object({
      selectors: z.array(z.string()).default([]),
      maskPatterns: z
        .array(z.string())
        .default(['pass(word)?', 'token', 'secret', 'card', 'cvv|cvc', 'ssn', 'api[-_]?key']),
    })
    .default({}),
  /** Explicit, logged pre-steps (e.g. cookie/consent banners). Sentinel never
   * auto-accepts consent flows silently — they must be declared here. */
  preSteps: z
    .array(
      z.object({
        name: z.string(),
        selector: z.string(),
        action: z.enum(['click']).default('click'),
        optional: z.boolean().default(true),
        timeoutMs: z.number().int().positive().default(1_500),
      }),
    )
    .default([]),
  llm: LlmConfigSchema,
});

export type SentinelConfig = z.infer<typeof SentinelConfigSchema>;
export type SentinelConfigInput = z.input<typeof SentinelConfigSchema>;

/** Identity helper for typed config files. */
export function defineConfig(config: SentinelConfigInput): SentinelConfigInput {
  return config;
}

export interface LoadedConfig {
  config: SentinelConfig;
  /** Absolute directory the config file lives in (state paths resolve from here). */
  rootDir: string;
  configPath: string | null;
  dbPath: string;
  artifactsDir: string;
}

const CONFIG_FILENAMES = [
  'sentinel.config.ts',
  'sentinel.config.mts',
  'sentinel.config.js',
  'sentinel.config.mjs',
];

export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Minimal .env support (no dependency): the nearest .env walking up from
 * startDir is loaded into process.env, but ONLY for keys that are not already
 * set — real environment variables always win, so CI/chaos-harness overrides
 * (e.g. SENTINEL_LLM_PROVIDER=none) beat the file.
 */
export function loadDotEnv(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function applyEnvOverrides(config: SentinelConfig): SentinelConfig {
  const healMode = process.env.SENTINEL_HEAL;
  if (healMode) {
    config.healing.mode = HealModeSchema.parse(healMode);
  }
  // Provider switching via env only — no code or config-file changes (spec §2).
  const llmProvider = process.env.SENTINEL_LLM_PROVIDER;
  if (llmProvider) {
    config.llm.provider = LlmProviderEnum.parse(llmProvider);
  }
  if (process.env.SENTINEL_LLM_MODEL) config.llm.model = process.env.SENTINEL_LLM_MODEL;
  if (process.env.SENTINEL_LLM_BASE_URL) config.llm.baseUrl = process.env.SENTINEL_LLM_BASE_URL;
  if (process.env.SENTINEL_LLM_TIMEOUT_MS) {
    config.llm.timeoutMs = Number(process.env.SENTINEL_LLM_TIMEOUT_MS);
  }
  if (process.env.SENTINEL_LLM_SUPPORTS_VISION) {
    config.llm.supportsVision = /^(1|true|yes)$/i.test(process.env.SENTINEL_LLM_SUPPORTS_VISION);
  }
  return config;
}

export async function loadConfig(startDir: string = process.cwd()): Promise<LoadedConfig> {
  loadDotEnv(startDir);
  const configPath = findConfigFile(startDir);
  let raw: unknown = {};
  let rootDir = path.resolve(startDir);
  if (configPath) {
    rootDir = path.dirname(configPath);
    const jiti = createJiti(configPath, { interopDefault: true });
    raw = await jiti.import(configPath, { default: true });
  }
  const parsed = SentinelConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid sentinel config at ${configPath ?? '(defaults)'}:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  const config = applyEnvOverrides(parsed.data);
  const stateDir = path.resolve(rootDir, config.stateDir);
  return {
    config,
    rootDir,
    configPath,
    dbPath: process.env.SENTINEL_DB ?? path.join(stateDir, config.dbFile),
    artifactsDir: path.join(stateDir, 'artifacts'),
  };
}
