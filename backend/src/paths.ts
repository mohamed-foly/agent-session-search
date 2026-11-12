import path from 'path';
import Database from 'better-sqlite3';
import { AgentAdapter } from './adapters/types';

/**
 * Where a session's transcript lives depends on the environment: a host run sees
 * ~/.claude/projects/<dir>/<id>.jsonl, the Docker container sees
 * /sessions/claude-code/<dir>/<id>.jsonl. Storing either absolute path in the index
 * made it wrong the moment the other environment used it, so the index stores the
 * part that never changes (the path *under the agent's sessions root*) and the full
 * path is worked out at runtime from the current environment's roots.
 */

/** The columns that locate a session's transcript. */
export interface StoredPaths {
  file_path: string;
  display_path: string;
  /** Path under the agent's sessions root, with "/" separators. Null on rows not yet backfilled. */
  rel_path: string | null;
}

export interface ResolvedPaths {
  /** The file as this process can open it. */
  filePath: string;
  /** The path to show the user (the real host path when running in Docker). */
  displayPath: string;
}

/** `abs` relative to `root`, or null if `abs` is not inside `root`. Always "/"-separated. */
export function relPathUnder(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Works out the relative path of a stored absolute path (a row written before
 * rel_path existed), by trying every root the path could have been recorded under:
 * this environment's sessions dir and host dir, and the container mount convention.
 */
export function deriveRelPath(adapter: AgentAdapter, absolutePaths: string[]): string | null {
  const roots = [adapter.sessionsDir, adapter.hostSessionsDir, `/sessions/${adapter.id}`].filter((r): r is string => !!r);
  for (const abs of absolutePaths) {
    for (const root of roots) {
      const rel = relPathUnder(root, abs);
      if (rel) return rel;
    }
  }
  return null;
}

const safeRel = (rel: string) => !rel.split('/').includes('..');

/** The transcript's real and display paths in *this* environment. */
export function resolveSessionPaths(adapter: AgentAdapter | undefined, row: StoredPaths): ResolvedPaths {
  if (adapter && row.rel_path && safeRel(row.rel_path)) {
    return {
      filePath: path.join(adapter.sessionsDir, row.rel_path),
      displayPath: path.join(adapter.hostSessionsDir ?? adapter.sessionsDir, row.rel_path),
    };
  }
  // Legacy row, or an agent that isn't enabled: all we have is what was recorded.
  return { filePath: row.file_path, displayPath: row.display_path || row.file_path };
}

/**
 * Fills in rel_path for rows that predate it. Metadata only: no message is read,
 * changed or deleted, and a path that can't be derived is left alone.
 */
export function backfillRelPaths(db: Database.Database, adapters: AgentAdapter[]): { filled: number; unresolved: number } {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const rows = db.prepare('SELECT agent, id, file_path, display_path FROM sessions WHERE rel_path IS NULL').all() as Array<{
    agent: string;
    id: string;
    file_path: string;
    display_path: string;
  }>;
  const update = db.prepare('UPDATE sessions SET rel_path = ? WHERE agent = ? AND id = ?');
  let filled = 0;
  let unresolved = 0;
  db.transaction(() => {
    for (const row of rows) {
      const adapter = byId.get(row.agent);
      const rel = adapter ? deriveRelPath(adapter, [row.file_path, row.display_path]) : null;
      if (rel) {
        update.run(rel, row.agent, row.id);
        filled += 1;
      } else {
        unresolved += 1;
      }
    }
  })();
  return { filled, unresolved };
}
