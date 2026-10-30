// The text pools put whole phrases ("8 bundles of firewood") where {qty} stands, so the pool must not add its own unit words.
import { describe, expect, it } from 'vitest';
import happenings from '../../../src/content/happenings.json';

describe('request texts', () => {
  it('do not double the unit after {qty}', () => {
    const asks: string[] = (happenings as unknown as { requests: { fetch: { ask: string[] } } }).requests.fetch.ask;
    expect(asks.length).toBeGreaterThan(0);
    for (const t of asks) expect(t, t).not.toMatch(/\{qty\}\s+of\b/);
  });
});
