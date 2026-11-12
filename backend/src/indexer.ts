import fs from 'fs';
import Database from 'better-sqlite3';
import { AgentAdapter, SessionMessage } from './adapters/types';
import { relPathUnder } from './paths';

export interface IndexStats {
  agentsScanned: number;
  sessionsSeen: number;
  sessionsReindexed: number;
  startedAt: string;
  finishedAt: string;
}

let inFlight: Promise<IndexStats> | null = null;

/**
 * Full scan: for every session every adapter can see, reindex it if the
 * underlying file has changed since we last indexed it (or if we've never
 * seen it before). Cheap no-op on repeat runs once everything is caught up.
 *
 * Only one scan runs at a time: a scan awaits file reads, so two overlapping
 * scans (the interval timer plus a manual reindex, or a slow scan) would
 * interleave on the same session and collide on messages' primary key. A
 * caller that arrives mid-scan shares the running scan's result.
 */
export function runFullScan(db: Database.Database, adapters: AgentAdapter[]): Promise<IndexStats> {
  if (!inFlight) {
    inFlight = scan(db, adapters).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function scan(db: Database.Database, adapters: AgentAdapter[]): Promise<IndexStats> {
  const startedAt = new Date().toISOString();
  let sessionsSeen = 0;
  let sessionsReindexed = 0;

  const getIndexedMtime = db.prepare('SELECT indexed_mtime_ms, rel_path FROM sessions WHERE agent = ? AND id = ?');
  // What identifies a transcript across environments is its path under the sessions root.
  // The absolute file_path/display_path columns only record what the last scan saw; nothing
  // trusts them (see paths.ts), so a Docker/host switch needs no refresh and no re-index.
  const updateRelPath = db.prepare('UPDATE sessions SET rel_path = ? WHERE agent = ? AND id = ?');
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, agent, cwd, file_path, display_path, rel_path, started_at, ended_at, indexed_mtime_ms)
    VALUES (@id, @agent, @cwd, @filePath, @displayPath, @relPath, @startedAt, @endedAt, @mtimeMs)
    ON CONFLICT(agent, id) DO UPDATE SET
      cwd = excluded.cwd,
      file_path = excluded.file_path,
      display_path = excluded.display_path,
      rel_path = excluded.rel_path,
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
      // A session made of several files is as new as its newest one.
      for (const related of session.relatedFiles ?? []) {
        try {
          mtimeMs = Math.max(mtimeMs, fs.statSync(related).mtimeMs);
        } catch {
          // a related file that vanished just stops contributing
        }
      }

      const relPath = relPathUnder(adapter.sessionsDir, session.filePath);
      const row = getIndexedMtime.get(session.agent, session.sessionId) as
        | { indexed_mtime_ms: number; rel_path: string | null }
        | undefined;
      if (row && row.indexed_mtime_ms === mtimeMs) {
        // Unchanged since last index: messages are not touched. Only record the relative path if it's missing or moved.
        if (relPath && row.rel_path !== relPath) updateRelPath.run(relPath, session.agent, session.sessionId);
        continue;
      }

      // Read the whole session BEFORE touching the index. If reading fails
      // (or the process dies) the previously indexed rows and mtime stay
      // exactly as they were, and the session is retried on the next scan.
      const messages: SessionMessage[] = [];
      try {
        for await (const message of adapter.readMessages(session)) messages.push(message);
      } catch (err) {
        // One unreadable session must not stop the rest from being indexed.
        console.error(`[index] Could not read ${session.agent}/${session.sessionId}, keeping its existing index:`, err);
        continue;
      }

      // Replace the session's rows in ONE transaction: never a window where
      // the old text is deleted but the new text isn't fully in place.
      db.transaction(() => {
        deleteMessages.run(session.agent, session.sessionId);
        upsertSession.run({
          id: session.sessionId,
          agent: session.agent,
          cwd: session.cwd,
          filePath: session.filePath,
          displayPath: session.displayPath,
          relPath,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          mtimeMs,
        });

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
        for (const message of messages) {
          insertMessage.run(session.agent, session.sessionId, seq++, message.role, message.timestamp, message.text);
        }
      })();

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
