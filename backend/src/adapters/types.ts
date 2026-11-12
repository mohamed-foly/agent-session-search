/**
 * Everything a new agent integration needs to implement. Nothing outside
 * this file, the concrete adapter, and registry.ts needs to change to add
 * support for another agent.
 */

export interface SessionMeta {
  /** Stable id for this session within its agent (e.g. a UUID). */
  sessionId: string;
  /** Which adapter produced this (matches AgentAdapter.id). */
  agent: string;
  /** Absolute path to the working directory the session ran in, if known. */
  cwd: string | null;
  /** Absolute path this process actually reads from (may be a container-internal mount path). */
  filePath: string;
  /**
   * Absolute path to show the user (e.g. in search results). Equal to
   * filePath when running directly on the host; differs from it when
   * running in Docker, where filePath is the container-internal mount
   * path but the user needs the real host path to make sense of it.
   */
  displayPath: string;
  /** ISO timestamp of the first recorded event, if known. */
  startedAt: string | null;
  /** ISO timestamp of the last recorded event, if known. */
  endedAt: string | null;
}

export interface SessionMessage {
  role: string;
  text: string;
  timestamp: string | null;
}

/** A message as stored in the search index (flattened text, see textExtract). */
export interface IndexedMessage {
  role: string | null;
  timestamp: string | null;
  text: string;
}

export interface RebuiltTranscript {
  /** Full file contents, ready to write to SessionMeta.filePath. */
  content: string;
  userTurns: number;
  assistantTurns: number;
}

export interface AgentAdapter {
  /** Short, stable identifier used in ENABLED_AGENTS and API responses. */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Root this adapter reads session files from (a rebuild may only write below it). */
  readonly sessionsDir: string;
  /** Default extra CLI flags for the resume command's {args} slot (from .env). */
  readonly resumeArgs: string;

  /**
   * Whether this adapter is usable right now (e.g. its configured sessions
   * directory exists). Adapters that return false are skipped by the
   * indexer rather than erroring the whole process.
   */
  isAvailable(): Promise<boolean>;

  /** Enumerate every session this adapter can currently see on disk. */
  listSessions(): AsyncIterable<SessionMeta>;

  /** Stream normalized messages out of one session file, in order. */
  readMessages(session: SessionMeta): AsyncIterable<SessionMessage>;

  /**
   * Build the shell command a user would run to resume this session, with a
   * literal `{args}` slot for extra CLI flags (see renderResumeTemplate).
   */
  buildResumeTemplate(session: SessionMeta): string;

  /**
   * Optional: reconstruct a resumable session file from indexed messages,
   * for sessions whose original file is gone. Lossy by nature — the index
   * only keeps flattened text. Adapters that can't do this omit it.
   */
  buildRebuiltTranscript?(session: SessionMeta, messages: IndexedMessage[]): RebuiltTranscript;
}
