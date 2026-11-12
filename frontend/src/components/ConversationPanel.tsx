import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { SessionHeader, fetchMatches, fillArgsSlot } from '../api';
import { queryTerms } from '../highlight';
import AgentBadge from './AgentBadge';
import CopyButton from './CopyButton';
import MessageList from './MessageList';

/** The /matches endpoint returns at most this many. */
const MATCH_CAP = 1000;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

interface Props {
  /** null while a deep-linked session's header is still loading. */
  header: SessionHeader | null;
  headerError: string | null;
  /** Display name of the session's agent (for the badge tooltip). */
  agentLabel: string;
  seq: number;
  query: string;
  /** Extra resume flags for this session's agent (browser override or server default). */
  resumeArgs: string;
  onSeqChange: (seq: number) => void;
  onClose: () => void;
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/**
 * Right-hand drawer showing one session's conversation around a search match.
 * A modal dialog: focus is trapped, Esc closes, and the page behind is inert
 * (App sets that) and not scrollable.
 */
export default function ConversationPanel({ header, headerError, agentLabel, seq, query, resumeArgs, onSeqChange, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [showMeta, setShowMeta] = useState(false);
  const [matches, setMatches] = useState<number[]>([]);
  const terms = queryTerms(query);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const agent = header?.agent;
  const sessionId = header?.sessionId;
  useEffect(() => {
    setMatches([]);
    if (!agent || !sessionId || !query.trim()) return;
    let cancelled = false;
    fetchMatches(agent, sessionId, query)
      .then((seqs) => !cancelled && setMatches(seqs))
      .catch(() => undefined); // match navigation is optional; the viewer works without it
    return () => {
      cancelled = true;
    };
  }, [agent, sessionId, query]);

  const index = matches.indexOf(seq);
  const matchTotal = matches.length >= MATCH_CAP ? `${MATCH_CAP}+` : String(matches.length); // the server caps the list
  const step = (delta: number) => {
    if (matches.length === 0) return;
    const from = index === -1 ? (delta > 0 ? -1 : 0) : index;
    onSeqChange(matches[(from + delta + matches.length) % matches.length]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const typing = (e.target as HTMLElement).matches('input, textarea, select');
    if (!typing && (e.key === '[' || e.key === ']')) step(e.key === ']' ? 1 : -1);
  };

  const command = header ? (header.resumeTemplate ? fillArgsSlot(header.resumeTemplate, resumeArgs) : header.resumeCommand) : null;
  const title = header?.cwd ? basename(header.cwd) : header ? header.sessionId.slice(0, 8) : 'Conversation';

  return (
    <>
      <div className="viewer-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="viewer-title"
        onKeyDown={onKeyDown}
      >
        <header className="viewer-header">
          <div className="viewer-header-top">
            {header && <AgentBadge agentId={header.agent} label={agentLabel} tipPos="below" />}
            {header &&
              (header.available ? (
                <span className="status status-ok">{header.rebuiltAt ? 'Rebuilt' : 'Resumable'}</span>
              ) : (
                <span className="status status-missing" title="The transcript file is gone from disk">
                  Transcript missing
                </span>
              ))}
            <button ref={closeRef} type="button" className="viewer-close" onClick={onClose} aria-label="Close conversation">
              ✕
            </button>
          </div>
          <h2 id="viewer-title" className="viewer-title">{title}</h2>
          {header?.cwd && <div className="viewer-sub" title={header.cwd}>{header.cwd}</div>}
          {header && (
            <div className="viewer-sub viewer-ids">
              <code>{header.sessionId}</code>
              <CopyButton text={header.sessionId} label="Copy id" />
              <span>
                {header.startedAt ? new Date(header.startedAt).toLocaleString() : '—'} →{' '}
                {header.endedAt ? new Date(header.endedAt).toLocaleString() : '—'}
              </span>
            </div>
          )}
        </header>

        <div className="viewer-toolbar">
          {matches.length > 0 && (
            <div className="match-nav" role="group" aria-label="Search matches in this session">
              <button type="button" className="copy-btn" onClick={() => step(-1)} aria-label="Previous match" title="Previous match ([)">‹</button>
              <span aria-live="polite">
                {index === -1 ? `${matchTotal} matches` : `Match ${index + 1} of ${matchTotal}`}
              </span>
              <button type="button" className="copy-btn" onClick={() => step(1)} aria-label="Next match" title="Next match (])">›</button>
            </div>
          )}
          <button type="button" className="copy-btn" aria-pressed={showMeta} onClick={() => setShowMeta((v) => !v)}>
            {showMeta ? 'Hide system events' : 'Show system events'}
          </button>
          {command && <CopyButton text={command} label="Copy resume command" />}
        </div>

        {header ? (
          <MessageList header={header} anchorSeq={seq} terms={terms} showMeta={showMeta} />
        ) : (
          <div className="viewer-body">
            <div className="viewer-scroll">
              {headerError ? (
                <div className="viewer-error" role="alert">Couldn't open this session: {headerError}</div>
              ) : (
                <div className="skeleton" />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
