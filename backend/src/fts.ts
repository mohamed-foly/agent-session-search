/** Turns free-text user input into an FTS5 query, escaping quotes so odd
 * input (paths, punctuation) can't break the MATCH syntax. */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.join(' ');
}

/** The words of a query, split the way toFtsQuery splits them. */
export function queryTerms(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean).slice(0, 10);
}
