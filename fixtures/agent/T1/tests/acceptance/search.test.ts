import { describe, expect, it } from 'vitest';
import { searchBookmarks } from '../../src/search/index.js';
import type { Bookmark } from '../../src/types.js';

const bookmarks: Bookmark[] = [
  { id: 'new', url: 'https://typescriptlang.org', title: 'TypeScript Handbook', tags: ['Work', 'reference'], createdAt: '2026-11-10T12:00:00.000Z' },
  { id: 'middle', url: 'https://example.com/typescript', title: 'Weekend reading', tags: ['personal', 'workshop'], createdAt: '2026-11-09T12:00:00.000Z' },
  { id: 'old', url: 'https://example.com/guide', title: 'TypeScript patterns', tags: ['work'], createdAt: '2026-11-08T12:00:00.000Z' },
];

describe('tag and text search (independent of API and UI)', () => {
  it('matches title and URL without case sensitivity, preserving order', () => {
    expect(searchBookmarks(bookmarks, 'TYPESCRIPT').map((item) => item.id)).toEqual(['new', 'middle', 'old']);
    expect(searchBookmarks(bookmarks, 'HANDBOOK').map((item) => item.id)).toEqual(['new']);
    expect(searchBookmarks(bookmarks, 'example.COM').map((item) => item.id)).toEqual(['middle', 'old']);
  });

  it('matches complete tags and combines terms with AND', () => {
    expect(searchBookmarks(bookmarks, 'TAG:WORK').map((item) => item.id)).toEqual(['new', 'old']);
    expect(searchBookmarks(bookmarks, 'typescript tag:work patterns').map((item) => item.id)).toEqual(['old']);
    expect(searchBookmarks(bookmarks, 'tag:work tag:reference').map((item) => item.id)).toEqual(['new']);
    expect(searchBookmarks(bookmarks, 'tag:wor')).toEqual([]);
    expect(searchBookmarks(bookmarks, 'no-such-term')).toEqual([]);
  });

  it('returns everything for blank queries and never mutates the input', () => {
    const input = structuredClone(bookmarks);
    const before = structuredClone(input);
    expect(searchBookmarks(input, '')).toEqual(bookmarks);
    expect(searchBookmarks(input, '  \t\n ')).toEqual(bookmarks);
    searchBookmarks(input, 'patterns');
    expect(input).toEqual(before);
    expect(searchBookmarks([], 'tag:work')).toEqual([]);
  });
});
