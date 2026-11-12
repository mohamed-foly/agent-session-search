/**
 * Per-browser overrides for each agent's extra resume-command flags. Absent
 * key = use the server's .env default; an empty string is a real override
 * ("no extra flags"). Storage can be unavailable (private mode, blocked site
 * data), so every access degrades to "no overrides".
 */
export type ResumeArgsOverrides = Record<string, string>;

const STORAGE_KEY = 'agent-session-search.resumeArgs';

export function loadResumeArgsOverrides(): ResumeArgsOverrides {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveResumeArgsOverrides(overrides: ResumeArgsOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Not persisted; the override still applies for this page load.
  }
}
