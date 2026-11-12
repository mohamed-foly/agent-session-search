import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { config, renderResumeTemplate, toDisplayPath } from '../config';
import { AgentAdapter, IndexedMessage, PresentedMessage, SessionMessage, SessionMeta } from './types';
import { presentCodexMessage } from './codexPresent';
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
/** One rollout file's header, before files are grouped into sessions. */
interface FileMeta extends SessionMeta {
  /** True for the main conversation; false for a subagent rollout sharing its session_id. */
  isPrimary: boolean;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex CLI';
  readonly sessionsDir = config.codex.sessionsDir;
  readonly hostSessionsDir = config.codex.hostSessionsDir;
  readonly resumeArgs = config.codex.resumeArgs;

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(config.codex.sessionsDir);
  }

  async *listSessions(): AsyncIterable<SessionMeta> {
    const root = config.codex.sessionsDir;
    if (!fs.existsSync(root)) return;

    // A Codex subagent writes its own rollout file whose session_meta carries the PARENT's
    // session_id but its own id. Keyed on session_id they would all collapse into one index
    // row and overwrite each other, so group the files first and index each group once.
    const groups = new Map<string, FileMeta[]>();
    for (const filePath of this.walkRolloutFiles(root)) {
      const meta = await this.readMeta(filePath);
      if (!meta) continue;
      const group = groups.get(meta.sessionId);
      if (group) group.push(meta);
      else groups.set(meta.sessionId, [meta]);
    }

    for (const files of groups.values()) {
      // The main conversation is the file whose own id is the session id; if it is gone,
      // fall back to the earliest file.
      const sorted = [...files].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
      const primary = sorted.find((f) => f.isPrimary) ?? sorted[0];
      const others = sorted.filter((f) => f !== primary);
      const starts = files.map((f) => f.startedAt).filter((t): t is string => !!t).sort();
      const ends = files.map((f) => f.endedAt).filter((t): t is string => !!t).sort();
      const { isPrimary: _ignored, ...meta } = primary;
      yield {
        ...meta,
        cwd: primary.cwd ?? files.find((f) => f.cwd)?.cwd ?? null,
        startedAt: starts[0] ?? primary.startedAt,
        endedAt: ends[ends.length - 1] ?? primary.endedAt,
        relatedFiles: others.map((f) => f.filePath),
      };
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

  private async readMeta(filePath: string): Promise<FileMeta | null> {
    let sessionId: string | null = null;
    let ownId: string | null = null;
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
        ownId = obj.payload.id ?? ownId;
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
    // Without a session_meta there is nothing to say this file is a subagent's, so treat it as a main file.
    const isPrimary = !ownId || ownId === sessionId;
    return { sessionId, agent: this.id, cwd, filePath, displayPath, startedAt, endedAt, isPrimary };
  }

  async *readMessages(session: SessionMeta): AsyncIterable<SessionMessage> {
    // The main file's rows keep their role; subagent rows get a "subagent:" prefix so they can
    // be told apart (and are shown as background activity, not as the user's conversation).
    const files = [session.filePath, ...(session.relatedFiles ?? [])];
    const rows: Array<{ message: SessionMessage; sortKey: string; file: number; index: number }> = [];

    for (let file = 0; file < files.length; file++) {
      let lastTimestamp = '';
      let index = 0;
      for await (const message of this.readFile(files[file], file === 0 ? '' : 'subagent:')) {
        // Rows without a timestamp sort with the row before them, keeping each file in order.
        if (message.timestamp) lastTimestamp = message.timestamp;
        rows.push({ message, sortKey: lastTimestamp, file, index: index++ });
      }
    }

    // Interleave the files by time (ISO timestamps sort as text); ties keep file, then line, order.
    if (files.length > 1) {
      rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.file - b.file || a.index - b.index);
    }
    for (const row of rows) yield row.message;
  }

  private async *readFile(filePath: string, rolePrefix: string): AsyncIterable<SessionMessage> {
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

      if (obj.type !== 'response_item') continue;
      const payload = obj.payload ?? {};
      const role: string = payload.role ?? payload.type ?? 'unknown';
      if (role === 'developer') continue; // boilerplate system/tooling instructions

      const text = extractText(payload.content ?? payload.output ?? payload);
      if (!text) continue;

      yield {
        role: `${rolePrefix}${role}`,
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

  presentMessage(message: IndexedMessage): PresentedMessage {
    return presentCodexMessage(message);
  }
}
