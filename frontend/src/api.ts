export interface Agent {
  id: string;
  label: string;
}

export interface SearchResult {
  agent: string;
  sessionId: string;
  cwd: string | null;
  filePath: string;
  startedAt: string | null;
  endedAt: string | null;
  matchCount: number;
  bestSnippet: string;
  resumeCommand: string | null;
}

export interface SearchFilters {
  agent?: string;
  cwd?: string;
  from?: string;
  to?: string;
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch('/api/agents');
  const data = await res.json();
  return data.agents;
}

export async function search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.cwd) params.set('cwd', filters.cwd);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const res = await fetch(`/api/search?${params.toString()}`);
  const data = await res.json();
  return data.results;
}

export async function triggerReindex(): Promise<void> {
  await fetch('/api/reindex', { method: 'POST' });
}
