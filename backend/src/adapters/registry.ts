import { config } from '../config';
import { AgentAdapter } from './types';
import { ClaudeCodeAdapter } from './claudeCode';
import { CodexAdapter } from './codex';

/**
 * Every adapter this build knows how to construct, keyed by the id used in
 * ENABLED_AGENTS. Adding a new agent: implement AgentAdapter in its own file
 * under adapters/, then add one line here. Nothing else needs to change.
 */
const ADAPTER_FACTORIES: Record<string, () => AgentAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

export async function loadEnabledAdapters(): Promise<AgentAdapter[]> {
  const adapters: AgentAdapter[] = [];

  for (const id of config.enabledAgents) {
    const factory = ADAPTER_FACTORIES[id];
    if (!factory) {
      console.warn(`[registry] Unknown agent id "${id}" in ENABLED_AGENTS, skipping.`);
      continue;
    }
    const adapter = factory();
    if (await adapter.isAvailable()) {
      adapters.push(adapter);
    } else {
      console.warn(
        `[registry] Adapter "${id}" is configured but not available (sessions directory not found), skipping.`
      );
    }
  }

  return adapters;
}
