import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { config, renderTemplate } from '../config';
import { AgentAdapter, SessionMessage, SessionMeta } from './types';
import { extractText } from './textExtract';

/**
 * Claude Code stores one directory per working-directory under
 * `~/.claude/projects/<encoded-cwd>/`, each holding "<session-id>.jsonl"
 * transcripts (one JSON object per line: { type, message: { role, content }, cwd, timestamp, ... }).
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(config.claudeCode.sessionsDir);
  }

  async *listSessions(): AsyncIterable<SessionMeta> {
    const root = config.claudeCode.sessionsDir;
    if (!fs.existsSync(root)) return;

    for (const projectDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(root, projectDir.name);

      for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectPath, entry.name);
        const sessionId = entry.name.replace(/\.jsonl$/, '');

        const meta = await this.readMeta(filePath, sessionId);
        yield meta;
      }
    }
  }

  private async readMeta(filePath: string, sessionId: string): Promise<SessionMeta> {
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
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (typeof obj.timestamp === 'string') {
        if (!startedAt) startedAt = obj.timestamp;
        endedAt = obj.timestamp;
      }
    }

    return { sessionId, agent: this.id, cwd, filePath, startedAt, endedAt };
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

      const role: string = obj?.message?.role ?? obj?.type ?? 'unknown';
      const text = extractText(obj?.message?.content ?? obj?.toolUseResult ?? obj);
      if (!text) continue;

      yield {
        role,
        text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
      };
    }
  }

  buildResumeCommand(session: SessionMeta): string {
    return renderTemplate(config.claudeCode.resumeCommandTemplate, {
      sessionId: session.sessionId,
      cwd: session.cwd ?? '.',
    });
  }
}
