import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The Sentinel flow format (D39): one flow document = one test. Flows are the
 * source of truth for UI-authored tests; a flow compiles to a generated
 * `.flow.spec.ts` that runs under the ordinary sentinel fixture. Locators are
 * stored as CandidateDescriptors (the same shape the healing cache uses), and
 * every interactive step carries a stable `stepKey` (D38) so editing intents or
 * reordering steps in the UI never orphans healing history.
 */

export const LocatorSpecSchema = z.object({
  kind: z.enum(['testid', 'role', 'label', 'placeholder', 'text', 'css']),
  value: z.string().min(1),
  /** Accessible name, for kind === 'role'. */
  name: z.string().optional(),
  exact: z.boolean().optional(),
});
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

const STEP_KEY = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'invalid stepKey');

/** Optional s.step() grouping: consecutive steps sharing a group compile into
 * one `await s.step('<group>', …)` block. */
const GROUP = z.string().min(1).max(200).optional();

const GotoStepSchema = z.object({
  action: z.literal('goto'),
  url: z.string().min(1),
  group: GROUP,
});

const keyed = {
  stepKey: STEP_KEY,
  intent: z.string().min(1).max(500),
  locator: LocatorSpecSchema,
  group: GROUP,
};

const ClickStepSchema = z.object({ action: z.literal('click'), ...keyed });
const FillStepSchema = z.object({
  action: z.literal('fill'),
  ...keyed,
  value: z.string(),
  /** True when the recorded value was masked (e.g. a password) and needs filling in. */
  masked: z.boolean().optional(),
});
/** Option value (an empty string is a legal <option> value, so no min). */
const SelectStepSchema = z.object({
  action: z.literal('select'),
  ...keyed,
  value: z.string(),
});
const CheckStepSchema = z.object({ action: z.literal('check'), ...keyed });
const UncheckStepSchema = z.object({ action: z.literal('uncheck'), ...keyed });
const PressStepSchema = z.object({
  action: z.literal('press'),
  ...keyed,
  key: z.string().min(1),
});
const ExpectVisibleStepSchema = z.object({ action: z.literal('expectVisible'), ...keyed });
const ExpectTextStepSchema = z.object({
  action: z.literal('expectText'),
  ...keyed,
  text: z.string(),
});

export const FlowStepSchema = z.discriminatedUnion('action', [
  GotoStepSchema,
  ClickStepSchema,
  FillStepSchema,
  SelectStepSchema,
  CheckStepSchema,
  UncheckStepSchema,
  PressStepSchema,
  ExpectVisibleStepSchema,
  ExpectTextStepSchema,
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type KeyedFlowStep = Exclude<FlowStep, { action: 'goto' }>;

export const FlowSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(300),
    steps: z.array(FlowStepSchema),
  })
  .superRefine((flow, ctx) => {
    const seen = new Set<string>();
    for (const [i, step] of flow.steps.entries()) {
      if (step.action === 'goto') continue;
      if (seen.has(step.stepKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', i, 'stepKey'],
          message: `duplicate stepKey '${step.stepKey}' — each step needs a unique key`,
        });
      }
      seen.add(step.stepKey);
    }
  });
export type Flow = z.infer<typeof FlowSchema>;

/** Mint a fresh stepKey (opaque, D38-valid, collision-resistant enough per test). */
export function mintStepKey(): string {
  return `k${randomBytes(5).toString('hex')}`;
}

/** Parse + validate a flow document, with a readable error on failure. */
export function parseFlow(json: unknown): Flow {
  const result = FlowSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `invalid flow: ${first ? `${first.path.join('.')} — ${first.message}` : result.error.message}`,
    );
  }
  return result.data;
}

/** `checkout.flow.json` → `checkout.flow.spec.ts` (and back). */
export const FLOW_FILE_SUFFIX = '.flow.json';
export const FLOW_SPEC_SUFFIX = '.flow.spec.ts';

export function specPathForFlow(flowPath: string): string {
  if (!flowPath.endsWith(FLOW_FILE_SUFFIX)) {
    throw new Error(`not a flow file (expected ${FLOW_FILE_SUFFIX}): ${flowPath}`);
  }
  return flowPath.slice(0, -FLOW_FILE_SUFFIX.length) + FLOW_SPEC_SUFFIX;
}

/** Filesystem-safe slug for a new flow file derived from its title. */
export function slugForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'flow';
}
