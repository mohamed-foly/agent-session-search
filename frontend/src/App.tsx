import { useEffect, useState } from 'react';
import { Agent, SearchFilters, SearchResult, fetchAgents, search, triggerReindex } from './api';
import FiltersBar from './components/FiltersBar';
import ResultsList from './components/ResultsList';

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);

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

  return (
    <div className="app">
      <header className="app-header">
        <h1>Agent Session Search</h1>
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
      </header>

      <input
        className="search-box"
        autoFocus
        type="text"
        placeholder="Search your session history… (e.g. a user id, ticket number, file path)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <FiltersBar agents={agents} filters={filters} onChange={setFilters} />

      {loading ? <div className="loading">Searching…</div> : <ResultsList results={results} />}
    </div>
  );
}
