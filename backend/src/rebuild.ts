import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { AgentAdapter, IndexedMessage, RebuiltTranscript, SessionMeta } from './adapters/types';
import { resolveSessionPaths } from './paths';

/** A `sessions` table row. */
export interface SessionRow {
  id: string;
  agent: string;
  cwd: string | null;
  file_path: string;
  display_path: string;
  rel_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  rebuilt_at: string | null;
}

/** A session's metadata, with its paths resolved for the environment this process runs in. */
export function sessionMetaFromRow(row: SessionRow, adapter?: AgentAdapter): SessionMeta {
  const { filePath, displayPath } = resolveSessionPaths(adapter, row);
  return {
    sessionId: row.id,
    agent: row.agent,
    cwd: row.cwd,
    filePath,
    displayPath,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export interface RebuildCheck {
  eligible: boolean;
  /** Why the session can't be rebuilt; empty when eligible. */
  reasons: string[];
  stats: {
    indexedMessages: number;
    userTurns: number;
    assistantTurns: number;
    bytes: number;
  } | null;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Closest existing ancestor of `dir` — the directory a mkdir -p would write into. */
function nearestExistingDir(dir: string): string {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false; // EACCES, or EROFS on a read-only (e.g. Docker :ro) mount
  }
}

/**
 * The session's indexed messages. Always the best available source: the
 * indexer re-prepends the archive whenever it reindexes a rebuilt session
 * (see runFullScan), so this holds the original text plus any real turns
 * added after an earlier rebuild.
 */
function loadSourceMessages(db: Database.Database, agent: string, id: string): IndexedMessage[] {
  return db
    .prepare('SELECT role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? ORDER BY seq')
    .all(agent, id) as IndexedMessage[];
}

function evaluate(
  db: Database.Database,
  adapter: AgentAdapter,
  row: SessionRow
): { check: RebuildCheck; transcript: RebuiltTranscript | null } {
  const reasons: string[] = [];
  // Resolved for this environment, so a session indexed under Docker can be rebuilt from the host and vice versa.
  const { filePath } = resolveSessionPaths(adapter, row);

  if (!adapter.buildRebuiltTranscript) {
    return {
      check: { eligible: false, reasons: [`${adapter.label} does not support rebuilding sessions.`], stats: null },
      transcript: null,
    };
  }
  if (fs.existsSync(filePath)) {
    reasons.push('The transcript file still exists, so the session is resumable as-is.');
  }
  if (!isInside(filePath, adapter.sessionsDir)) {
    reasons.push(`The session's file path is outside ${adapter.label}'s sessions directory.`);
  } else if (!isWritable(nearestExistingDir(path.dirname(filePath)))) {
    reasons.push(
      `The sessions directory is not writable by this server. In Docker, set ` +
        `CLAUDE_CODE_SESSIONS_MOUNT_MODE=rw and recreate the container.`
    );
  }
  if (!row.cwd) {
    reasons.push('The working directory of the session is unknown, so it could not be resumed from the right project.');
  }

  const messages = loadSourceMessages(db, row.agent, row.id);
  const transcript = adapter.buildRebuiltTranscript(sessionMetaFromRow(row, adapter), messages);
  if (transcript.userTurns < 1 || transcript.assistantTurns < 1) {
    reasons.push('The index holds no complete exchange (at least one user prompt and one assistant reply).');
  }

  return {
    check: {
      eligible: reasons.length === 0,
      reasons,
      stats: {
        indexedMessages: messages.length,
        userTurns: transcript.userTurns,
        assistantTurns: transcript.assistantTurns,
        bytes: Buffer.byteLength(transcript.content),
      },
    },
    transcript,
  };
}

export function checkRebuild(db: Database.Database, adapter: AgentAdapter, row: SessionRow): RebuildCheck {
  return evaluate(db, adapter, row).check;
}

/**
 * Writes the rebuilt transcript to the session's original path. Entirely
 * synchronous on purpose: the background indexer is async, so it can't
 * observe the new file before the index row is pinned to its mtime below.
 */
export function performRebuild(
  db: Database.Database,
  adapter: AgentAdapter,
  row: SessionRow
): RebuildCheck & { rebuiltAt?: string } {
  const { check, transcript } = evaluate(db, adapter, row);
  if (!check.eligible || !transcript) return check;

  // Snapshot the indexed text the rebuild came from. The rebuilt file only
  // carries a lossy copy of it (marked so adapters skip it), so the indexer
  // restores this snapshot ahead of any real turns appended after resuming.
  // Replaced on every rebuild: `messages` already contains the previous
  // snapshot plus whatever was added since.
  db.transaction(() => {
    db.prepare('DELETE FROM messages_archive WHERE session_agent = ? AND session_id = ?').run(row.agent, row.id);
    db.prepare(
      `INSERT INTO messages_archive (session_agent, session_id, seq, role, timestamp, text)
       SELECT session_agent, session_id, seq, role, timestamp, text FROM messages
       WHERE session_agent = ? AND session_id = ?`
    ).run(row.agent, row.id);
  })();

  const { filePath } = resolveSessionPaths(adapter, row);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // 'wx' fails if the file appeared since the check — never overwrite a real transcript.
  fs.writeFileSync(filePath, transcript.content, { flag: 'wx', mode: 0o600 });

  const rebuiltAt = new Date().toISOString();
  // Pin the indexed mtime to the new file: nothing new to index until the
  // session is resumed and appended to.
  db.prepare('UPDATE sessions SET rebuilt_at = ?, indexed_mtime_ms = ? WHERE agent = ? AND id = ?').run(
    rebuiltAt,
    fs.statSync(filePath).mtimeMs,
    row.agent,
    row.id
  );

  return { ...check, rebuiltAt };
}
