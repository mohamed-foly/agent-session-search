import { Fragment, ReactNode } from 'react';

/** The words of a search query, split the way the backend's toFtsQuery splits them. */
export function queryTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text with the query terms wrapped in <mark>. Built from React nodes, never
 * an HTML string, so transcript content can't inject markup.
 */
export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (terms.length === 0 || !text) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  // With one capture group, split() puts the matches at the odd indices.
  return text.split(pattern).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

/** A search snippet from the server: matches are wrapped in » « markers. */
export function Snippet({ value }: { value: string }): ReactNode {
  return value.split('»').map((part, i) => {
    if (i === 0) return <Fragment key={i}>{part}</Fragment>;
    const [match, ...rest] = part.split('«');
    return (
      <Fragment key={i}>
        <mark>{match}</mark>
        {rest.join('«')}
      </Fragment>
    );
  });
}
