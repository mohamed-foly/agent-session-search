import { Router } from 'express';
import { AgentAdapter } from '../adapters/types';

export function agentsRouter(adapters: AgentAdapter[]): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    res.json({
      agents: adapters.map((a) => ({ id: a.id, label: a.label })),
    });
  });

  return router;
}
