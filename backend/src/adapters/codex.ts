import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { config, renderResumeTemplate, toDisplayPath } from '../config';
import { AgentAdapter, SessionMessage, SessionMeta } from './types';
import { extractText } from './textExtract';

/**
 * Codex CLI stores transcripts under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
 * Each line is `{ type, payload, timestamp }`. The first line is normally
 * `type: "session_meta"` with `payload.session_id` / `payload.cwd`.
 * Message lines are `type: "response_item"` with
 * `payload: { type: "message", role, content: [{ type, text }] }`.
 * We skip `role: "developer"` (system/tooling instructions) since those are
 * boilerplate repeated in every session and not useful to search.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex CLI';
  readonly sessionsDir = config.codex.sessionsDir;
  readonly resumeArgs = config.codex.resumeArgs;

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(config.codex.sessionsDir);
  }

  async *listSessions(): AsyncIterable<SessionMeta> {
    const root = config.codex.sessionsDir;
    if (!fs.existsSync(root)) return;

    for (const filePath of this.walkRolloutFiles(root)) {
      const meta = await this.readMeta(filePath);
      if (meta) yield meta;
    }
  }

  private *walkRolloutFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkRolloutFiles(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield entryPath;
      }
    }
  }

  private async readMeta(filePath: string): Promise<SessionMeta | null> {
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let startedAt: string | null = null;
    let endedAt: string | null = null;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === 'session_meta' && obj.payload) {
        sessionId = obj.payload.session_id ?? obj.payload.id ?? sessionId;
        cwd = obj.payload.cwd ?? cwd;
      }
      if (typeof obj.timestamp === 'string') {
        if (!startedAt) startedAt = obj.timestamp;
        endedAt = obj.timestamp;
      }
    }

    if (!sessionId) {
      // Fall back to the uuid embedded in the rollout filename.
      const match = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i);
      sessionId = match ? match[1] : path.basename(filePath, '.jsonl');
    }

    const displayPath = toDisplayPath(filePath, config.codex.sessionsDir, config.codex.hostSessionsDir);
    return { sessionId, agent: this.id, cwd, filePath, displayPath, startedAt, endedAt };
  }

  async *readMessages(session: SessionMeta): AsyncIterable<SessionMessage> {
    const rl = readline.createInterface({
      input: fs.createReadStream(session.filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== 'response_item') continue;
      const payload = obj.payload ?? {};
      const role: string = payload.role ?? payload.type ?? 'unknown';
      if (role === 'developer') continue; // boilerplate system/tooling instructions

      const text = extractText(payload.content ?? payload.output ?? payload);
      if (!text) continue;

      yield {
        role,
        text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      };
    }
  }

  buildResumeTemplate(session: SessionMeta): string {
    return renderResumeTemplate(config.codex.resumeCommandTemplate, {
      sessionId: session.sessionId,
      cwd: session.cwd ?? '.',
    });
  }
}
