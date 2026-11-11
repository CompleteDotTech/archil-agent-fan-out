import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export function createUi(publicDir: string): Hono {
 const app = new Hono();
 const assets: Record<string,{file:string;type:string}> = {'/':{file:'index.html',type:'text/html; charset=utf-8'},'/app.js':{file:'app.js',type:'text/javascript; charset=utf-8'},'/shortlist.js':{file:'shortlist.js',type:'text/javascript; charset=utf-8'}};
 app.get('*', async c => { const asset = assets[c.req.path]; if (!asset) return c.notFound(); try { return c.body(await readFile(join(publicDir,asset.file),'utf8'),200,{'Content-Type':asset.type}); } catch { return c.notFound(); } });
 return app;
}
