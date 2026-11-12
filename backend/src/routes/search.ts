import fs from 'fs';
import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter, MessageKind } from '../adapters/types';
import { fillArgsSlot } from '../config';
import { queryTerms, toFtsQuery } from '../fts';
import { presentRange, presentRow } from '../present';
import { cleanFtsSnippet, makeSnippet } from '../snippet';
import { pairToolResults } from '../toolPairing';
import { SessionRow, sessionMetaFromRow } from '../rebuild';

export interface SearchResult {
  agent: string;
  sessionId: string;
  cwd: string | null;
  filePath: string;
  startedAt: string | null;
  endedAt: string | null;
  matchCount: number;
  bestSnippet: string;
  /** seq of the message `bestSnippet` came from; anchors the conversation viewer. */
  bestSeq: number;
  /** What the best-matching message is, so the UI can label it. */
  bestKind: MessageKind;
  /** The stored role/record type of that message (e.g. "subagent:assistant"). */
  bestRole?: string;
  /** For a tool call or result: the tool's name (a result's comes from the call it answers). */
  bestToolName?: string;
  bestToolCallId?: string;
  /** Whether the transcript file exists, i.e. whether resuming will work. */
  available: boolean;
  rebuiltAt: string | null;
  /** Resume command with a literal `{args}` slot, for clients that supply their own flags. */
  resumeTemplate: string | null;
  /** Resume command with the server's default args (from .env) filled in. */
  resumeCommand: string | null;
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
          s.id, s.agent, s.cwd, s.file_path, s.display_path,
          s.started_at, s.ended_at, s.rebuilt_at,
          m.seq AS seq,
          snippet(messages_fts, 0, '»', '«', '…', 12) AS snippet
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN sessions s ON s.agent = m.session_agent AND s.id = m.session_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY bm25(messages_fts)
        LIMIT @maxRawMatches
        `
      )
      .all({ ...params, maxRawMatches: MAX_RAW_MATCHES }) as Array<SessionRow & { snippet: string; seq: number }>;

    const bySession = new Map<string, SearchResult>();
    for (const row of rawRows) {
      const key = `${row.agent}:${row.id}`;
      const existing = bySession.get(key);
      if (existing) {
        existing.matchCount += 1;
        continue; // keep the first (best-ranked) snippet already stored
      }

      const adapter = adapterById.get(row.agent);
      const resumeTemplate = adapter ? adapter.buildResumeTemplate(sessionMetaFromRow(row)) : null;

      bySession.set(key, {
        agent: row.agent,
        sessionId: row.id,
        cwd: row.cwd,
        filePath: row.display_path,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        matchCount: 1,
        bestSnippet: row.snippet,
        bestSeq: row.seq,
        bestKind: 'meta',
        available: fs.existsSync(row.file_path),
        rebuiltAt: row.rebuilt_at,
        resumeTemplate,
        resumeCommand: adapter && resumeTemplate ? fillArgsSlot(resumeTemplate, adapter.resumeArgs) : null,
      });
    }

    const results = Array.from(bySession.values())
      .sort((a, b) => b.matchCount - a.matchCount || (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, limit);

    // Describe each result's best message: what it is, which tool it belongs to, and an
    // excerpt cut from the cleaned text (no tool ids or block-type tokens up front).
    const terms = queryTerms(q);
    const getRow = db.prepare('SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? AND seq = ?');
    for (const r of results) {
      const stored = getRow.get(r.agent, r.sessionId, r.bestSeq) as
        | { seq: number; role: string | null; timestamp: string | null; text: string }
        | undefined;
      if (!stored) continue;
      const adapter = adapterById.get(r.agent);
      const row = presentRow(adapter, stored);
      if (row.kind === 'tool_result') {
        pairToolResults([row], presentRange(db, adapter, r.agent, r.sessionId, row.seq - 40, row.seq));
      }
      r.bestKind = row.kind;
      if (row.role) r.bestRole = row.role;
      if (row.toolName) r.bestToolName = row.toolName;
      if (row.toolCallId) r.bestToolCallId = row.toolCallId;
      r.bestSnippet = makeSnippet(row.text, terms) ?? cleanFtsSnippet(r.bestSnippet);
    }

    res.json({ results });
  });

  return router;
}
