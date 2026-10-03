import { describe, expect, it } from 'vitest';
import { readAgentUi, writeAgentUi } from '../agent-ui-preference';
import type { DraftStore } from '../draft';

const storage = (): DraftStore => {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
};
describe('per-account local experimental view preference', () => {
  it('defaults to current and never inherits another account choice', () => {
    const store = storage();
    expect(readAgentUi(store, 'A')).toBe('current');
    expect(writeAgentUi(store, 'A', 'development')).toBe(true);
    expect(readAgentUi(store, 'A')).toBe('development');
    expect(readAgentUi(store, 'B')).toBe('current');
  });
  it('deployment disable and corrupt values always select current', () => {
    const store = storage();
    writeAgentUi(store, 'A', 'development');
    expect(readAgentUi(store, 'A', false)).toBe('current');
    store.setItem('boothnote-agent-ui:A', 'unknown');
    expect(readAgentUi(store, 'A')).toBe('current');
  });
  it('unavailable storage does not prevent using current or falsely promise persistence', () => {
    const store = { getItem: () => { throw new Error('privacy'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(readAgentUi(store, 'A')).toBe('current');
    expect(writeAgentUi(store, 'A', 'development')).toBe(false);
    expect(writeAgentUi(undefined, 'A', 'development')).toBe(false);
  });
});
