import { expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/index.js';
import { createBookmarkStore } from '../../src/store/index.js';
import type { Bookmark } from '../../src/types.js';

it('calls the injected search only for nonblank queries with a fresh store list', async () => {
  const store = createBookmarkStore();
  const bookmark = store.create({ url: 'https://example.com', title: 'Example' });
  const search = vi.fn((list: Bookmark[], _query: string) => {
    list[0].tags.push('search mutation');
    return list;
  });
  const app = createApi(store, search);
  for (const suffix of ['', '?q=', '?q=%20%09']) {
    expect(await (await app.request(`/api/bookmarks${suffix}`)).json()).toEqual([bookmark]);
  }
  expect(search).not.toHaveBeenCalled();
  const response = await app.request('/api/bookmarks?q=%20Example%20');
  expect(response.status).toBe(200);
  expect(search).toHaveBeenCalledOnce();
  expect(search.mock.calls[0][1]).toBe(' Example ');
  expect(store.list()).toEqual([bookmark]);
});

it.each([
  '"text"', '42', 'true', '',
  JSON.stringify({ url: '/relative', title: 'Invalid' }),
  JSON.stringify({ url: 'https://', title: 'Invalid' }),
  JSON.stringify({ url: 'https://example.com', title: 'Invalid', tags: null }),
  JSON.stringify({ url: 'https://example.com', title: 'Invalid', tags: ['ok', null] }),
])('rejects invalid bodies without creating a bookmark: %s', async (body) => {
  const store = createBookmarkStore();
  const app = createApi(store, () => []);
  const response = await app.request('/api/bookmarks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: expect.any(String) });
  expect(store.list()).toEqual([]);
});
