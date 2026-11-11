/** Local, click-only launcher for the prepared timestamp-cleanup PR. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { createNextPrLauncher, type NextPrState } from '../src/dashboard/next-pr.js';
import { taskSpecSchema } from '../src/planner/schema.js';
import { readRun } from './radar-run.js';
import { executeFollowup } from './radar-followup.js';

try { process.loadEnvFile('.env'); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
const {values}=parseArgs({options:{port:{type:'string',default:'3000'},config:{type:'string',default:'demo/next-pr-config.json'},'github-cli-auth':{type:'boolean'}}});
if(values['github-cli-auth']){
  const env={...process.env};delete env.GH_TOKEN;delete env.GITHUB_TOKEN;
  const credential=(await promisify(execFile)('gh',['auth','token'],{env,encoding:'utf8'})).stdout.trim();
  if(!credential)throw new Error('Existing GitHub CLI login unavailable');
  process.env.GH_TOKEN=credential;process.env.GITHUB_TOKEN=credential;process.env.GITHUB_PUSH_TOKEN=credential;
}
const port=Number(values.port);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid launcher port');
const root=process.cwd();
const config=JSON.parse(await readFile(resolve(values.config!),'utf8')) as {runId:string;taskPath:string;appUrl:string;workerPort:number};
if(!Number.isInteger(config.workerPort)||config.workerPort<1||config.workerPort>65535||config.workerPort===port)throw new Error('Invalid worker dashboard port');
const task=taskSpecSchema.parse(JSON.parse(await readFile(resolve(config.taskPath),'utf8')));
const record=await readRun(root,config.runId) as Awaited<ReturnType<typeof readRun>>&{followups?:{taskId:string;status:string;startedAt?:string;endedAt?:string;prUrl?:string}[]};
const previous=record.followups?.filter(item=>item.taskId===task.id).at(-1);
let initial:NextPrState={phase:'ready'};
if(previous)initial={phase:previous.status==='completed'?'completed':previous.status==='running'?'running':'failed',startedAt:previous.startedAt,endedAt:previous.endedAt,prUrl:previous.prUrl,message:'This staged task already has an execution record.'};
else if(record.status!=='completed')throw new Error('The existing run must be completed before preparing its next PR');
const app=createNextPrLauncher({runId:config.runId,taskId:task.id,title:task.title,targetRepo:record.targetRepo,appUrl:config.appUrl,liveUrl:`http://localhost:${config.workerPort}/?run=${config.runId}`},{
  initial,
  async progress(){try{const p=JSON.parse(await readFile(join(root,'.swarm','radar',config.runId,'followups',task.id,'progress.json'),'utf8'));return p.phase;}catch{return undefined;}},
  async start(){
    await executeFollowup(root,config.runId,config.taskPath,{port:config.workerPort});
    const updated=await readRun(root,config.runId) as typeof record;
    const result=updated.followups?.filter(item=>item.taskId===task.id).at(-1);
    if(!result?.prUrl)throw new Error('No delivered PR was recorded');
    return {prUrl:result.prUrl};
  },
});
const server=serve({fetch:app.fetch,port,hostname:'127.0.0.1'});
console.log(`Prepared next-PR page: http://localhost:${port}/ — no worker started`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.close();(server as typeof server&{closeAllConnections?:()=>void}).closeAllConnections?.();});
