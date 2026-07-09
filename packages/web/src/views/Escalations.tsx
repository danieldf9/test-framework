import { useState, type JSX } from 'react';
import { useAnswerEscalation, useEscalations } from '../api';
import type { PendingEscalation } from '../types';

export function Escalations({ onOpenPromote }: { onOpenPromote: () => void }): JSX.Element {
  const { data, isLoading } = useEscalations();
  // Answered cards vanish from the pending list, so the "what next" nudge lives
  // at the page level: answer → see how many heals wait → jump to Promote & PR.
  const [promotable, setPromotable] = useState<number | null>(null);

  return (
    <div>
      <h1 className="page-title">Escalations</h1>
      <p className="page-sub">
        Failures Sentinel could not confidently heal. Pick the candidate that matches the original
        intent — it becomes the cached locator and the next run heals at Tier 0 — or mark the change
        as an intentional redesign.
      </p>

      {promotable !== null && promotable > 0 && (
        <div className="card">
          <div className="row-between" style={{ padding: '13px 16px' }}>
            <span>
              ✅ Answer saved — {promotable} heal{promotable === 1 ? ' is' : 's are'} ready to be
              written back into the specs.
            </span>
            <button className="btn-primary" onClick={onOpenPromote}>
              Review &amp; open PR →
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="state">Loading…</div>}
      {data?.length === 0 && (
        <div className="card">
          <div className="empty">🎉 No pending escalations. Everything healed cleanly.</div>
        </div>
      )}
      {data?.map((e) => (
        <EscalationCard key={e.id} esc={e} onAnswered={setPromotable} />
      ))}
    </div>
  );
}

function EscalationCard({
  esc,
  onAnswered,
}: {
  esc: PendingEscalation;
  onAnswered: (promotableCount: number) => void;
}): JSX.Element {
  const answer = useAnswerEscalation();
  const [choice, setChoice] = useState<string | null>(null);
  const q = esc.question;

  const submit = (c: string) => {
    setChoice(c);
    answer.mutate(
      { id: esc.id, choice: c },
      { onSuccess: (r) => onAnswered(r.promotableCount ?? 0) },
    );
  };

  return (
    <div className="card esc">
      <div className="esc-head">
        <div>
          <strong>#{esc.id}</strong> · <span className="mono-sm">{esc.testId}</span>
          {q.context?.classification && (
            <span className="badge b-gray">{q.context.classification}</span>
          )}
        </div>
      </div>
      <div className="esc-body">
        <div className="esc-intent">{q.intent}</div>
        <div className="esc-q">{q.question}</div>
        {q.question.includes('[capped:') && (
          <div className="esc-note">
            ⓘ The AI picked an element <em>confidently</em>, but that element looks very different
            from what this step used before — so Sentinel held the change back for a human to decide
            instead of trusting it.
          </div>
        )}
        {q.question.includes('vision') && q.question.includes('disagrees') && (
          <div className="esc-note">
            ⓘ The AI&apos;s visual check (screenshot) and its DOM check pointed at{' '}
            <em>different</em> elements, so confidence was lowered and a human decides.
          </div>
        )}
        {q.context?.oldLocator && (
          <div className="loc">
            broke: <code>{q.context.oldLocator}</code>
          </div>
        )}

        <div className="cand-list">
          {q.candidates.map((c) => (
            <button
              key={c.label}
              className="cand"
              disabled={answer.isPending}
              onClick={() => submit(c.label)}
            >
              <span className="badge b-blue">{c.label}</span>
              <span className="cand-desc">
                &lt;{c.fingerprint.tag}&gt; “{c.fingerprint.name || c.fingerprint.text}”
              </span>
              <span className="cand-conf">conf {c.confidence.toFixed(2)}</span>
            </button>
          ))}
          <button
            className="cand cand-redesign"
            disabled={answer.isPending}
            onClick={() => submit('REDESIGN')}
          >
            Intentional redesign — the test needs updating
          </button>
        </div>

        {q.context?.screenshot && (
          <div className="shots">
            <figure>
              <img src={q.context.screenshot} alt="failure screenshot" />
              <figcaption>at failure</figcaption>
            </figure>
          </div>
        )}

        {answer.isError && (
          <div className="esc-error">Could not apply: {(answer.error as Error).message}</div>
        )}
        {answer.isPending && <div className="mono-sm">Applying {choice}…</div>}
      </div>
    </div>
  );
}
