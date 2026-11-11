import {expect,it,vi} from 'vitest';
import {createNextPrLauncher} from '../../src/dashboard/next-pr.js';
const config={runId:'radar-judges-example',taskId:'T6',title:'Readable dates',targetRepo:'owner/demo',appUrl:'http://localhost:3106/',liveUrl:'http://localhost:3107/'};
async function token(app:ReturnType<typeof createNextPrLauncher>){return (await(await app.request('/')).text()).match(/const token='([^']+)'/)![1];}
function request(key:string){return {method:'POST',headers:{Origin:'http://localhost','X-Demo-Token':key,'Content-Type':'application/json'},body:'{}'};}
it('page loads, polling and reloads do not start any work or fabricate start timestamps',async()=>{
 const start=vi.fn(async()=>({prUrl:'https://github.com/owner/demo/pull/1'}));const app=createNextPrLauncher(config,{start});
 await app.request('/');await app.request('/');const state=await(await app.request('/api/demo/status')).json();
 expect(state.phase).toBe('ready');expect(state.startedAt).toBeUndefined();expect(start).not.toHaveBeenCalled();
 expect((await app.request('/api/demo/start')).status).toBe(404);
});
it('only an explicit same-origin button request starts once and uses the click time',async()=>{
 let finish!:(value:{prUrl:string})=>void;const start=vi.fn(()=>new Promise<{prUrl:string}>(resolve=>{finish=resolve;}));
 const now=vi.fn().mockReturnValueOnce('2026-11-12T01:00:00Z').mockReturnValue('2026-11-12T01:01:00Z');const app=createNextPrLauncher(config,{start,now});const key=await token(app);
 expect((await app.request('/api/demo/start',request('wrong'))).status).toBe(403);
 expect((await app.request('/api/demo/start',{...request(key),headers:{...request(key).headers,Origin:'http://elsewhere'}})).status).toBe(403);
 expect(start).not.toHaveBeenCalled();
 const result=await app.request('/api/demo/start',request(key));expect(result.status).toBe(202);expect((await result.json()).startedAt).toBe('2026-11-12T01:00:00Z');
 expect((await app.request('/api/demo/start',request(key))).status).toBe(409);expect(start).toHaveBeenCalledTimes(1);
 finish({prUrl:'https://github.com/owner/demo/pull/42'});await new Promise(resolve=>setTimeout(resolve,0));
 expect(await(await app.request('/api/demo/status')).json()).toMatchObject({phase:'completed',prUrl:'https://github.com/owner/demo/pull/42'});
 expect((await app.request('/api/demo/start',request(key))).status).toBe(409);
});
it('reports failures without exposing provider errors and does not automatically retry',async()=>{
 const start=vi.fn(async()=>{throw new Error('private provider details');});const app=createNextPrLauncher(config,{start});const key=await token(app);await app.request('/api/demo/start',request(key));await new Promise(resolve=>setTimeout(resolve,0));
 const state=await(await app.request('/api/demo/status')).json();expect(state.phase).toBe('failed');expect(JSON.stringify(state)).not.toContain('private');expect(start).toHaveBeenCalledTimes(1);
});
