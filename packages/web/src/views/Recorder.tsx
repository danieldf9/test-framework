import { useState, type JSX } from 'react';
import {
  useDeleteRecorderStep,
  useRecorderStatus,
  useSaveRecording,
  useSetRecorderMode,
  useStartRecording,
  useStopRecording,
  useUpdateRecorderStep,
} from '../api';
import type { RecorderSaveResult } from '../types';

export function Recorder({ onOpenFlow }: { onOpenFlow: (path: string) => void }): JSX.Element {
  const [url, setUrl] = useState('http://127.0.0.1:4173/products');
  const [title, setTitle] = useState('');
  // Expected-text edits are buffered locally (keyed by row index) and PATCHed on
  // blur — and flushed again before save, so "type then click Save immediately"
  // can never lose the text to an in-flight request.
  const [textEdits, setTextEdits] = useState<Record<number, string>>({});
  const [saved, setSaved] = useState<RecorderSaveResult | null>(null);
  // Poll whenever this view is mounted: a session may already be running (the
  // user navigated away and back), and TanStack stops the interval on unmount.
  const status = useRecorderStatus(true);
  const start = useStartRecording();
  const stop = useStopRecording();
  const saveRec = useSaveRecording();
  const setMode = useSetRecorderMode();
  const updateStep = useUpdateRecorderStep();
  const deleteStep = useDeleteRecorderStep();

  const active = status.data?.active ?? false;
  const mode = status.data?.mode ?? 'record';
  const steps = status.data?.steps ?? [];
  const canSave = !active && steps.length > 0;

  const commitText = async (index: number): Promise<void> => {
    const pending = textEdits[index];
    if (pending === undefined || pending === (steps[index]?.text ?? '')) return;
    await updateStep.mutateAsync({ index, text: pending });
    setTextEdits((m) => {
      const { [index]: _done, ...rest } = m;
      return rest;
    });
  };

  const saveFlow = async (): Promise<void> => {
    // Flush any expected-text still sitting in local state before saving.
    for (const key of Object.keys(textEdits)) await commitText(Number(key));
    const result = await saveRec.mutateAsync({ title: title.trim() });
    setSaved(result);
    setTitle('');
    setTextEdits({});
  };

  return (
    <div>
      <h1 className="page-title">Smart Recorder</h1>
      <p className="page-sub">
        A browser window opens on <em>this</em> machine. Click and type as a user would — every
        interaction becomes a step with a semantic intent (refined by the configured LLM when
        available). Saving creates a flow whose locator cache is pre-seeded, so the recorded test is
        healable from its very first run.
      </p>

      <div className="card">
        <div className="row-between" style={{ padding: '13px 16px' }}>
          <input
            className="title-input"
            style={{ flex: 1 }}
            placeholder="Absolute URL to record against"
            value={url}
            disabled={active}
            onChange={(e) => setUrl(e.target.value)}
          />
          {!active ? (
            <button
              className="btn-primary"
              disabled={!/^https?:\/\//.test(url) || start.isPending}
              onClick={() => {
                setSaved(null);
                start.mutate({ url });
              }}
            >
              {start.isPending ? 'Opening browser…' : '⏺ Start recording'}
            </button>
          ) : (
            <>
              <button
                className={mode === 'assert' ? 'btn-primary' : 'btn-secondary'}
                disabled={setMode.isPending}
                title="While asserting, clicks record an expectation instead of interacting"
                onClick={() => setMode.mutate(mode === 'assert' ? 'record' : 'assert')}
              >
                {mode === 'assert' ? '✓ Assert mode on' : '◎ Assert mode'}
              </button>
              <button
                className="btn-danger"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
              >
                ⏹ Stop
              </button>
            </>
          )}
        </div>
        {start.isError && (
          <div className="esc-error" style={{ margin: '0 16px 12px' }}>
            {(start.error as Error).message}
          </div>
        )}
      </div>

      {(active || steps.length > 0) && (
        <div className="card">
          <h2>
            {active ? 'Recording — interact with the opened browser window' : 'Captured draft'}
          </h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Intent (draft)</th>
                <th>Details</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => {
                const isExpect = s.action === 'expectVisible' || s.action === 'expectText';
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {isExpect ? (
                        <select
                          value={s.action}
                          onChange={(e) =>
                            updateStep.mutate({
                              index: i,
                              action: e.target.value as 'expectVisible' | 'expectText',
                            })
                          }
                        >
                          <option value="expectVisible">expectVisible</option>
                          <option value="expectText">expectText</option>
                        </select>
                      ) : (
                        <span className="badge b-blue">{s.action}</span>
                      )}
                    </td>
                    <td>{s.intent}</td>
                    <td className="mono-sm">
                      {s.locator ? `${s.locator.kind}: ${s.locator.name ?? s.locator.value}` : ''}
                      {s.value !== undefined && !s.masked && ` = "${s.value}"`}
                      {s.masked && ' (masked)'}
                      {s.key !== undefined && ` ⏎ ${s.key}`}
                      {s.action === 'expectText' && (
                        <input
                          value={textEdits[i] ?? s.text ?? ''}
                          placeholder="expected text"
                          onChange={(e) => setTextEdits((m) => ({ ...m, [i]: e.target.value }))}
                          onBlur={() => void commitText(i)}
                        />
                      )}
                    </td>
                    <td>
                      <button
                        title="Delete step"
                        onClick={() => {
                          setTextEdits({}); // indices shift — drop stale buffers
                          deleteStep.mutate(i);
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
              {steps.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    Waiting for the first interaction…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {canSave && (
        <div className="card">
          <div className="row-between" style={{ padding: '13px 16px' }}>
            <input
              className="title-input"
              style={{ flex: 1 }}
              placeholder="Test title, e.g. Shopper completes checkout"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button
              className="btn-primary"
              disabled={!title.trim() || saveRec.isPending || updateStep.isPending}
              onClick={() => void saveFlow().catch(() => {})}
            >
              {saveRec.isPending ? 'Refining intents & saving…' : '💾 Save as flow'}
            </button>
          </div>
          {saveRec.isError && (
            <div className="esc-error" style={{ margin: '0 16px 12px' }}>
              {(saveRec.error as Error).message}
            </div>
          )}
        </div>
      )}

      {saved && (
        <div className="card">
          <div className="row-between" style={{ padding: '13px 16px' }}>
            <div>
              ✅ Saved <strong>{saved.title}</strong> — {saved.seededSteps} step
              {saved.seededSteps === 1 ? '' : 's'} pre-seeded into the locator cache.{' '}
              {saved.intentSource === 'llm' ? (
                <span className="badge b-green">intents refined by AI</span>
              ) : (
                <span className="badge b-amber">draft intents</span>
              )}
            </div>
            <button className="btn-primary" onClick={() => onOpenFlow(saved.path)}>
              Open in editor →
            </button>
          </div>
          {saved.refineNote && (
            <p className="page-sub" style={{ margin: '0 16px 12px' }}>
              ⓘ {saved.refineNote}. You can polish the intent wording in the editor — better intents
              heal better.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
