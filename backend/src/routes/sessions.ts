import fs from 'fs';
import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter } from '../adapters/types';
import { fillArgsSlot } from '../config';
import { SessionRow, checkRebuild, performRebuild, sessionMetaFromRow } from '../rebuild';

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

    const messages = db
      .prepare(
        'SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? ORDER BY seq'
      )
      .all(agent, id);

    const adapter = adapterById.get(agent);
    const resumeTemplate = adapter ? adapter.buildResumeTemplate(sessionMetaFromRow(session)) : null;

    res.json({
      agent: session.agent,
      sessionId: session.id,
      cwd: session.cwd,
      filePath: session.display_path,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      available: fs.existsSync(session.file_path),
      rebuiltAt: session.rebuilt_at,
      resumeTemplate,
      resumeCommand: adapter && resumeTemplate ? fillArgsSlot(resumeTemplate, adapter.resumeArgs) : null,
      messages,
    });
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
