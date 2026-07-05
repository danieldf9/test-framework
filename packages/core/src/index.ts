export { test, expect, SentinelActions } from './fixture.js';
export type { SentinelWorkerContext, SentinelFixtures } from './fixture.js';
export {
  defineConfig,
  loadConfig,
  findConfigFile,
  SentinelConfigSchema,
  type SentinelConfig,
  type SentinelConfigInput,
  type LoadedConfig,
} from './config.js';
export { SentinelStore, type CacheEntry, type HealRecord } from './storage/store.js';
export { openDatabase, SCHEMA_VERSION, TABLES } from './storage/db.js';
export { exportDatabase, importDatabase, type DbExport } from './storage/exportImport.js';
export { classifyFailure, type DiagnosisInput } from './diagnosis.js';
export {
  refineDiagnosis,
  detectAmbiguity,
  buildDiagnosisMessages,
  parseDiagnosisResponse,
  DiagnosisLlmResponseSchema,
  DIAGNOSIS_SYSTEM_PROMPT,
  type DiagnosisLlmResponse,
  type RefineDeps,
} from './diagnosisLlm.js';
export { stripReasoningBlocks, extractJsonObject, completeJsonWithRepair } from './llmJson.js';
export { applyEscalationAnswer, type AnswerResult } from './escalationAnswer.js';
export {
  runHealingPipeline,
  makeTier0Resolver,
  makeTier1Resolver,
  FatalHealError,
  type TierResolver,
  type TierResult,
  type HealContext,
  type HealPolicy,
} from './healing.js';
export {
  makeTier3Resolver,
  buildTier3Messages,
  TIER3_SYSTEM_PROMPT,
  type Tier3Deps,
} from './tier3.js';
export {
  makeTier2Resolver,
  buildTier2Messages,
  parseHealResponse,
  serializeCandidates,
  HealLlmResponseSchema,
  SpendCapExceededError,
  TIER2_SYSTEM_PROMPT,
  type HealLlmResponse,
  type Tier2Deps,
} from './tier2.js';
export {
  fingerprintSimilarity,
  assertionTextSimilarity,
  tokenSimilarity,
  stringSimilarity,
  levenshtein,
  normalizeText,
} from './similarity.js';
export {
  descriptorsFromFingerprint,
  buildLocator,
  describeDescriptor,
  descriptorToCode,
} from './descriptors.js';
export { sentinelDomAgent, type DomAgentOptions } from './domAgent.js';
export { makeTestId, makeStepId, sha1 } from './ids.js';
export { ArtifactRecorder, testArtifactDirName } from './capture.js';
export type {
  ActionKind,
  ElementFingerprint,
  CandidateDescriptor,
  FailureClass,
  Diagnosis,
  HealOutcome,
  HealMatch,
  StepStatus,
  HealMode,
  EscalationQuestion,
} from './types.js';
