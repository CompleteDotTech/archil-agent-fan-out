import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ api: vi.fn(), store: vi.fn(), ui: vi.fn(), search: vi.fn() }));
vi.mock('../src/api/index.js', () => ({ createApi: calls.api }));
vi.mock('../src/store/index.js', () => ({ createBookmarkStore: calls.store }));
vi.mock('../src/ui/index.js', () => ({ createUi: calls.ui }));
vi.mock('../src/search/index.js', () => ({ searchBookmarks: calls.search }));

import { createApp } from '../src/app.js';

beforeEach(() => {
  vi.resetAllMocks();
  calls.api.mockImplementation(() => new Hono().get('/api/bookmarks', (context) => context.json([])));
  calls.store.mockReturnValue({});
  calls.ui.mockImplementation(() => new Hono().get('/', (context) => context.html('<h1>Bookmarks</h1>')));
});

it('constructs the app without invoking any implementation stub', () => {
  createApp();
  for (const factory of Object.values(calls)) expect(factory).not.toHaveBeenCalled();
});

it('serves API requests without calling UI or search and caches the store/router', async () => {
  calls.ui.mockImplementation(() => { throw new Error('not implemented'); });
  calls.search.mockImplementation(() => { throw new Error('not implemented'); });
  const app = createApp();
  for (let i = 0; i < 2; i++) {
    const response = await app.request('/api/bookmarks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  }
  expect(calls.store).toHaveBeenCalledTimes(1);
  expect(calls.api).toHaveBeenCalledTimes(1);
  expect(calls.api).toHaveBeenCalledWith(calls.store.mock.results[0].value, calls.search);
  expect(calls.ui).not.toHaveBeenCalled();
  expect(calls.search).not.toHaveBeenCalled();
});

it('serves UI requests without calling API/store/search and passes the asset directory', async () => {
  calls.api.mockImplementation(() => { throw new Error('not implemented'); });
  calls.store.mockImplementation(() => { throw new Error('not implemented'); });
  const app = createApp({ publicDir: '/chosen/public' });
  for (let i = 0; i < 2; i++) expect((await app.request('/')).status).toBe(200);
  expect(calls.ui).toHaveBeenCalledExactlyOnceWith('/chosen/public');
  expect(calls.api).not.toHaveBeenCalled();
  expect(calls.store).not.toHaveBeenCalled();
  expect(calls.search).not.toHaveBeenCalled();
});
