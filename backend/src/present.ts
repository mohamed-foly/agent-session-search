import Database from 'better-sqlite3';
import { AgentAdapter, IndexedMessage, MessageKind, PresentedMessage } from './adapters/types';
import { PairableRow } from './toolPairing';

/** Display form of an indexed message: the adapter's own, or a generic fallback. */
export function presentMessage(adapter: AgentAdapter | undefined, message: IndexedMessage): PresentedMessage {
  if (adapter?.presentMessage) return adapter.presentMessage(message);
  if (message.role === 'user' || message.role === 'assistant') return { kind: message.role, text: message.text };
  return { kind: 'meta', text: message.text };
}

export interface PresentedRow extends PairableRow {
  role: string | null;
  timestamp: string | null;
  text: string;
}

/** Presents one stored row. */
export function presentRow(
  adapter: AgentAdapter | undefined,
  row: { seq: number; role: string | null; timestamp: string | null; text: string }
): PresentedRow {
  const p = presentMessage(adapter, { role: row.role, timestamp: row.timestamp, text: row.text });
  const out: PresentedRow = { seq: row.seq, role: row.role, timestamp: row.timestamp, kind: p.kind as MessageKind, text: p.text };
  if (p.toolName) out.toolName = p.toolName;
  if (p.toolCallId) out.toolCallId = p.toolCallId;
  return out;
}

/** How far back to look for the call a tool result answers (observed: at most 7 rows). */
export const CALL_LOOKBACK_ROWS = 150;

/** Presented rows with fromSeq <= seq < toSeq, ascending. */
export function presentRange(
  db: Database.Database,
  adapter: AgentAdapter | undefined,
  agent: string,
  sessionId: string,
  fromSeq: number,
  toSeq: number
): PresentedRow[] {
  const rows = db
    .prepare(
      'SELECT seq, role, timestamp, text FROM messages WHERE session_agent = ? AND session_id = ? AND seq >= ? AND seq < ? ORDER BY seq'
    )
    .all(agent, sessionId, Math.max(0, fromSeq), toSeq) as Array<{ seq: number; role: string | null; timestamp: string | null; text: string }>;
  return rows.map((r) => presentRow(adapter, r));
}
