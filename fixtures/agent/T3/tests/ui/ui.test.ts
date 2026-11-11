import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createUi } from '../../src/ui/index.js';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));

describe('UI static boundary', () => {
  it('serves the supplied absolute directory with explicit MIME types', async () => {
    const app = createUi(publicDir);
    const html = await app.request('/');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('Stash');
    const script = await app.request('/app.js');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    for (const path of ['/index.html', '/missing', '/%2e%2e%2fsrc%2ftypes.ts']) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it('rejects missing files and symlinks that escape the public directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookmark-ui-'));
    try {
      const outside = join(directory, 'secret.txt');
      const publicPath = join(directory, 'public');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(publicPath);
      await writeFile(outside, 'private');
      await symlink(outside, join(publicPath, 'index.html'));
      const app = createUi(publicPath);
      expect((await app.request('/')).status).toBe(404);
      expect((await app.request('/app.js')).status).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class Element {
  textContent = '';
  className = '';
  value = '';
  href = '';
  disabled = false;
  children: Element[] = [];
  listeners: Record<string, (event: { preventDefault(): void }) => unknown> = {};
  attributes: Record<string, string> = {};
  addEventListener(name: string, callback: Element['listeners'][string]) { this.listeners[name] = callback; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  querySelector() { return submit; }
  reset() { this.value = 'reset'; }
}
const submit = new Element();
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('browser interactions without a network', () => {
  it('loads, searches, posts, deletes and displays server errors safely', async () => {
    const nodes = Object.fromEntries(['add-form', 'search', 'bookmarks', 'error', 'status'].map((id) => [id, new Element()]));
    const calls: { url: string; options?: { method?: string; body?: string } }[] = [];
    const bookmark = { id: 'a/b', title: '<img onerror=alert(1)>', url: 'javascript:alert(1)', tags: ['<b>work</b>'] };
    let fail = false;
    const script = await readFile(join(publicDir, 'app.js'), 'utf8');
    runInNewContext(script, {
      document: { querySelector: (selector: string) => nodes[selector.slice(1)], createElement: () => new Element() },
      URL, Error,
      FormData: class { get(name: string) { return ({ url: ' https://example.com ', title: ' Example ', tags: ' work, , reading ' } as Record<string, string>)[name]; } },
      fetch: async (url: string, options?: { method?: string; body?: string }) => {
        calls.push({ url, options });
        return { ok: !fail, status: fail ? 400 : options?.method === 'DELETE' ? 204 : 200,
          json: async () => fail ? { error: 'Please use a valid URL.' } : [bookmark] };
      },
    });
    await flush();
    expect(calls[0]?.url).toBe('/api/bookmarks');
    const item = nodes.bookmarks!.children[0]!;
    expect(item.children[0]!.textContent).toBe(bookmark.title);
    expect(item.children[0]!.href).toBe('');
    nodes.search!.value = 'tag:work & notes';
    await nodes.search!.listeners.input!({ preventDefault() {} });
    await flush();
    expect(calls.at(-1)?.url).toBe('/api/bookmarks?q=tag%3Awork%20%26%20notes');
    await nodes['add-form']!.listeners.submit!({ preventDefault() {} });
    const post = calls.find((call) => call.options?.method === 'POST');
    expect(JSON.parse(post!.options!.body!)).toEqual({ url: 'https://example.com', title: 'Example', tags: ['work', 'reading'] });
    expect(nodes['add-form']!.value).toBe('reset');
    const remove = nodes.bookmarks!.children[0]!.children.at(-1)!;
    await remove.listeners.click!({ preventDefault() {} });
    expect(calls.some((call) => call.url === '/api/bookmarks/a%2Fb' && call.options?.method === 'DELETE')).toBe(true);
    fail = true;
    await nodes['add-form']!.listeners.submit!({ preventDefault() {} });
    expect(nodes.error!.textContent).toBe('Please use a valid URL.');
    expect(submit.disabled).toBe(false);
  });
});
