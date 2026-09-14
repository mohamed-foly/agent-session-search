import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter } from '../adapters/types';

export function sessionsRouter(db: Database.Database, adapters: AgentAdapter[]): Router {
  const router = Router();
  const adapterById = new Map(adapters.map((a) => [a.id, a]));

  router.get('/sessions/:agent/:id', (req, res) => {
    const { agent, id } = req.params;

    const session = db
      .prepare('SELECT * FROM sessions WHERE agent = ? AND id = ?')
      .get(agent, id) as
      | {
          id: string;
          agent: string;
          cwd: string | null;
          file_path: string;
          started_at: string | null;
          ended_at: string | null;
        }
      | undefined;

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
    const resumeCommand = adapter
      ? adapter.buildResumeCommand({
          sessionId: session.id,
          agent: session.agent,
          cwd: session.cwd,
          filePath: session.file_path,
          startedAt: session.started_at,
          endedAt: session.ended_at,
        })
      : null;

    res.json({
      agent: session.agent,
      sessionId: session.id,
      cwd: session.cwd,
      filePath: session.file_path,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      resumeCommand,
      messages,
    });
  });

  return router;
}
