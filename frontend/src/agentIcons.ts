import claudeCode from './assets/icons/claudecode-color.svg';
import codex from './assets/icons/codex-color.svg';
import bot from './assets/icons/bot.svg';

/**
 * Icon per agent id (the ids in ENABLED_AGENTS). An agent with no entry gets a
 * neutral fallback, so adding an adapter never requires touching the frontend;
 * to give a new agent its own icon, drop an SVG in assets/icons (and list it in
 * its NOTICE.md) and add one line here.
 */
const AGENT_ICONS: Record<string, string> = {
  'claude-code': claudeCode,
  codex,
};

export const FALLBACK_AGENT_ICON = bot;

export function agentIconUrl(agentId: string): { url: string; isFallback: boolean } {
  const url = AGENT_ICONS[agentId];
  return url ? { url, isFallback: false } : { url: FALLBACK_AGENT_ICON, isFallback: true };
}
