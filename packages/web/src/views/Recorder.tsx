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

export function Recorder({ onOpenFlow }: { onOpenFlow: (path: string) => void }): JSX.Element {
  const [url, setUrl] = useState('http://127.0.0.1:4173/products');
  const [title, setTitle] = useState('');
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
              onClick={() => start.mutate({ url })}
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
                          // Uncontrolled + commit-on-blur: the 1s status poll must
                          // not clobber typing, and one PATCH per keystroke is noise.
                          defaultValue={s.text ?? ''}
                          placeholder="expected text"
                          onBlur={(e) => {
                            if (e.target.value !== (s.text ?? '')) {
                              updateStep.mutate({ index: i, text: e.target.value });
                            }
                          }}
                        />
                      )}
                    </td>
                    <td>
                      <button title="Delete step" onClick={() => deleteStep.mutate(i)}>
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
              disabled={!title.trim() || saveRec.isPending}
              onClick={() =>
                saveRec.mutate({ title: title.trim() }, { onSuccess: (r) => onOpenFlow(r.path) })
              }
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
    </div>
  );
}
