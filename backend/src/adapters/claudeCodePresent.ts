import { IndexedMessage, PresentedMessage } from './types';
import { isInjectedUserText, toolResultBody } from './claudeCodeRebuild';

const TOOL_ID = /^toolu_\w+$/;

/** The tool_use id a tool_result refers to: a leading line, or a trailing line after the output. */
function resultToolId(text: string): string | undefined {
  if (text.startsWith('toolu_')) {
    const first = text.split('\n', 1)[0];
    return TOOL_ID.test(first) ? first : undefined;
  }
  return /\n(toolu_\w+)$/.exec(text)?.[1];
}

/** User-role lines the CLI injects beyond the ones the rebuild already filters. */
const isInjectedForDisplay = (text: string) => isInjectedUserText(text) || text.startsWith('<task-notification>');

/**
 * Classifies a Claude Code indexed message. The index holds text flattened by
 * textExtract, so content blocks keep their type as a leading token:
 *   assistant: "thinking" | "text\n<prose>" | "tool_use\n<id>\n<Tool>\n<input>"
 *   user:      a prompt | "toolu_<id>\ntool_result\n<output>" | injected text
 * Every other role (attachment, system, mode, file-history-*, ...) is a
 * bookkeeping record, not conversation.
 */
export function presentClaudeCodeMessage(message: IndexedMessage): PresentedMessage {
  const text = message.text.trim();

  if (message.role === 'assistant') {
    if (text === 'thinking' || text.startsWith('thinking\n')) return { kind: 'thinking', text: '' };
    if (text.startsWith('text\n')) return { kind: 'assistant', text: text.slice('text\n'.length) };
    if (text.startsWith('tool_use\n')) {
      const [, toolId, toolName, ...input] = text.split('\n');
      return { kind: 'tool_call', toolName, toolCallId: TOOL_ID.test(toolId) ? toolId : undefined, text: input.join('\n') };
    }
    return { kind: 'assistant', text };
  }

  if (message.role === 'user') {
    const result = toolResultBody(text);
    if (result !== null) {
      // AskUserQuestion answers arrive as tool results but are real user input.
      return result.startsWith('The user answered')
        ? { kind: 'user', text: result }
        : { kind: 'tool_result', toolCallId: resultToolId(text), text: result };
    }
    const body = text.startsWith('text\n') ? text.slice('text\n'.length) : text;
    if (!body || isInjectedForDisplay(body)) return { kind: 'meta', text: body || message.text };
    return { kind: 'user', text: body };
  }

  return { kind: 'meta', text: message.text };
}
