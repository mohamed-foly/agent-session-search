import 'dotenv/config';
import os from 'os';
import path from 'path';

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

export const config = {
  port: Number(process.env.PORT ?? 4173),
  indexDbPath: expandHome(process.env.INDEX_DB_PATH ?? './data/index.sqlite3'),
  reindexIntervalSeconds: Number(process.env.REINDEX_INTERVAL_SECONDS ?? 120),
  enabledAgents: required('ENABLED_AGENTS', 'claude-code,codex')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Per-agent settings live here rather than being scattered across adapter
  // files, so the whole set of "what's configurable" is visible in one place.
  claudeCode: {
    sessionsDir: expandHome(process.env.CLAUDE_CODE_SESSIONS_DIR ?? '~/.claude/projects'),
    resumeCommandTemplate:
      process.env.CLAUDE_CODE_RESUME_COMMAND ?? 'cd {cwd} && claude --resume {sessionId}',
  },
  codex: {
    sessionsDir: expandHome(process.env.CODEX_SESSIONS_DIR ?? '~/.codex/sessions'),
    resumeCommandTemplate:
      process.env.CODEX_RESUME_COMMAND ?? 'cd {cwd} && codex resume {sessionId}',
  },
};

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}
