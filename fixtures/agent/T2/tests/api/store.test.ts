import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBookmarkStore } from '../../src/store/index.js';

afterEach(() => vi.useRealTimers());

describe('in-memory bookmark store', () => {
  it('copies inputs and every returned value, and isolates instances', () => {
    const store = createBookmarkStore();
    const input = { url: ' https://example.com ', title: ' Example ', tags: [' work ', ' '] };
    const created = store.create(input);
    const original = structuredClone(created);
    expect(original).toMatchObject({ url: 'https://example.com', title: 'Example', tags: ['work'] });
    input.tags.push('input mutation');
    created.title = 'return mutation';
    created.tags.push('return mutation');
    const listed = store.list();
    listed[0].tags.push('list mutation');
    listed[0].url = 'https://changed.example';
    listed.pop();
    expect(store.list()).toEqual([original]);
    expect(createBookmarkStore().list()).toEqual([]);
    expect(store.delete('unknown')).toBe(false);
    expect(store.delete(original.id)).toBe(true);
    expect(store.delete(original.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('uses unique IDs and newest insertion order even at identical timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = createBookmarkStore();
    const created = Array.from({ length: 100 }, (_, index) =>
      store.create({ url: 'https://example.com', title: String(index) }));
    expect(new Set(created.map((bookmark) => bookmark.id)).size).toBe(100);
    expect(new Set(created.map((bookmark) => bookmark.createdAt)).size).toBe(1);
    expect(store.list()).toEqual(created.reverse());
  });
});
