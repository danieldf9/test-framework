import { useState, type JSX } from 'react';
import { useCreateFlow, useFlows, useImportables, useImportSpec } from '../api';

export function Flows({ onOpenFlow }: { onOpenFlow: (path: string) => void }): JSX.Element {
  const flows = useFlows();
  const importables = useImportables();
  const createFlow = useCreateFlow();
  const importSpec = useImportSpec();
  const [title, setTitle] = useState('');

  const eligible = importables.data?.filter((i) => i.importable) ?? [];
  const blocked = importables.data?.filter((i) => !i.importable) ?? [];

  return (
    <div>
      <h1 className="page-title">Flows</h1>
      <p className="page-sub">
        No-code tests. A flow compiles to a generated spec that runs — and heals — like any other
        Sentinel test; editing intents or reordering steps never loses healing history.
      </p>

      <div className="card">
        <div className="row-between" style={{ padding: '13px 16px' }}>
          <input
            className="title-input"
            style={{ flex: 1 }}
            placeholder="New flow title, e.g. Shopper can check out"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            className="btn-primary"
            disabled={!title.trim() || createFlow.isPending}
            onClick={() =>
              createFlow.mutate(
                { title: title.trim() },
                {
                  onSuccess: (r) => {
                    setTitle('');
                    onOpenFlow(r.path);
                  },
                },
              )
            }
          >
            + Create flow
          </button>
        </div>
        {createFlow.isError && (
          <div className="esc-error" style={{ margin: '0 16px 12px' }}>
            {(createFlow.error as Error).message}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Existing flows</h2>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>File</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {flows.data?.map((f) => (
              <tr
                key={f.path}
                className="clickable"
                onClick={() => !f.invalid && onOpenFlow(f.path)}
              >
                <td>
                  {f.title}
                  {f.invalid && <span className="badge b-red">invalid</span>}
                </td>
                <td className="mono-sm">{f.path}</td>
                <td>{f.steps}</td>
              </tr>
            ))}
            {flows.data?.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  No flows yet — create one above, record one, or import a spec below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Import hand-written specs</h2>
        <table>
          <thead>
            <tr>
              <th>Spec</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {eligible.map((i) => (
              <tr key={i.path}>
                <td className="mono-sm">{i.path}</td>
                <td>
                  <span className="badge b-green">importable</span> {i.tests} test(s)
                </td>
                <td>
                  <button
                    className="btn-secondary"
                    disabled={importSpec.isPending}
                    onClick={() => importSpec.mutate({ specPath: i.path })}
                  >
                    {importSpec.isPending ? 'Importing…' : 'Import → flows'}
                  </button>
                </td>
              </tr>
            ))}
            {blocked.map((i) => (
              <tr key={i.path}>
                <td className="mono-sm">{i.path}</td>
                <td>
                  <span className="badge b-gray">view-only</span>{' '}
                  <span className="mono-sm">{i.importable ? '' : i.reason}</span>
                </td>
                <td />
              </tr>
            ))}
            {importables.data?.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  No hand-written specs found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {importSpec.isError && (
          <div className="esc-error" style={{ margin: '12px 16px' }}>
            {(importSpec.error as Error).message}
          </div>
        )}
        {importSpec.data && (
          <div className="import-result">
            Imported {importSpec.data.flows.length} flow(s), migrated {importSpec.data.movedRows}{' '}
            history row(s); original retired as <code>{importSpec.data.retired}</code>.
          </div>
        )}
      </div>
    </div>
  );
}
