import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { openDb } from './db';
import { loadEnabledAdapters } from './adapters/registry';
import { runFullScan } from './indexer';
import { searchRouter } from './routes/search';
import { sessionsRouter } from './routes/sessions';
import { agentsRouter } from './routes/agents';
import { reindexRouter } from './routes/reindex';

async function main(): Promise<void> {
  const db = openDb();
  const adapters = await loadEnabledAdapters();

  if (adapters.length === 0) {
    console.warn(
      '[startup] No agent adapters are available — check ENABLED_AGENTS and the *_SESSIONS_DIR paths in .env'
    );
  } else {
    console.log(`[startup] Enabled adapters: ${adapters.map((a) => a.id).join(', ')}`);
  }

  console.log('[startup] Running initial index scan...');
  const initialStats = await runFullScan(db, adapters);
  console.log(
    `[startup] Indexed ${initialStats.sessionsReindexed} session(s) (of ${initialStats.sessionsSeen} seen).`
  );

  setInterval(async () => {
    try {
      const stats = await runFullScan(db, adapters);
      if (stats.sessionsReindexed > 0) {
        console.log(`[reindex] Reindexed ${stats.sessionsReindexed} changed session(s).`);
      }
    } catch (err) {
      console.error('[reindex] Background reindex failed:', err);
    }
  }, config.reindexIntervalSeconds * 1000);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api', searchRouter(db, adapters));
  app.use('/api', sessionsRouter(db, adapters));
  app.use('/api', agentsRouter(adapters));
  app.use('/api', reindexRouter(db, adapters));

  // Serve the built frontend, if present (production/Docker mode). In dev
  // mode, run the Vite dev server separately (npm run dev:frontend).
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.listen(config.port, () => {
    console.log(`[startup] Agent Session Search listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
