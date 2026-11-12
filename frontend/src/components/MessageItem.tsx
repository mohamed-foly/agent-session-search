import { Ref, useState } from 'react';
import { ViewMessage } from '../api';
import { Highlight } from '../highlight';

export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const CLAMP_CHARS = 1500;
const CLAMP_LINES = 24;

/** Message text, clamped with a "Show more" button when long. The anchor is never clamped. */
function Body({ text, terms, noClamp }: { text: string; terms: string[]; noClamp?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;
  const clamped = long && !noClamp && !expanded;
  return (
    <>
      <div className={`msg-body${clamped ? ' msg-body-clamped' : ''}`}>
        <Highlight text={text} terms={terms} />
      </div>
      {long && !noClamp && (
        <button type="button" className="msg-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : `Show more (${Math.max(1, Math.round(text.length / 1024))} KB)`}
        </button>
      )}
    </>
  );
}

interface Props {
  msg: ViewMessage;
  total: number;
  terms: string[];
  isAnchor: boolean;
  anchorRef: Ref<HTMLElement>;
  /** For a tool_result: the tool_call row it answers, if that row is loaded. */
  callRow?: ViewMessage;
  onGoToCall?: (seq: number) => void;
}

/**
 * One chat turn (user bubble / assistant prose), one collapsible tool step, or
 * one muted bookkeeping record. Thinking records have no stored content and
 * are not rendered.
 */
export default function MessageItem({ msg, total, terms, isAnchor, anchorRef, callRow, onGoToCall }: Props) {
  const [open, setOpen] = useState(isAnchor);
  const common = {
    'data-seq': msg.seq,
    'aria-posinset': msg.seq + 1,
    'aria-setsize': total,
    ref: isAnchor ? anchorRef : undefined,
  };
  const matchLabel = isAnchor ? <span className="match-pill">Search match</span> : null;

  if (msg.kind === 'thinking') return null;

  if (msg.kind === 'user') {
    return (
      <article {...common} className={`msg msg-user${isAnchor ? ' msg-anchor' : ''}`}>
        {matchLabel}
        <div className="msg-bubble">
          <Body text={msg.text} terms={terms} noClamp={isAnchor} />
        </div>
        <div className="msg-time">{formatTime(msg.timestamp)}</div>
      </article>
    );
  }

  if (msg.kind === 'assistant') {
    return (
      <article {...common} className={`msg msg-assistant${isAnchor ? ' msg-anchor' : ''}`}>
        <div className="msg-head">
          Assistant{formatTime(msg.timestamp) ? ` · ${formatTime(msg.timestamp)}` : ''}
          {matchLabel}
        </div>
        <Body text={msg.text} terms={terms} noClamp={isAnchor} />
      </article>
    );
  }

  if (msg.kind === 'tool_call' || msg.kind === 'tool_result') {
    const isCall = msg.kind === 'tool_call';
    const firstLine = msg.text.split('\n').find((l) => l.trim()) ?? '';
    // A result says which tool it came from instead of showing an opaque id; the id stays
    // available in the tooltip and the expanded caption.
    const name = isCall ? msg.toolName ?? 'tool' : msg.toolName ? `⎿ ${msg.toolName} result` : '⎿ result';
    const shortId = msg.toolCallId && msg.toolCallId.length > 18 ? `${msg.toolCallId.slice(0, 18)}…` : msg.toolCallId;
    return (
      <article {...common} className={`tool-row${isAnchor ? ' msg-anchor' : ''}`}>
        <button type="button" className="tool-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span
            className={`tool-name${msg.toolCallId ? ' has-tip' : ''}`}
            data-tip={msg.toolCallId ? `Tool call id: ${msg.toolCallId}` : undefined}
            data-tip-wide=""
            data-tip-pos="below"
            data-tip-align="start"
          >
            {name}
          </span>
          {!open && <span className="tool-preview">{firstLine}</span>}
          {matchLabel}
        </button>
        {open && !isCall && (msg.toolName || shortId) && (
          <div className="tool-caption">
            {msg.toolName ? <>Output of the <strong>{msg.toolName}</strong> call</> : 'Tool output'}
            {shortId && <code title={msg.toolCallId}>{shortId}</code>}
            {callRow && onGoToCall && (
              <button type="button" className="link-btn" onClick={() => onGoToCall(callRow.seq)}>Go to call</button>
            )}
          </div>
        )}
        {open && <Body text={msg.text || '(empty)'} terms={terms} noClamp={isAnchor} />}
      </article>
    );
  }

  // meta: bookkeeping record, only shown when the user asks for system events.
  return (
    <article {...common} className={`tool-row meta-row${isAnchor ? ' msg-anchor' : ''}`}>
      <div className="msg-head">
        {msg.role ?? 'record'}
        {matchLabel}
      </div>
      <Body text={msg.text} terms={terms} noClamp={isAnchor} />
      {msg.fullLength ? <div className="msg-time">Showing the first {msg.text.length.toLocaleString()} of {msg.fullLength.toLocaleString()} characters.</div> : null}
    </article>
  );
}
