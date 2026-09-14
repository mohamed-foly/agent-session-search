import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter } from '../adapters/types';

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

/** Turns free-text user input into an FTS5 query, escaping quotes so odd
 * input (paths, punctuation) can't break the MATCH syntax. */
function toFtsQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.join(' ');
}

export function searchRouter(db: Database.Database, adapters: AgentAdapter[]): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((a) => [a.id, a]));

  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const agentFilter = req.query.agent ? String(req.query.agent) : null;
    const cwdFilter = req.query.cwd ? String(req.query.cwd) : null;
    const dateFrom = req.query.from ? String(req.query.from) : null;
    const dateTo = req.query.to ? String(req.query.to) : null;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    if (!q) {
      res.json({ results: [] satisfies SearchResult[] });
      return;
    }

    const conditions: string[] = ['messages_fts MATCH @query'];
    const params: Record<string, unknown> = { query: toFtsQuery(q), limit };

    if (agentFilter) {
      conditions.push('m.session_agent = @agent');
      params.agent = agentFilter;
    }
    if (cwdFilter) {
      conditions.push('s.cwd LIKE @cwd');
      params.cwd = `%${cwdFilter}%`;
    }
    if (dateFrom) {
      conditions.push('s.ended_at >= @dateFrom');
      params.dateFrom = dateFrom;
    }
    if (dateTo) {
      conditions.push('s.started_at <= @dateTo');
      params.dateTo = dateTo;
    }

    // snippet()/bm25() may only be used in the top-level SELECT that performs
    // the MATCH — SQLite rejects them inside a subquery or under GROUP BY.
    // So we fetch matching messages ranked by relevance here, and group them
    // into per-session results in JS below.
    const MAX_RAW_MATCHES = 1000;
    const rawRows = db
      .prepare(
        `
        SELECT
          s.agent AS agent,
          s.id AS sessionId,
          s.cwd AS cwd,
          s.file_path AS filePath,
          s.started_at AS startedAt,
          s.ended_at AS endedAt,
          snippet(messages_fts, 0, '»', '«', '…', 12) AS snippet
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN sessions s ON s.agent = m.session_agent AND s.id = m.session_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY bm25(messages_fts)
        LIMIT @maxRawMatches
        `
      )
      .all({ ...params, maxRawMatches: MAX_RAW_MATCHES }) as Array<{
      agent: string;
      sessionId: string;
      cwd: string | null;
      filePath: string;
      startedAt: string | null;
      endedAt: string | null;
      snippet: string;
    }>;

    const bySession = new Map<string, SearchResult>();
    for (const row of rawRows) {
      const key = `${row.agent}:${row.sessionId}`;
      const existing = bySession.get(key);
      if (existing) {
        existing.matchCount += 1;
        continue; // keep the first (best-ranked) snippet already stored
      }

      const adapter = adapterById.get(row.agent);
      const resumeCommand = adapter
        ? adapter.buildResumeCommand({
            sessionId: row.sessionId,
            agent: row.agent,
            cwd: row.cwd,
            filePath: row.filePath,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
          })
        : null;

      bySession.set(key, {
        agent: row.agent,
        sessionId: row.sessionId,
        cwd: row.cwd,
        filePath: row.filePath,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        matchCount: 1,
        bestSnippet: row.snippet,
        resumeCommand,
      });
    }

    const results = Array.from(bySession.values())
      .sort((a, b) => b.matchCount - a.matchCount || (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, limit);

    res.json({ results });
  });

  return router;
}
