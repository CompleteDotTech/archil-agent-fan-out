/** Serve a preserved delivery and its recorded engineering evidence without cloud compute. */
import { readFile, mkdir, access, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { MemoryStore } from '../src/contracts/fakes.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { SharedDisk, Plan, SwarmEvent } from '../src/contracts/types.js';
const {values} = parseArgs({options:{run:{type:'string'},port:{type:'string',default:'3200'}}});
if (!values.run || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(values.run)) throw new Error('Pass --run <preserved run ID>');
const runId=values.run, root=resolve('.swarm/radar',runId), appRoot=join(root,'app');
const port=Number(values.port);
if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid port');
try { await access(join(appRoot,'src/app.ts')); }
catch { await mkdir(appRoot,{recursive:true}); await promisify(execFile)('tar',['-xzf',join(root,'app.tgz'),'-C',appRoot]); }
try { await access(join(appRoot,'node_modules')); } catch { await symlink(resolve('node_modules'),join(appRoot,'node_modules')); }
const dataset=JSON.parse(await readFile(join(root,'dataset.json'),'utf8'));
const disk:SharedDisk={
 async read(path) { if (!path.startsWith('/')||path.split('/').some(s=>s==='.'||s==='..')) throw new Error('Unsafe artifact path'); try{return await readFile(join(root,'artifacts',path.slice(1)),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;} },
 async write(){throw new Error('Recorded evidence is read only');},async list(){return [];},
};
const plan=JSON.parse((await disk.read(`/spec/${runId}/plan.json`))!) as Plan;
const store=new MemoryStore(); await store.init(); await store.savePlan(plan);
const entries=JSON.parse(await readFile(join(root,'events.json'),'utf8')) as {event:SwarmEvent}[];
for(const {event} of entries){ await store.appendEvent(event);
 if(event.type==='plan.published') for(const [id,number] of Object.entries(event.data.issues as Record<string,number>)) await store.setIssueNumber(runId,id,number);
 if(event.type==='attempt.started' && event.taskId && event.attemptId) await store.createAttempt({runId,taskId:event.taskId,attemptId:event.attemptId,n:Number(event.attemptId.match(/a(\d+)$/)?.[1]??1),sandboxId:String(event.data.sandboxId),resume:event.data.resume===true,state:'running',startedAt:event.at,deadlineAt:event.at});
 if(event.type==='gate.result' && event.attemptId) await store.updateAttempt(runId,event.attemptId,{state:event.data.pass ? 'passed':'failed'});
 if(event.type==='attempt.interrupted' && event.attemptId) await store.updateAttempt(runId,event.attemptId,{state:'interrupted'});
 if(event.type==='task.status'&&event.taskId) await store.setTaskStatus(runId,event.taskId,event.data.status as never); }
const dashboard=createDashboard({store,disk},{async stopTask(){throw new Error('Archived rehearsal cannot stop workers');}});
const delivered=await import(pathToFileURL(join(appRoot,'src/app.ts')).href);
const product=delivered.createApp({dataset,publicDir:join(appRoot,'public')}) as Hono;
const app=new Hono();
app.get('/engineering',async c=>{const response=await dashboard.request('/');const html=await response.text();return c.html(html.replace('<body>','<body><div style="padding:12px;background:#fbd38d;color:#17202a;text-align:center">RECORDED RUN EVIDENCE — '+runId+' — workers are stopped</div>'));});
app.all('/api/runs/*',c=>dashboard.fetch(c.req.raw));
app.all('/research/*',c=>dashboard.fetch(c.req.raw));
app.all('/runs/*',c=>dashboard.fetch(c.req.raw));
app.get('/delivery/:id/report.md',async c=>{if(c.req.param('id')!==runId)return c.notFound();const report=await disk.read(`/delivery/${runId}/report.md`);return report?c.text(report):c.notFound();});
app.all('*',c=>product.fetch(c.req.raw));
serve({fetch:app.fetch,port});
console.log(`Preserved Radar app http://localhost:${port}/ — ${runId}`);
console.log(`Recorded engineering evidence http://localhost:${port}/engineering?run=${runId}`);
