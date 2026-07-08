import { useEffect, useState, type JSX } from 'react';
import { useFlow, useSaveFlow, useStartRun } from '../api';
import type { Flow, FlowStep, LocatorKind, LocatorSpec } from '../types';

/** Client-side stepKey mint (same alphabet as @sentinel/flow's mintStepKey). */
function mintKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `k${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const ACTION_LABEL: Record<FlowStep['action'], string> = {
  goto: 'Go to',
  click: 'Click',
  fill: 'Fill',
  expectVisible: 'Expect visible',
  expectText: 'Expect text',
};

const LOCATOR_KINDS: LocatorKind[] = ['testid', 'role', 'label', 'placeholder', 'text', 'css'];

function newStep(action: FlowStep['action']): FlowStep {
  if (action === 'goto') return { action: 'goto', url: '/' };
  const base = {
    stepKey: mintKey(),
    intent: '',
    locator: { kind: 'css', value: '' } as LocatorSpec,
  };
  if (action === 'fill') return { action, ...base, value: '' };
  if (action === 'expectText') return { action, ...base, text: '' };
  return { action, ...base } as FlowStep;
}

function stepProblem(step: FlowStep): string | null {
  if (step.action === 'goto') return step.url.trim() ? null : 'URL is required';
  if (!step.intent.trim()) return 'intent is required';
  if (!step.locator.value.trim()) return 'locator value is required';
  return null;
}

export function FlowEditor({
  path,
  onBack,
  onOpenRun,
}: {
  path: string;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}): JSX.Element {
  const { data, isLoading, isError, error } = useFlow(path);
  const save = useSaveFlow();
  const startRun = useStartRun();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Sync from the server only while pristine — a refetch must not clobber edits.
    if (data && !dirty) setFlow(structuredClone(data.flow));
  }, [data, dirty]);

  if (isLoading || !flow) {
    return isError ? (
      <div className="state">Could not load flow: {(error as Error).message}</div>
    ) : (
      <div className="state">Loading flow…</div>
    );
  }

  const problems = flow.steps.map(stepProblem);
  const firstProblem = problems.find((p) => p !== null) ?? null;

  const update = (mutate: (draft: Flow) => void): void => {
    const draft = structuredClone(flow);
    mutate(draft);
    setFlow(draft);
    setDirty(true);
  };

  const move = (i: number, delta: number): void =>
    update((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.steps.length) return;
      const [s] = d.steps.splice(i, 1);
      d.steps.splice(j, 0, s!);
    });

  return (
    <div>
      <button className="back" onClick={onBack}>
        ← All flows
      </button>
      <div className="row-between">
        <input
          className="title-input"
          value={flow.title}
          onChange={(e) => update((d) => (d.title = e.target.value))}
          aria-label="Flow title"
        />
        <div className="editor-actions">
          <button
            className="btn-secondary"
            disabled={dirty || startRun.isPending}
            title={dirty ? 'Save first' : 'Run only this flow'}
            onClick={() =>
              startRun.mutate(
                { grep: flow.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') },
                { onSuccess: (r) => onOpenRun(r.runId) },
              )
            }
          >
            ▶ Run
          </button>
          <button
            className="btn-primary"
            disabled={!dirty || save.isPending || firstProblem !== null}
            title={firstProblem ?? undefined}
            onClick={() => save.mutate({ path, flow }, { onSuccess: () => setDirty(false) })}
          >
            {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>
      <p className="page-sub">
        <code>{path}</code> → generated spec <code>{data?.specPath}</code>
        {save.data && save.data.rekeyedRows > 0 && (
          <> · migrated {save.data.rekeyedRows} history row(s) after rename</>
        )}
      </p>
      {save.isError && <div className="esc-error">{(save.error as Error).message}</div>}
      {startRun.isError && <div className="esc-error">{(startRun.error as Error).message}</div>}

      {flow.steps.map((step, i) => (
        <StepCard
          key={step.action === 'goto' ? `goto-${i}` : step.stepKey}
          step={step}
          index={i}
          problem={problems[i] ?? null}
          onMoveUp={() => move(i, -1)}
          onMoveDown={() => move(i, 1)}
          onDelete={() => update((d) => void d.steps.splice(i, 1))}
          onChange={(next) => update((d) => (d.steps[i] = next))}
        />
      ))}
      {flow.steps.length === 0 && (
        <div className="card">
          <div className="empty">No steps yet — add the first one below.</div>
        </div>
      )}

      <div className="add-row">
        {(Object.keys(ACTION_LABEL) as FlowStep['action'][]).map((a) => (
          <button
            key={a}
            className="btn-secondary"
            onClick={() => update((d) => void d.steps.push(newStep(a)))}
          >
            + {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepCard({
  step,
  index,
  problem,
  onMoveUp,
  onMoveDown,
  onDelete,
  onChange,
}: {
  step: FlowStep;
  index: number;
  problem: string | null;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onChange: (next: FlowStep) => void;
}): JSX.Element {
  const set = (patch: Partial<FlowStep>): void => onChange({ ...step, ...patch } as FlowStep);

  return (
    <div className={`card step-card${problem ? ' step-invalid' : ''}`}>
      <div className="step-head">
        <span className="step-n">{index + 1}</span>
        <span className="badge b-blue">{ACTION_LABEL[step.action]}</span>
        {step.action === 'fill' && step.masked && (
          <span
            className="badge b-amber"
            title="Recorded from a password field — value was never captured"
          >
            masked
          </span>
        )}
        {problem && <span className="badge b-red">{problem}</span>}
        <span className="step-tools">
          <button onClick={onMoveUp} title="Move up">
            ↑
          </button>
          <button onClick={onMoveDown} title="Move down">
            ↓
          </button>
          <button onClick={onDelete} title="Delete step">
            ✕
          </button>
        </span>
      </div>
      <div className="step-body">
        {step.action === 'goto' ? (
          <label className="field">
            URL
            <input value={step.url} onChange={(e) => set({ url: e.target.value })} />
          </label>
        ) : (
          <>
            <label className="field">
              Intent — what this element is, in plain words (the healing anchor)
              <input
                value={step.intent}
                placeholder="e.g. Add to cart button on the first product card"
                onChange={(e) => set({ intent: e.target.value })}
              />
            </label>
            <LocatorEditor locator={step.locator} onChange={(locator) => set({ locator })} />
            {step.action === 'fill' && (
              <label className="field">
                Value to type
                <input
                  value={step.value}
                  placeholder={step.masked ? '(masked during recording — fill in)' : ''}
                  onChange={(e) => set({ value: e.target.value, masked: false })}
                />
              </label>
            )}
            {step.action === 'expectText' && (
              <label className="field">
                Expected text
                <input value={step.text} onChange={(e) => set({ text: e.target.value })} />
              </label>
            )}
          </>
        )}
        <label className="field field-inline">
          Group (optional s.step block)
          <input
            value={step.group ?? ''}
            placeholder="e.g. fill contact details"
            onChange={(e) => set({ group: e.target.value || undefined })}
          />
        </label>
      </div>
    </div>
  );
}

function LocatorEditor({
  locator,
  onChange,
}: {
  locator: LocatorSpec;
  onChange: (l: LocatorSpec) => void;
}): JSX.Element {
  return (
    <div className="locator-editor">
      <label className="field field-kind">
        Locator
        <select
          value={locator.kind}
          onChange={(e) => onChange({ ...locator, kind: e.target.value as LocatorKind })}
        >
          {LOCATOR_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="field field-grow">
        {locator.kind === 'css' ? 'Selector' : 'Value'}
        <input
          value={locator.value}
          onChange={(e) => onChange({ ...locator, value: e.target.value })}
        />
      </label>
      {locator.kind === 'role' && (
        <label className="field field-grow">
          Accessible name
          <input
            value={locator.name ?? ''}
            onChange={(e) => onChange({ ...locator, name: e.target.value || undefined })}
          />
        </label>
      )}
      {locator.kind !== 'css' && locator.kind !== 'testid' && (
        <label className="field field-check">
          <input
            type="checkbox"
            checked={locator.exact ?? true}
            onChange={(e) => onChange({ ...locator, exact: e.target.checked })}
          />
          exact
        </label>
      )}
    </div>
  );
}
