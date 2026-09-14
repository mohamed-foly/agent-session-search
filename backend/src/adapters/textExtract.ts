/**
 * Session file schemas evolve across agent CLI versions. Rather than
 * hard-coding every possible shape, we walk each parsed JSON line and pull
 * out any string values that look like real content (prose, code, tool
 * output, file paths, JSON payloads, ...), skipping obvious binary/base64
 * blobs. This keeps adapters resilient to schema drift and gives search the
 * same recall you'd get from a manual `grep` over the raw file.
 */

const MAX_FIELD_LEN = 20_000;
const MAX_TOTAL_LEN = 50_000;

function looksLikeBinaryBlob(value: string): boolean {
  if (value.length < 200) return false;
  // Long strings with no whitespace at all are almost always base64/hex/binary
  // dumps (certs, keys, images) rather than anything worth indexing.
  return !/\s/.test(value);
}

export function extractText(value: unknown, budget = { remaining: MAX_TOTAL_LEN }): string {
  const parts: string[] = [];

  function walk(node: unknown): void {
    if (budget.remaining <= 0) return;
    if (typeof node === 'string') {
      if (!node || looksLikeBinaryBlob(node)) return;
      const slice = node.slice(0, Math.min(MAX_FIELD_LEN, budget.remaining));
      parts.push(slice);
      budget.remaining -= slice.length;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (budget.remaining <= 0) break;
        walk(item);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        if (budget.remaining <= 0) break;
        walk((node as Record<string, unknown>)[key]);
      }
    }
  }

  walk(value);
  return parts.join('\n');
}
