import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

/**
 * The repo root (backend/src or backend/dist is two levels below it). Settings
 * and the default index live there no matter which directory the process was
 * started from: `npm run dev:backend` runs from backend/, and without this it
 * would ignore the root .env and open a stray backend/data/ index.
 */
const repoRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config(); // also honour a .env in the working directory (never overrides the above)

/** Expands a leading "~" to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const journalMode = (process.env.INDEX_JOURNAL_MODE ?? 'wal').trim().toLowerCase();
if (journalMode !== 'wal' && journalMode !== 'delete') {
  throw new Error(`INDEX_JOURNAL_MODE must be "wal" or "delete", got "${journalMode}"`);
}

export const config = {
  port: Number(process.env.PORT ?? 4173),
  /**
   * SQLite journal mode for the index. "wal" is fastest but needs shared memory
   * that file-sharing layers (Docker Desktop bind mounts) don't provide
   * reliably; "delete" (rollback journal) avoids that. The server uses one
   * connection, so "delete" costs nothing here.
   */
  indexJournalMode: journalMode as 'wal' | 'delete',
  // A relative path is relative to the repo root, not the working directory.
  indexDbPath: path.resolve(repoRoot, expandHome(process.env.INDEX_DB_PATH ?? './data/index.sqlite3')),
  reindexIntervalSeconds: Number(process.env.REINDEX_INTERVAL_SECONDS ?? 120),
  enabledAgents: required('ENABLED_AGENTS', 'claude-code,codex')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Per-agent settings live here rather than being scattered across adapter
  // files, so the whole set of "what's configurable" is visible in one place.
  claudeCode: {
    sessionsDir: expandHome(process.env.CLAUDE_CODE_SESSIONS_DIR ?? '~/.claude/projects'),
    // Only needed when sessionsDir is a container-internal mount path (Docker):
    // the real host path, used purely for display in search results.
    hostSessionsDir: process.env.CLAUDE_CODE_HOST_SESSIONS_DIR
      ? expandHome(process.env.CLAUDE_CODE_HOST_SESSIONS_DIR)
      : null,
    resumeCommandTemplate:
      process.env.CLAUDE_CODE_RESUME_COMMAND ?? 'cd {cwd} && claude --resume {sessionId}',
    // Extra CLI flags substituted for {args} in the resume command (or appended
    // if the template has no {args}). The UI can override this per browser.
    resumeArgs: (process.env.CLAUDE_CODE_RESUME_ARGS ?? '').trim(),
  },
  codex: {
    sessionsDir: expandHome(process.env.CODEX_SESSIONS_DIR ?? '~/.codex/sessions'),
    hostSessionsDir: process.env.CODEX_HOST_SESSIONS_DIR
      ? expandHome(process.env.CODEX_HOST_SESSIONS_DIR)
      : null,
    resumeCommandTemplate:
      process.env.CODEX_RESUME_COMMAND ?? 'cd {cwd} && codex resume {sessionId}',
    resumeArgs: (process.env.CODEX_RESUME_ARGS ?? '').trim(),
  },
};

/**
 * Maps a path under `sessionsDir` back to the equivalent path under
 * `hostSessionsDir`, for display purposes only. No-op (identity) unless
 * hostSessionsDir is configured (i.e. unless running in Docker).
 */
export function toDisplayPath(
  filePath: string,
  sessionsDir: string,
  hostSessionsDir: string | null
): string {
  if (!hostSessionsDir || !filePath.startsWith(sessionsDir)) return filePath;
  return hostSessionsDir + filePath.slice(sessionsDir.length);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

/** Placeholder left in a rendered resume command where extra CLI args go. */
export const ARGS_SLOT = '{args}';

/**
 * Renders a resume command template with session vars, keeping a literal
 * `{args}` slot so callers (API or browser) can fill in their own extra flags.
 * Templates without `{args}` get the slot appended at the end.
 */
export function renderResumeTemplate(template: string, vars: { sessionId: string; cwd: string }): string {
  const withSlot = template.includes(ARGS_SLOT) ? template : `${template} ${ARGS_SLOT}`;
  return renderTemplate(withSlot, { ...vars, args: ARGS_SLOT });
}

/** Fills the `{args}` slot left by renderResumeTemplate. */
export function fillArgsSlot(resumeTemplate: string, args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return resumeTemplate.replace(/ ?\{args\}/g, '');
  return resumeTemplate.split(ARGS_SLOT).join(trimmed);
}
