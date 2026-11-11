import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {radarDatasetSchema} from '../src/research/radar-schema.js';
import {matchesAny} from '../src/orchestrator/globs.js';
import type {Plan,SwarmEvent,Manifest} from '../src/contracts/types.js';
const {values}=parseArgs({options:{run:{type:'string'}}});
if(!values.run||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(values.run))throw new Error('Pass --run ID');
const root=resolve('.swarm/radar',values.run),artifact=(p:string)=>join(root,'artifacts',p);
const bytes=await readFile(join(root,'dataset.json'),'utf8');const data=radarDatasetSchema.parse(JSON.parse(bytes));
const plan=JSON.parse(await readFile(artifact(`spec/${data.runId}/plan.json`),'utf8')) as Plan;
const events=(JSON.parse(await readFile(join(root,'events.json'),'utf8')) as {event:SwarmEvent}[]).map(e=>e.event);
const checks:{name:string;pass:boolean;detail:unknown}[]=[];
const check=(name:string,pass:boolean,detail:unknown)=>checks.push({name,pass,detail});
check('five events',data.events.length===5,{count:data.events.length,shortfall:data.shortfall});
check('three completed roles',data.roles.length===3&&data.roles.every(r=>r.status==='complete'),data.roles.map(r=>({role:r.role,status:r.status,findings:r.findings.length,errors:r.errors})));
for(const f of data.findings){const source=data.sources.find(s=>s.id===f.sourceId)!;const page=await readFile(artifact(source.contentPath.slice(1)),'utf8');check(`source quote ${f.id}`,page.includes(f.quote),{sourceId:source.id,url:source.url});}
const shared=await readFile(artifact(`research/${data.runId}/dataset.json`));
const sha=createHash('sha256').update(shared).digest('hex');
for(const task of plan.tasks.filter(t=>t.kind==='task')){
 const passed=events.filter(e=>e.taskId===task.id&&e.type==='gate.result'&&e.data.pass===true).at(-1);
 const merged=events.some(e=>e.taskId===task.id&&e.type==='pr.merged');
 check(`gated merged PR ${task.id}`,!!passed&&merged,{attemptId:passed?.attemptId,merged});
 if(passed?.attemptId){const base=`runs/${data.runId}/${task.id}/${passed.attemptId}`;const receipt=JSON.parse(await readFile(artifact(`${base}/research-receipt.json`),'utf8'));const manifest=JSON.parse(await readFile(artifact(`${base}/manifest.json`),'utf8')) as Manifest;
 check(`matching handoff ${task.id}`,receipt.sha256===sha&&receipt.datasetId===data.datasetId&&receipt.consumed===true,receipt);
 check(`owned paths ${task.id}`,manifest.changedFiles.every(path=>matchesAny(path,task.owns)),manifest.changedFiles);
 }
}
check('final integrated tests',events.some(e=>e.type==='integration.result'&&e.data.final===true&&e.data.pass===true),events.filter(e=>e.type==='integration.result'&&e.data.final===true));
const roles=data.roles;const discovery=roles.find(r=>r.role==='discovery')!,req=roles.find(r=>r.role==='requirements')!,cmp=roles.find(r=>r.role==='comparison')!;
check('bounded role ordering',discovery.completedAt<=req.startedAt&&discovery.completedAt<=cmp.startedAt,{discovery:discovery.completedAt,requirements:req.startedAt,comparison:cmp.startedAt});
const intervals=plan.tasks.filter(t=>['T2','T3','T4'].includes(t.id)).map(t=>{const start=events.find(e=>e.taskId===t.id&&e.type==='attempt.started')?.at;const end=events.find(e=>e.taskId===t.id&&e.type==='gate.result')?.at;return {taskId:t.id,start,end};});
const overlap=intervals.every(i=>i.start&&i.end)&&Math.max(...intervals.map(i=>Date.parse(i.start!)))<Math.min(...intervals.map(i=>Date.parse(i.end!)));
check('parallel coding observed',overlap,intervals);
const result={runId:data.runId,datasetId:data.datasetId,researchMode:data.researchMode,checkedAt:new Date().toISOString(),pass:checks.every(c=>c.pass),checks};
await writeFile(join(root,'audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({runId:data.runId,pass:result.pass,checks:checks.length,failed:checks.filter(c=>!c.pass)}));if(!result.pass)process.exitCode=1;
