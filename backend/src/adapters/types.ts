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
  /** Absolute path to the on-disk session file, for display/debugging. */
  filePath: string;
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

export interface AgentAdapter {
  /** Short, stable identifier used in ENABLED_AGENTS and API responses. */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly label: string;

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

  /** Build the shell command a user would run to resume this session. */
  buildResumeCommand(session: SessionMeta): string;
}
