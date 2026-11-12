import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Agent,
  SearchFilters,
  SearchResult,
  SessionHeader,
  fetchAgents,
  fetchSession,
  headerFromResult,
  search,
  triggerReindex,
} from './api';
import ConversationPanel from './components/ConversationPanel';
import FiltersBar from './components/FiltersBar';
import ResultsList from './components/ResultsList';
import SettingsPanel from './components/SettingsPanel';
import { ResumeArgsOverrides, loadResumeArgsOverrides, saveResumeArgsOverrides } from './settings';

interface View {
  agent: string;
  sessionId: string;
  seq: number;
}

/** Deep link to an open conversation: #view=<agent>/<sessionId>/<seq>. */
function parseViewHash(hash: string): View | null {
  const m = /^#view=([^/]+)\/([^/]+)\/(\d+)$/.exec(hash);
  return m ? { agent: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]), seq: Number(m[3]) } : null;
}
const viewHash = (v: View) => `#view=${encodeURIComponent(v.agent)}/${encodeURIComponent(v.sessionId)}/${v.seq}`;

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [resumeArgs, setResumeArgs] = useState<ResumeArgsOverrides>(loadResumeArgsOverrides);

  // Conversation viewer. `viewing` mirrors the URL hash so Back closes it and the link can be shared.
  const [viewing, setViewing] = useState<View | null>(() => parseViewHash(window.location.hash));
  const [viewHeader, setViewHeader] = useState<SessionHeader | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const pushedRef = useRef(false); // true when we pushed the history entry, so Back (not a replace) undoes it

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await search(query, filters));
      } finally {
        setLoading(false);
      }
    }, 250); // debounce keystrokes
    return () => clearTimeout(timeout);
  }, [query, filters]);

  const openViewer = useCallback((r: SearchResult, seq: number, trigger: HTMLElement | null) => {
    const view = { agent: r.agent, sessionId: r.sessionId, seq };
    triggerRef.current = trigger;
    pushedRef.current = true;
    setViewHeader(headerFromResult(r));
    setViewError(null);
    setViewing(view);
    window.history.pushState(null, '', viewHash(view));
  }, []);

  const closeViewer = useCallback(() => {
    if (pushedRef.current) {
      window.history.back(); // the popstate handler below clears the state
    } else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setViewing(null);
    }
  }, []);

  const changeViewSeq = useCallback((seq: number) => {
    setViewing((v) => {
      if (!v) return v;
      const next = { ...v, seq };
      window.history.replaceState(null, '', viewHash(next));
      return next;
    });
  }, []);

  useEffect(() => {
    const onPop = () => {
      const view = parseViewHash(window.location.hash);
      if (!view) pushedRef.current = false;
      setViewError(null);
      setViewing(view);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A deep link (or Back/Forward to one) only has ids: fetch the header the panel needs.
  const needsHeader = !!viewing && (!viewHeader || viewHeader.agent !== viewing.agent || viewHeader.sessionId !== viewing.sessionId);
  const viewAgent = viewing?.agent;
  const viewSession = viewing?.sessionId;
  useEffect(() => {
    if (!needsHeader || !viewAgent || !viewSession) return;
    let cancelled = false;
    setViewHeader(null);
    fetchSession(viewAgent, viewSession)
      .then((h) => !cancelled && setViewHeader(h))
      .catch((err) => !cancelled && setViewError(String(err instanceof Error ? err.message : err)));
    return () => {
      cancelled = true;
    };
  }, [needsHeader, viewAgent, viewSession]);

  // Make the page behind the dialog unreachable (focus, clicks, screen readers) while it is open.
  // On close, hand focus back to the button that opened the panel. This must happen
  // here, after `inert` is lifted: focusing inside an inert subtree silently does nothing.
  const wasOpen = useRef(false);
  useEffect(() => {
    mainRef.current?.toggleAttribute('inert', !!viewing);
    if (!viewing && wasOpen.current) {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    }
    wasOpen.current = !!viewing;
  }, [viewing]);

  const updateResumeArgs = (next: ResumeArgsOverrides) => {
    setResumeArgs(next);
    saveResumeArgsOverrides(next);
  };

  const markRebuilt = (rebuilt: SearchResult, rebuiltAt: string) => {
    setResults((current) =>
      current.map((r) =>
        r.agent === rebuilt.agent && r.sessionId === rebuilt.sessionId ? { ...r, available: true, rebuiltAt } : r
      )
    );
  };

  const viewAgentInfo = agents.find((a) => a.id === viewing?.agent);

  return (
    <>
    <div className="app" ref={mainRef}>
      <header className="app-header">
        <h1>Agent Session Search</h1>
        <div className="header-actions">
          <button
            className="reindex-btn"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((open) => !open)}
          >
            Settings
          </button>
          <button
            className="reindex-btn"
            disabled={reindexing}
            onClick={async () => {
              setReindexing(true);
              try {
                await triggerReindex();
              } finally {
                setReindexing(false);
              }
            }}
          >
            {reindexing ? 'Reindexing…' : 'Reindex now'}
          </button>
        </div>
      </header>

      {showSettings && <SettingsPanel agents={agents} overrides={resumeArgs} onChange={updateResumeArgs} />}

      <input
        className="search-box"
        autoFocus
        type="text"
        placeholder="Search your session history… (e.g. a user id, ticket number, file path)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <FiltersBar agents={agents} filters={filters} onChange={setFilters} />

      {loading ? (
        <div className="loading">Searching…</div>
      ) : (
        <ResultsList results={results} agents={agents} resumeArgs={resumeArgs} onRebuilt={markRebuilt} onOpen={openViewer} />
      )}
    </div>
    {viewing && (
      <ConversationPanel
        header={needsHeader ? null : viewHeader}
        headerError={viewError}
        agentLabel={viewAgentInfo?.label ?? viewing.agent}
        seq={viewing.seq}
        query={query}
        resumeArgs={resumeArgs[viewing.agent] ?? viewAgentInfo?.defaultResumeArgs ?? ''}
        onSeqChange={changeViewSeq}
        onClose={closeViewer}
      />
    )}
    </>
  );
}
