import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Bookmark } from '../../src/types.js';

describe('bookmark API (independent of search and UI)', () => {
  it('adds, lists newest first, and deletes bookmarks', async () => {
    const app = createApp();
    const first = await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/first', title: 'First' }),
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('content-type')).toContain('application/json');
    const older = await first.json() as Bookmark;
    expect(older).toMatchObject({ url: 'https://example.com/first', title: 'First', tags: [] });
    expect(older.id).toEqual(expect.any(String));
    expect(older.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(older.createdAt))).toBe(false);

    const second = await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: ' https://example.com/second ', title: ' Second ', tags: [' work ', ''] }),
    });
    expect(second.status).toBe(201);
    const newer = await second.json() as Bookmark;
    expect(newer).toMatchObject({ url: 'https://example.com/second', title: 'Second', tags: ['work'] });
    expect(newer.id).not.toBe(older.id);
    const listed = await app.request('/api/bookmarks');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([newer, older]);
    // A blank query must not invoke the still-unimplemented search module.
    expect(await (await app.request('/api/bookmarks?q=%20')).json()).toEqual([newer, older]);

    const deleted = await app.request(`/api/bookmarks/${encodeURIComponent(older.id)}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(await (await app.request('/api/bookmarks')).json()).toEqual([newer]);
    const missing = await app.request(`/api/bookmarks/${encodeURIComponent(older.id)}`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: expect.any(String) });
    expect((await app.request('/api/unknown')).status).toBe(404);
  });

  it.each([
    null, [], {},
    { url: 'not a url', title: 'Bad' },
    { url: 'javascript:alert(1)', title: 'Bad' },
    { url: 'https://example.com', title: '   ' },
    { url: 'https://example.com', title: 42 },
    { url: 42, title: 'Bad' },
    { url: 'https://example.com', title: 'Bad', tags: 'work' },
    { url: 'https://example.com', title: 'Bad', tags: [42] },
  ])('rejects invalid JSON data: %j', async (body) => {
    const app = createApp();
    const response = await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(await (await app.request('/api/bookmarks')).json()).toEqual([]);
  });

  it('rejects malformed JSON and isolates app instances', async () => {
    const app = createApp();
    const response = await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    await app.request('/api/bookmarks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', title: 'Only in first app' }),
    });
    expect(await (await createApp().request('/api/bookmarks')).json()).toEqual([]);
  });
});
