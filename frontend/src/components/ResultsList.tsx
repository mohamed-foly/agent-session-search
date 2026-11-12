import { useState } from 'react';
import { Agent, RebuildCheck, SearchResult, checkRebuild, fillArgsSlot, rebuildSession } from '../api';
import { ResumeArgsOverrides } from '../settings';
import { Snippet } from '../highlight';
import AgentBadge from './AgentBadge';
import CopyIconButton from './CopyIconButton';
import MaskIcon from './MaskIcon';
import openIcon from '../assets/icons/message-square-text.svg';

/** What kind of message a result's snippet came from, in words. */
function matchLabel(r: SearchResult): string {
  switch (r.bestKind) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'tool_call':
      return r.bestToolName ? `${r.bestToolName} call` : 'Tool call';
    case 'tool_result':
      return r.bestToolName ? `${r.bestToolName} result` : 'Tool result';
    default:
      return r.bestRole?.startsWith('subagent:') ? 'Subagent' : 'System record';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

type RebuildState =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'review'; check: RebuildCheck }
  | { step: 'rebuilding' }
  | { step: 'failed'; message: string };

/** Offers to rebuild a session whose transcript file is gone, after a server-side eligibility check. */
function RebuildControl({ result, onRebuilt }: { result: SearchResult; onRebuilt: (rebuiltAt: string) => void }) {
  const [state, setState] = useState<RebuildState>({ step: 'idle' });

  const review = async () => {
    setState({ step: 'checking' });
    try {
      setState({ step: 'review', check: await checkRebuild(result.agent, result.sessionId) });
    } catch (err) {
      setState({ step: 'failed', message: String(err) });
    }
  };

  const rebuild = async () => {
    setState({ step: 'rebuilding' });
    try {
      const outcome = await rebuildSession(result.agent, result.sessionId);
      if (outcome.rebuiltAt) {
        setState({ step: 'idle' });
        onRebuilt(outcome.rebuiltAt);
      } else {
        setState({ step: 'review', check: outcome });
      }
    } catch (err) {
      setState({ step: 'failed', message: String(err) });
    }
  };

  if (state.step === 'idle' || state.step === 'checking') {
    return (
      <button className="copy-btn" disabled={state.step === 'checking'} onClick={review}>
        {state.step === 'checking' ? 'Checking…' : 'Rebuild conversation…'}
      </button>
    );
  }
  if (state.step === 'rebuilding') return <span className="rebuild-note">Rebuilding…</span>;
  if (state.step === 'failed') {
    return (
      <div className="rebuild-panel">
        <p>Rebuild failed: {state.message}</p>
        <button className="copy-btn" onClick={() => setState({ step: 'idle' })}>Dismiss</button>
      </div>
    );
  }

  const { check } = state;
  return (
    <div className="rebuild-panel">
      {check.eligible && check.stats ? (
        <>
          <p>
            Rebuild from the search index: {check.stats.userTurns} user and {check.stats.assistantTurns} assistant
            turns ({Math.round(check.stats.bytes / 1024)} KB) from {check.stats.indexedMessages} indexed messages.
          </p>
          <p className="rebuild-note">
            Lossy: text only. Tool calls and their output become truncated text, thinking and file checkpoints are
            gone. The original index text is archived first and stays searchable.
          </p>
          <div className="rebuild-actions">
            <button className="primary-btn" onClick={rebuild}>Rebuild</button>
            <button className="copy-btn" onClick={() => setState({ step: 'idle' })}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p>This session can't be rebuilt:</p>
          <ul>
            {check.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <button className="copy-btn" onClick={() => setState({ step: 'idle' })}>Dismiss</button>
        </>
      )}
    </div>
  );
}

interface Props {
  results: SearchResult[];
  agents: Agent[];
  resumeArgs: ResumeArgsOverrides;
  onRebuilt: (result: SearchResult, rebuiltAt: string) => void;
  /** Open the conversation viewer on a result's best match. */
  onOpen: (result: SearchResult, seq: number, trigger: HTMLElement | null) => void;
}

export default function ResultsList({ results, agents, resumeArgs, onRebuilt, onOpen }: Props) {
  if (results.length === 0) {
    return <div className="empty-state">No matching sessions yet — try a different query.</div>;
  }

  const agentById = new Map(agents.map((a) => [a.id, a]));

  return (
    <ul className="results-list">
      {results.map((r) => {
        const agent = agentById.get(r.agent);
        const args = resumeArgs[r.agent] ?? agent?.defaultResumeArgs ?? '';
        const command = r.resumeTemplate ? fillArgsSlot(r.resumeTemplate, args) : r.resumeCommand;

        return (
          <li key={`${r.agent}:${r.sessionId}`} className="result-card">
            <div className="result-header">
              <AgentBadge agentId={r.agent} label={agent?.label ?? r.agent} />
              <span className="result-cwd" title={r.cwd ?? undefined}>
                {r.cwd ?? 'unknown directory'}
              </span>
              {r.available ? (
                <span
                  className="status status-ok"
                  title={r.rebuiltAt ? `Rebuilt from the index on ${formatDate(r.rebuiltAt)}` : 'Transcript file present'}
                >
                  {r.rebuiltAt ? 'Rebuilt' : 'Resumable'}
                </span>
              ) : (
                <span className="status status-missing" title="The transcript file is gone from disk">
                  Transcript missing
                </span>
              )}
              <span className="result-count">{r.matchCount} match{r.matchCount === 1 ? '' : 'es'}</span>
              {command && (
                <CopyIconButton
                  text={command}
                  label="Copy resume command"
                  tip={`Copy resume command${r.available ? '' : ' (transcript missing, so it will fail)'}: ${command}`}
                />
              )}
              <button
                type="button"
                className="icon-btn has-tip"
                data-tip="Open conversation"
                data-tip-align="end"
                aria-label={`Open conversation, ${agent?.label ?? r.agent} session ${r.sessionId.slice(0, 8)}`}
                onClick={(e) => onOpen(r, r.bestSeq, e.currentTarget)}
              >
                <MaskIcon src={openIcon} />
              </button>
            </div>

            {/* Mouse shortcut only: keyboard and screen-reader users have the "Open conversation" button. */}
            <p className="result-snippet" onClick={(e) => onOpen(r, r.bestSeq, e.currentTarget)}>
              <span
                className={`match-kind match-kind-${r.bestKind}${r.bestKind === 'tool_call' || r.bestKind === 'tool_result' ? ' has-tip' : ''}`}
                data-tip={r.bestToolCallId ? `Tool call id: ${r.bestToolCallId}` : undefined}
                data-tip-wide=""
                data-tip-align="start"
              >
                {matchLabel(r)}
              </span>
              <Snippet value={r.bestSnippet} />
            </p>

            <div className="result-meta">
              <span>{formatDate(r.startedAt)} → {formatDate(r.endedAt)}</span>
              <span className="result-path" title={r.filePath}>{r.sessionId}</span>
            </div>

            {!r.available && (
              <div className="result-unavailable">
                <span className="rebuild-note">
                  Resuming will fail with <code>No conversation found with session ID</code>.
                </span>
                {agent?.canRebuild && (
                  <RebuildControl result={r} onRebuilt={(rebuiltAt) => onRebuilt(r, rebuiltAt)} />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
