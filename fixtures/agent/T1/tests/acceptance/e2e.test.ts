import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Bookmark } from '../../src/types.js';

it('serves the UI and completes an add/list/search/delete session in one app', async () => {
  const app = createApp();
  expect((await app.request('/')).status).toBe(200);
  expect((await app.request('/app.js')).status).toBe(200);
  const saved: Bookmark[] = [];
  for (const input of [
    { url: 'https://example.com/work', title: 'Team handbook', tags: ['work'] },
    { url: 'https://example.com/home', title: 'Weekend plans', tags: ['personal'] },
  ]) {
    const response = await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    saved.push(await response.json() as Bookmark);
  }
  expect(await (await app.request('/api/bookmarks')).json()).toEqual([saved[1], saved[0]]);
  const search = await app.request(`/api/bookmarks?q=${encodeURIComponent('HANDBOOK tag:WORK')}`);
  expect(search.status).toBe(200);
  expect(await search.json()).toEqual([saved[0]]);
  const deletion = await app.request(`/api/bookmarks/${encodeURIComponent(saved[0].id)}`, { method: 'DELETE' });
  expect(deletion.status).toBe(204);
  expect(await (await app.request('/api/bookmarks?q=tag%3Awork')).json()).toEqual([]);
  expect(await (await app.request('/api/bookmarks')).json()).toEqual([saved[1]]);
});
