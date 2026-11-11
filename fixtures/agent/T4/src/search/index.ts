import type { Bookmark } from '../types.js';

/** Filter without changing bookmarks or their incoming newest-first order. */
export function searchBookmarks(bookmarks: Bookmark[], query: string): Bookmark[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

  return bookmarks.filter((bookmark) => {
    const title = bookmark.title.toLowerCase();
    const url = bookmark.url.toLowerCase();
    const tags = bookmark.tags.map((tag) => tag.toLowerCase());

    return terms.every((term) => term.startsWith('tag:')
      ? tags.includes(term.slice(4))
      : title.includes(term) || url.includes(term));
  });
}
