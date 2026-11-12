import fs from 'fs';
import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter, MessageKind } from '../adapters/types';
import { toFtsQuery } from '../fts';
import { resolveSessionPaths } from '../paths';
import { CALL_LOOKBACK_ROWS, presentRange, presentRow } from '../present';
import { pairToolResults } from '../toolPairing';
import { fillArgsSlot } from '../config';
import { SessionRow, checkRebuild, performRebuild, sessionMetaFromRow } from '../rebuild';

/** Bookkeeping records can be huge (API dumps); the viewer only needs a peek. */
const META_PREVIEW_CHARS = 2000;
/** Upper bound on rows in one response, however many tool steps sit between turns. */
const MAX_ROWS_PER_PAGE = 400;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

interface ViewMessage {
  seq: number;
  role: string | null;
  timestamp: string | null;
  kind: MessageKind;
  text: string;
  toolName?: string;
  toolCallId?: string;
  /** On a tool_result: the seq of the tool_call it answers. */
  callSeq?: number;
  /** Set when `text` was cut (meta records only). */
  fullLength?: number;
}

function clampCount(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (value === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), MAX_PAGE);
}

export function sessionsRouter(db: Database.Database, adapters: AgentAdapter[]): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((a) => [a.id, a]));

  const findSession = (agent: string, id: string) =>
    db.prepare('SELECT * FROM sessions WHERE agent = ? AND id = ?').get(agent, id) as SessionRow | undefined;

  router.get('/sessions/:agent/:id', (req, res) => {
    const { agent, id } = req.params;
    const session = findSession(agent, id);

    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }

    // ?messages=0 returns just the header (the viewer pages messages itself).
    const messages =
      req.query.messages === '0'
        ? undefined
        : db
            .prepare(
              'SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? ORDER BY seq'
            )
            .all(agent, id);

    const adapter = adapterById.get(agent);
    const paths = resolveSessionPaths(adapter, session);
    const resumeTemplate = adapter ? adapter.buildResumeTemplate(sessionMetaFromRow(session, adapter)) : null;

    res.json({
      agent: session.agent,
      sessionId: session.id,
      cwd: session.cwd,
      filePath: paths.displayPath,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      available: fs.existsSync(paths.filePath),
      rebuiltAt: session.rebuilt_at,
      resumeTemplate,
      resumeCommand: adapter && resumeTemplate ? fillArgsSlot(resumeTemplate, adapter.resumeArgs) : null,
      messages,
    });
  });

  /**
   * A window of one session's messages around `anchor`, read from the index
   * (so it works for sessions whose transcript file is gone).
   *   anchor  seq to centre on; "start" (first message) or "end" (just after the last)
   *   before  how many user/assistant turns to return before the anchor (default 20, max 100)
   *   after   how many to return from the anchor on, anchor included (default 20, max 100)
   * Bookkeeping ("meta") and tool rows that fall inside the window come along
   * but don't count toward the quota. Rows are returned in ascending seq order.
   */
  router.get('/sessions/:agent/:id/messages', (req, res) => {
    const { agent, id } = req.params;
    if (!findSession(agent, id)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const adapter = adapterById.get(agent);

    const bounds = db
      .prepare('SELECT COUNT(*) AS total, MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM messages WHERE session_agent = ? AND session_id = ?')
      .get(agent, id) as { total: number; minSeq: number | null; maxSeq: number | null };

    const rawAnchor = String(req.query.anchor ?? 'start');
    let anchor: number;
    if (rawAnchor === 'start') anchor = bounds.minSeq ?? 0;
    else if (rawAnchor === 'end') anchor = (bounds.maxSeq ?? -1) + 1;
    else if (/^\d+$/.test(rawAnchor)) anchor = Number(rawAnchor);
    else {
      res.status(400).json({ error: 'anchor must be a seq number, "start" or "end"' });
      return;
    }
    const before = clampCount(req.query.before, DEFAULT_PAGE);
    const after = clampCount(req.query.after, DEFAULT_PAGE);

    const present = (row: { seq: number; role: string | null; timestamp: string | null; text: string }): ViewMessage => {
      const view: ViewMessage = presentRow(adapter, row);
      if (view.kind === 'meta' && view.text.length > META_PREVIEW_CHARS) {
        view.fullLength = view.text.length;
        view.text = view.text.slice(0, META_PREVIEW_CHARS);
      }
      return view;
    };
    const counts = (kind: MessageKind) => kind === 'user' || kind === 'assistant';

    // Walk outward from the anchor in each direction, stopping once the quota
    // of turns is met (or the row cap is hit). iterate() lets us stop early
    // without loading the rest of an 11k-message session.
    const walk = (sql: string, quota: number, budget: number): ViewMessage[] => {
      const out: ViewMessage[] = [];
      if (quota === 0 || budget <= 0) return out;
      let turns = 0;
      for (const row of db.prepare(sql).iterate(agent, id, anchor) as Iterable<{
        seq: number;
        role: string | null;
        timestamp: string | null;
        text: string;
      }>) {
        const view = present(row);
        out.push(view);
        if (counts(view.kind) && ++turns >= quota) break;
        if (out.length >= budget) break;
      }
      return out;
    };

    const later = walk(
      'SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? AND seq >= ? ORDER BY seq',
      after,
      MAX_ROWS_PER_PAGE
    );
    const earlier = walk(
      'SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? AND seq < ? ORDER BY seq DESC',
      before,
      MAX_ROWS_PER_PAGE
    ).reverse();

    const firstSeq = earlier.length ? earlier[0].seq : later.length ? later[0].seq : anchor;
    const lastSeq = later.length ? later[later.length - 1].seq : earlier.length ? earlier[earlier.length - 1].seq : anchor - 1;
    // Say which tool each result answers. A page can start with results whose calls
    // are on the previous page, so look back for those only when something is left unmatched.
    const windowRows = [...earlier, ...later];
    if (pairToolResults(windowRows) > 0 && windowRows.length > 0) {
      const start = windowRows[0].seq;
      pairToolResults(windowRows, presentRange(db, adapter, agent, id, start - CALL_LOOKBACK_ROWS, start));
    }

    const hasMoreBefore = bounds.minSeq !== null && bounds.minSeq < firstSeq;
    const hasMoreAfter = bounds.maxSeq !== null && bounds.maxSeq > lastSeq;

    res.json({ messages: windowRows, hasMoreBefore, hasMoreAfter, total: bounds.total });
  });

  // seq of every message in this session matching `q` (same matching as /search).
  router.get('/sessions/:agent/:id/matches', (req, res) => {
    const { agent, id } = req.params;
    if (!findSession(agent, id)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ seqs: [] });
      return;
    }
    const rows = db
      .prepare(
        `SELECT m.seq FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.session_agent = ? AND m.session_id = ?
         ORDER BY m.seq LIMIT 1000`
      )
      .all(toFtsQuery(q), agent, id) as Array<{ seq: number }>;
    res.json({ seqs: rows.map((r) => r.seq) });
  });

  // Dry run: can this session's missing transcript be rebuilt from the index?
  router.get('/sessions/:agent/:id/rebuild', (req, res) => {
    const { agent, id } = req.params;
    const session = findSession(agent, id);
    const adapter = adapterById.get(agent);
    if (!session || !adapter) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(checkRebuild(db, adapter, session));
  });

  router.post('/sessions/:agent/:id/rebuild', (req, res) => {
    // The API allows any origin (cors()) for reads, but this writes to the
    // host: refuse cross-site requests so another open tab can't trigger it.
    // Browsers always send Origin on POST; curl and other CLI clients don't.
    const origin = req.get('origin');
    if (origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.get('host');
      } catch {
        // malformed Origin header: treat as cross-site
      }
      if (!sameHost) {
        res.status(403).json({ error: 'cross-origin rebuild requests are not allowed' });
        return;
      }
    }

    const { agent, id } = req.params;
    const session = findSession(agent, id);
    const adapter = adapterById.get(agent);
    if (!session || !adapter) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    try {
      const result = performRebuild(db, adapter, session);
      res.status(result.eligible ? 200 : 409).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
