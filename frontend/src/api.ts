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
  /** seq of the message the snippet came from; anchors the conversation viewer. */
  bestSeq: number;
  /** What the best-matching message is, so the card can label it. */
  bestKind: MessageKind;
  /** The stored role/record type of that message (e.g. "subagent:assistant"). */
  bestRole?: string;
  /** For a tool call or result: the tool's name (a result's comes from the call it answers). */
  bestToolName?: string;
  bestToolCallId?: string;
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

export type MessageKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'thinking' | 'meta';

/** One indexed message, classified and cleaned for display by the backend. */
export interface ViewMessage {
  seq: number;
  role: string | null;
  timestamp: string | null;
  kind: MessageKind;
  text: string;
  toolName?: string;
  toolCallId?: string;
  /** On a tool_result: the seq of the tool_call it answers. */
  callSeq?: number;
  /** Set when `text` was cut (bookkeeping records only). */
  fullLength?: number;
}

export interface MessagesPage {
  /** Ascending by seq. */
  messages: ViewMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  total: number;
}

/** What the conversation viewer needs to know about a session. */
export interface SessionHeader {
  agent: string;
  sessionId: string;
  cwd: string | null;
  filePath: string;
  startedAt: string | null;
  endedAt: string | null;
  available: boolean;
  rebuiltAt: string | null;
  resumeTemplate: string | null;
  resumeCommand: string | null;
}

export function headerFromResult(r: SearchResult): SessionHeader {
  return {
    agent: r.agent,
    sessionId: r.sessionId,
    cwd: r.cwd,
    filePath: r.filePath,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    available: r.available,
    rebuiltAt: r.rebuiltAt,
    resumeTemplate: r.resumeTemplate,
    resumeCommand: r.resumeCommand,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const sessionUrl = (agent: string, id: string) =>
  `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`;

export function fetchSession(agent: string, id: string): Promise<SessionHeader> {
  return getJson<SessionHeader>(`${sessionUrl(agent, id)}?messages=0`);
}

/** `after` counts from the anchor on (anchor included); `before` counts turns earlier than it. */
export function fetchMessages(
  agent: string,
  id: string,
  opts: { anchor: number | 'start' | 'end'; before: number; after: number }
): Promise<MessagesPage> {
  const params = new URLSearchParams({
    anchor: String(opts.anchor),
    before: String(opts.before),
    after: String(opts.after),
  });
  return getJson<MessagesPage>(`${sessionUrl(agent, id)}/messages?${params}`);
}

/** seq of every message in the session matching the query. */
export async function fetchMatches(agent: string, id: string, q: string): Promise<number[]> {
  const data = await getJson<{ seqs: number[] }>(`${sessionUrl(agent, id)}/matches?${new URLSearchParams({ q })}`);
  return data.seqs;
}
