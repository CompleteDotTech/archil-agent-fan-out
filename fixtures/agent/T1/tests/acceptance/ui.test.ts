import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('single-page UI (independent of API and store)', () => {
  it('serves the form, search, list and error area', async () => {
    const response = await createApp().request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toMatch(/<form\b[^>]*\bid=["']add-form["']/i);
    for (const name of ['url', 'title', 'tags']) {
      expect(html).toMatch(new RegExp(`<input\\b[^>]*\\bname=["']${name}["']`, 'i'));
    }
    for (const id of ['search', 'bookmarks', 'error']) {
      expect(html).toMatch(new RegExp(`\\bid=["']${id}["']`, 'i'));
    }
    expect(html).toMatch(/<script\b[^>]*\bsrc=["']\/app\.js["']/i);
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//i);
  });

  it('serves dependency-free JavaScript with API interactions', async () => {
    const response = await createApp().request('/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/(?:java|ecma)script/);
    const script = await response.text();
    expect(script).toContain('/api/bookmarks');
    expect(script).toMatch(/\bfetch\s*\(/);
    expect(script).toContain('POST');
    expect(script).toContain('DELETE');
    expect(script).toContain('JSON.stringify');
    expect(script).toContain('encodeURIComponent');
    expect(script).toContain('textContent');
    expect(script).toMatch(/addEventListener\s*\(/);
    expect(script).not.toContain('not implemented');
  });

  it('returns 404 for missing assets and traversal paths', async () => {
    const app = createApp();
    expect((await app.request('/missing-file.js')).status).toBe(404);
    expect((await app.request('/%2e%2e%2fsrc%2ftypes.ts')).status).toBe(404);
  });
});
