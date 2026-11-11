export interface Bookmark {
  id: string;
  url: string;
  title: string;
  tags: string[];
  createdAt: string;
}

export interface NewBookmark {
  url: string;
  title: string;
  tags?: string[];
}

/** Synchronous in-memory product store; each app owns its own instance. */
export interface BookmarkStore {
  list(): Bookmark[];
  create(input: NewBookmark): Bookmark;
  delete(id: string): boolean;
}

export type SearchBookmarks = (bookmarks: Bookmark[], query: string) => Bookmark[];
