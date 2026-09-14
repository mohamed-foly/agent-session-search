import { useState } from 'react';
import { SearchResult } from '../api';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied!' : 'Copy resume command'}
    </button>
  );
}

export default function ResultsList({ results }: { results: SearchResult[] }) {
  if (results.length === 0) {
    return <div className="empty-state">No matching sessions yet — try a different query.</div>;
  }

  return (
    <ul className="results-list">
      {results.map((r) => (
        <li key={`${r.agent}:${r.sessionId}`} className="result-card">
          <div className="result-header">
            <span className={`badge badge-${r.agent}`}>{r.agent}</span>
            <span className="result-cwd" title={r.cwd ?? undefined}>
              {r.cwd ?? 'unknown directory'}
            </span>
            <span className="result-count">{r.matchCount} match{r.matchCount === 1 ? '' : 'es'}</span>
          </div>

          <p
            className="result-snippet"
            dangerouslySetInnerHTML={{
              __html: r.bestSnippet.replace(/»/g, '<mark>').replace(/«/g, '</mark>'),
            }}
          />

          <div className="result-meta">
            <span>{formatDate(r.startedAt)} → {formatDate(r.endedAt)}</span>
            <span className="result-path" title={r.filePath}>{r.sessionId}</span>
          </div>

          {r.resumeCommand && (
            <div className="result-actions">
              <code>{r.resumeCommand}</code>
              <CopyButton text={r.resumeCommand} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
