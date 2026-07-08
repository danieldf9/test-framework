import { useState, type JSX } from 'react';
import { useEscalations, useSummary } from './api';
import { Escalations } from './views/Escalations';
import { Flake } from './views/Flake';
import { FlowEditor } from './views/FlowEditor';
import { Flows } from './views/Flows';
import { LlmCosts } from './views/LlmCosts';
import { Promote } from './views/Promote';
import { Recorder } from './views/Recorder';
import { RunDetail } from './views/RunDetail';
import { RunsList } from './views/RunsList';

type View =
  | { name: 'runs' }
  | { name: 'run'; id: string }
  | { name: 'flows' }
  | { name: 'flow'; path: string }
  | { name: 'recorder' }
  | { name: 'escalations' }
  | { name: 'promote' }
  | { name: 'flake' }
  | { name: 'llm' };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ name: 'runs' });
  const summary = useSummary();
  const escalations = useEscalations();
  const pending = escalations.data?.length ?? 0;
  const section = view.name === 'run' ? 'runs' : view.name === 'flow' ? 'flows' : view.name;

  const openRun = (id: string): void => setView({ name: 'run', id });
  const openFlow = (path: string): void => setView({ name: 'flow', path });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Sentinel Studio
          <small>self-healing test dashboard</small>
        </div>
        <nav className="nav">
          <button
            className={section === 'runs' ? 'active' : ''}
            onClick={() => setView({ name: 'runs' })}
          >
            Runs
          </button>
          <button
            className={section === 'flows' ? 'active' : ''}
            onClick={() => setView({ name: 'flows' })}
          >
            Flows
          </button>
          <button
            className={section === 'recorder' ? 'active' : ''}
            onClick={() => setView({ name: 'recorder' })}
          >
            Recorder
          </button>
          <button
            className={section === 'escalations' ? 'active' : ''}
            onClick={() => setView({ name: 'escalations' })}
          >
            Escalations
            {pending > 0 && <span className="count">{pending}</span>}
          </button>
          <button
            className={section === 'promote' ? 'active' : ''}
            onClick={() => setView({ name: 'promote' })}
          >
            Promote
          </button>
          <button
            className={section === 'flake' ? 'active' : ''}
            onClick={() => setView({ name: 'flake' })}
          >
            Flake dashboard
          </button>
          <button
            className={section === 'llm' ? 'active' : ''}
            onClick={() => setView({ name: 'llm' })}
          >
            LLM usage &amp; cost
          </button>
        </nav>
        <div className="foot">
          {summary.data && summary.data.status !== 'no-runs'
            ? `${summary.data.pendingEscalations} pending escalation(s)`
            : 'no runs yet'}
        </div>
      </aside>

      <main className="content">
        {view.name === 'runs' && <RunsList onOpenRun={openRun} />}
        {view.name === 'run' && (
          <RunDetail runId={view.id} onBack={() => setView({ name: 'runs' })} />
        )}
        {view.name === 'flows' && <Flows onOpenFlow={openFlow} />}
        {view.name === 'flow' && (
          <FlowEditor
            path={view.path}
            onBack={() => setView({ name: 'flows' })}
            onOpenRun={openRun}
          />
        )}
        {view.name === 'recorder' && <Recorder onOpenFlow={openFlow} />}
        {view.name === 'escalations' && <Escalations />}
        {view.name === 'promote' && <Promote />}
        {view.name === 'flake' && <Flake />}
        {view.name === 'llm' && <LlmCosts />}
      </main>
    </div>
  );
}
