import { IndexedMessage, PresentedMessage } from './types';

const SUBAGENT_PREFIX = 'subagent:';

/** Lines that precede the tool name in a custom_tool_call. */
const LEADING_METADATA = [/^ctc_\w+$/, /^fc_\w+$/, /^call_\w+$/, /^(completed|in_progress|incomplete|failed)$/];
const INJECTED_USER = [/^<environment_context>/, /^<user_instructions>/, /^<permissions/, /^# AGENTS\.md instructions/];

/** Content parts flatten with a type token line before each part's text; drop those lines. */
function dropPartTokens(text: string): string {
  return text
    .split('\n')
    .filter((line) => line !== 'input_text' && line !== 'output_text')
    .join('\n');
}

function stripPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * Classifies a Codex indexed message. `role` is the payload's role or type;
 * text is flattened, so content parts keep a type token ("input_text\n...",
 * "output_text\n..."), and calls read "<type>\n<name>\n<arguments>\n<call_id>".
 */
export function presentCodexMessage(message: IndexedMessage): PresentedMessage {
  // Rows from a subagent's rollout (see CodexAdapter.readMessages). Its tool activity is shown
  // like any other; its own user/assistant text is background, not part of the user's conversation.
  if (message.role?.startsWith(SUBAGENT_PREFIX)) {
    const inner = presentCodexMessage({ ...message, role: message.role.slice(SUBAGENT_PREFIX.length) });
    return inner.kind === 'user' || inner.kind === 'assistant' ? { ...inner, kind: 'meta' } : inner;
  }
  const role = message.role ?? '';
  const text = message.text;

  switch (role) {
    case 'user': {
      const body = dropPartTokens(text).trim();
      return INJECTED_USER.some((re) => re.test(body)) ? { kind: 'meta', text: body } : { kind: 'user', text: body };
    }
    case 'assistant':
    case 'agent_message':
      return { kind: 'assistant', text: dropPartTokens(text).trim() };
    case 'function_call':
    case 'custom_tool_call': {
      // function_call:    <type> / <name> / <arguments> / <call_id>
      // custom_tool_call: <type> / <ctc_id> / <status> / <call_id> / <name> / <input>
      // So drop the type token and any leading id/status/call_id lines, take the
      // next line as the tool name, and drop a trailing call_id.
      const lines = text.split('\n');
      let i = lines[0] === role ? 1 : 0;
      let callId: string | undefined;
      while (i < lines.length - 1 && LEADING_METADATA.some((re) => re.test(lines[i]))) {
        if (/^call_\w+$/.test(lines[i])) callId = lines[i];
        i++;
      }
      const rest = lines.slice(i + 1);
      if (rest.length > 0 && /^call_\w+$/.test(rest[rest.length - 1])) callId = rest.pop();
      return { kind: 'tool_call', toolName: lines[i], toolCallId: callId, text: rest.join('\n') };
    }
    case 'web_search_call':
    case 'tool_search_call':
      return { kind: 'tool_call', toolName: role === 'web_search_call' ? 'web_search' : 'tool_search', text };
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'tool_search_output':
      // Output given as content parts flattens with a leading "text" token.
      return { kind: 'tool_result', text: dropPartTokens(stripPrefix(stripPrefix(text, `${role}\n`), 'text\n')) };
    case 'reasoning':
      return { kind: 'thinking', text: '' };
    default:
      return { kind: 'meta', text };
  }
}
