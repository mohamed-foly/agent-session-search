import { Router } from 'express';
import Database from 'better-sqlite3';
import { AgentAdapter } from '../adapters/types';
import { runFullScan } from '../indexer';

export function reindexRouter(db: Database.Database, adapters: AgentAdapter[]): Router {
  const router = Router();
  let running = false;

  router.post('/reindex', async (_req, res) => {
    if (running) {
      res.status(409).json({ error: 'a reindex is already running' });
      return;
    }
    running = true;
    try {
      const stats = await runFullScan(db, adapters);
      res.json({ stats });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally {
      running = false;
    }
  });

  return router;
}
