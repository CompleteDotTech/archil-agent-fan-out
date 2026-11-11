import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';

/** Only these two public assets can be served, regardless of the request path. */
export function createUi(publicDir: string): Hono {
  const directory = resolve(publicDir);
  const app = new Hono();
  for (const [route, filename, contentType] of [
    ['/', 'index.html', 'text/html; charset=UTF-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=UTF-8'],
  ] as const) {
    app.get(route, async (context) => {
      try {
        const root = await realpath(directory);
        const file = await realpath(resolve(root, filename));
        const local = relative(root, file);
        if (local.startsWith('..') || isAbsolute(local)) return context.notFound();
        const contents = await readFile(file, 'utf8');
        return context.body(contents, 200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
        });
      } catch (error) {
        if (error instanceof Error && 'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return context.notFound();
        throw error;
      }
    });
  }
  return app;
}
