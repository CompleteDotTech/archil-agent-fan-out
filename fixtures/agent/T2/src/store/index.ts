import { randomUUID } from 'node:crypto';
import type { Bookmark, BookmarkStore } from '../types.js';

function copy(bookmark: Bookmark): Bookmark {
  return { ...bookmark, tags: [...bookmark.tags] };
}

export function createBookmarkStore(): BookmarkStore {
  const bookmarks: Bookmark[] = [];

  return {
    list: () => bookmarks.map(copy),
    create(input) {
      const bookmark: Bookmark = {
        id: randomUUID(),
        url: input.url.trim(),
        title: input.title.trim(),
        tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
        createdAt: new Date().toISOString(),
      };
      // Insertion order stays authoritative when timestamps tie.
      bookmarks.unshift(bookmark);
      return copy(bookmark);
    },
    delete(id) {
      const index = bookmarks.findIndex((bookmark) => bookmark.id === id);
      if (index === -1) return false;
      bookmarks.splice(index, 1);
      return true;
    },
  };
}
