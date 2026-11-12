import { MessageKind } from './adapters/types';

/** The fields of a presented row that pairing reads and fills in. */
export interface PairableRow {
  seq: number;
  kind: MessageKind;
  toolName?: string;
  toolCallId?: string;
  /** Set on a tool_result: the seq of the tool_call it answers. */
  callSeq?: number;
}

/**
 * Tells each tool_result which tool call it answers, so the viewer can say
 * "Bash result" instead of showing an opaque id.
 *
 *  - If the result carries the call's id (Claude Code), match by id.
 *  - If it carries none (Codex records only `output`), match by position: the
 *    most recent call that hasn't been answered yet. Outputs follow their own
 *    call directly, so this is reliable for sequential tool use.
 *
 * `earlier` are rows from before `rows` (a look-back, because a page can begin
 * with the results of calls on the previous page); they are read, never changed.
 * Returns how many results in `rows` could not be matched.
 */
export function pairToolResults(rows: PairableRow[], earlier: PairableRow[] = []): number {
  const mine = new Set(rows);
  const ordered = [...earlier, ...rows].sort((a, b) => a.seq - b.seq);
  const byId = new Map<string, PairableRow>();
  const unanswered: PairableRow[] = [];
  let unpaired = 0;

  for (const row of ordered) {
    if (row.kind === 'tool_call') {
      unanswered.push(row);
      if (row.toolCallId) byId.set(row.toolCallId, row);
    } else if (row.kind === 'tool_result') {
      // A result that names its call must match that call; only id-less results fall back to position.
      const call = row.toolCallId ? byId.get(row.toolCallId) : unanswered[unanswered.length - 1];
      if (call) {
        const at = unanswered.indexOf(call);
        if (at !== -1) unanswered.splice(at, 1);
        if (mine.has(row)) {
          row.callSeq = call.seq;
          if (call.toolName) row.toolName = call.toolName;
        }
      } else if (mine.has(row)) {
        unpaired++;
      }
    }
  }
  return unpaired;
}
