import fs from 'fs';
import Database from 'better-sqlite3';
import { AgentAdapter } from './adapters/types';

export interface IndexStats {
  agentsScanned: number;
  sessionsSeen: number;
  sessionsReindexed: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Full scan: for every session every adapter can see, reindex it if the
 * underlying file has changed since we last indexed it (or if we've never
 * seen it before). Cheap no-op on repeat runs once everything is caught up.
 */
export async function runFullScan(db: Database.Database, adapters: AgentAdapter[]): Promise<IndexStats> {
  const startedAt = new Date().toISOString();
  let sessionsSeen = 0;
  let sessionsReindexed = 0;

  const getIndexedMtime = db.prepare(
    'SELECT indexed_mtime_ms FROM sessions WHERE agent = ? AND id = ?'
  );
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, agent, cwd, file_path, display_path, started_at, ended_at, indexed_mtime_ms)
    VALUES (@id, @agent, @cwd, @filePath, @displayPath, @startedAt, @endedAt, @mtimeMs)
    ON CONFLICT(agent, id) DO UPDATE SET
      cwd = excluded.cwd,
      file_path = excluded.file_path,
      display_path = excluded.display_path,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      indexed_mtime_ms = excluded.indexed_mtime_ms
  `);
  const deleteMessages = db.prepare(
    'DELETE FROM messages WHERE session_agent = ? AND session_id = ?'
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (session_agent, session_id, seq, role, timestamp, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectArchived = db.prepare(
    'SELECT role, timestamp, text FROM messages_archive WHERE session_agent = ? AND session_id = ? ORDER BY seq'
  );

  for (const adapter of adapters) {
    for await (const session of adapter.listSessions()) {
      sessionsSeen += 1;

      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(session.filePath).mtimeMs;
      } catch {
        continue; // file disappeared mid-scan
      }

      const row = getIndexedMtime.get(session.agent, session.sessionId) as
        | { indexed_mtime_ms: number }
        | undefined;
      if (row && row.indexed_mtime_ms === mtimeMs) {
        continue; // unchanged since last index
      }

      const reindexOne = db.transaction(() => {
        deleteMessages.run(session.agent, session.sessionId);
        upsertSession.run({
          id: session.sessionId,
          agent: session.agent,
          cwd: session.cwd,
          filePath: session.filePath,
          displayPath: session.displayPath,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          mtimeMs,
        });
      });
      reindexOne();

      // A rebuilt session's file holds only a lossy copy of its history (which
      // adapters skip); restore the archived original text ahead of any real
      // turns appended since, so search keeps matching it.
      const archived = selectArchived.all(session.agent, session.sessionId) as Array<{
        role: string | null;
        timestamp: string | null;
        text: string;
      }>;
      let seq = 0;
      for (const message of archived) {
        insertMessage.run(session.agent, session.sessionId, seq++, message.role, message.timestamp, message.text);
      }

      for await (const message of adapter.readMessages(session)) {
        insertMessage.run(
          session.agent,
          session.sessionId,
          seq++,
          message.role,
          message.timestamp,
          message.text
        );
      }

      sessionsReindexed += 1;
    }
  }

  return {
    agentsScanned: adapters.length,
    sessionsSeen,
    sessionsReindexed,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
