export interface Agent {
  id: string;
  label: string;
  /** Extra resume-command flags configured in the server's .env. */
  defaultResumeArgs: string;
  canRebuild: boolean;
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
  /** Whether the transcript file exists, i.e. whether resuming will work. */
  available: boolean;
  rebuiltAt: string | null;
  /** Resume command with a literal `{args}` slot for extra flags. */
  resumeTemplate: string | null;
  resumeCommand: string | null;
}

export interface SearchFilters {
  agent?: string;
  cwd?: string;
  from?: string;
  to?: string;
}

export interface RebuildCheck {
  eligible: boolean;
  reasons: string[];
  stats: {
    indexedMessages: number;
    userTurns: number;
    assistantTurns: number;
    bytes: number;
  } | null;
  rebuiltAt?: string;
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

function rebuildUrl(agent: string, sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}/rebuild`;
}

/** Parses a rebuild response; 409 is a normal "not eligible" answer, other failures throw. */
async function readRebuildResponse(res: Response): Promise<RebuildCheck> {
  const body = await res.json().catch(() => null);
  if (res.ok || (res.status === 409 && body && Array.isArray(body.reasons))) return body;
  throw new Error(body?.error ?? `HTTP ${res.status}`);
}

export async function checkRebuild(agent: string, sessionId: string): Promise<RebuildCheck> {
  return readRebuildResponse(await fetch(rebuildUrl(agent, sessionId)));
}

export async function rebuildSession(agent: string, sessionId: string): Promise<RebuildCheck> {
  return readRebuildResponse(await fetch(rebuildUrl(agent, sessionId), { method: 'POST' }));
}

/** Fills the `{args}` slot of a resume template (mirrors the backend's fillArgsSlot). */
export function fillArgsSlot(resumeTemplate: string, args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return resumeTemplate.replace(/ ?\{args\}/g, '');
  return resumeTemplate.split('{args}').join(trimmed);
}
