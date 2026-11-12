const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Characters of context kept before and after the first match. */
const BEFORE = 60;
const AFTER = 120;

/**
 * A short excerpt of `text` around the first occurrence of any query term, with
 * every occurrence wrapped in » « (the markers the UI turns into highlights).
 * Built from the cleaned display text, so it never starts with an id or a
 * block-type token. Returns null if no term occurs as plain text, so the caller
 * can fall back to the full-text index's own snippet.
 */
export function makeSnippet(text: string, terms: string[]): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let first = -1;
  let firstLen = 0;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at !== -1 && (first === -1 || at < first)) {
      first = at;
      firstLen = term.length;
    }
  }
  if (first === -1) return null;

  const start = Math.max(0, first - BEFORE);
  const end = Math.min(flat.length, first + firstLen + AFTER);
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const excerpt = flat.slice(start, end).replace(pattern, (m) => `»${m}«`);
  return `${start > 0 ? '…' : ''}${excerpt}${end < flat.length ? '…' : ''}`;
}

/** Drops the flattening's leading tokens from a full-text-index snippet (the fallback path). */
export function cleanFtsSnippet(snippet: string): string {
  return snippet
    .replace(/^…?\s*(toolu_\w+\s+tool_result\s+|tool_result\s+|tool_use\s+toolu_\w+\s+\w+\s+|(?:input_text|output_text|text)\s+)/, '')
    .trim();
}
