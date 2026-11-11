import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type RunMode = 'rehearsal' | 'judges';
export interface RadarRunRecord {
  version: 1; runId: string; mode: RunMode; status: 'prepared'|'seeded'|'starting'|'completed'|'failed'|'stopped';
  preparedAt: string; targetRepo: string; baseBranch: 'main'; seedPath: string;
  softwareRevision: string; researchMode: 'fresh'; port: number;
  seedCommit?: string; startedAt?: string; endedAt?: string; failure?: string;
}
const exec = promisify(execFile);
export type RunCommand = (file:string,args:string[],cwd?:string)=>Promise<string>;
const runCommand:RunCommand = async (file,args,cwd) => (await exec(file,args,{cwd,encoding:'utf8',maxBuffer:8_000_000})).stdout.trim();
export const validateRunId = (runId:string):string => {
  if (!/^radar-(rehearsal|judges)-[a-zA-Z0-9_-]+$/.test(runId) || runId.length > 119) throw new Error('Invalid Radar run ID');
  return runId;
};
const runDir = (root:string,runId:string) => join(resolve(root),'.swarm','radar',validateRunId(runId));
const save = (directory:string,record:RadarRunRecord,exclusive=false) => writeFile(join(directory,'run.json'),JSON.stringify(record,null,2)+'\n', {flag:exclusive?'wx':'w'});
export async function readRun(root:string,runId:string):Promise<RadarRunRecord> {
  const record = JSON.parse(await readFile(join(runDir(root,runId),'run.json'),'utf8')) as RadarRunRecord;
  if (record.runId !== runId || !['rehearsal','judges'].includes(record.mode) || record.version !== 1
    || !/^[\w.-]+\/[\w.-]+$/.test(record.targetRepo) || record.baseBranch !== 'main'
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw new Error('Invalid Radar run record');
  return record;
}
export async function prepareRun(input:{root:string;mode:RunMode;targetRepo:string;port?:number;now?:Date;uuid?:string;command?:RunCommand}):Promise<RadarRunRecord> {
  if (!['rehearsal','judges'].includes(input.mode)) throw new Error('Mode must be rehearsal or judges');
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.targetRepo)) throw new Error('Repository must be owner/name');
  const port = input.port ?? (input.mode==='rehearsal'?3000:3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  const now = input.now ?? new Date();
  const runId = validateRunId(`radar-${input.mode}-${now.toISOString().replace(/[:.]/g,'-')}-${(input.uuid??randomUUID()).slice(0,8)}`);
  const directory = runDir(input.root,runId);
  const softwareRevision = await (input.command??runCommand)('git',['rev-parse','HEAD'],input.root);
  await mkdir(resolve(input.root,'.swarm','radar'),{recursive:true});
  await mkdir(directory); // EEXIST protects even a partially prepared run.
  const record:RadarRunRecord = {version:1,runId,mode:input.mode,status:'prepared',preparedAt:now.toISOString(),targetRepo:input.targetRepo,baseBranch:'main',seedPath:'demo/radar-seed',softwareRevision,researchMode:'fresh',port};
  await save(directory,record,true);
  return record;
}

/** Explicit seed step. The destination repo must not already exist; never reset a previous run. */
export async function seedRun(root:string,runId:string,command:RunCommand=runCommand):Promise<RadarRunRecord> {
  const record = await readRun(root,runId);
  if (record.status !== 'prepared') throw new Error('Only a prepared run can be seeded');
  const directory = runDir(root,runId);
  await writeFile(join(directory,'seed.lock'),'seeding\n',{flag:'wx'});
  const checkout = join(directory,'seed');
  await cp(resolve(root,record.seedPath),checkout,{recursive:true,errorOnExist:true,force:false});
  await command('git',['init','--initial-branch=main'],checkout);
  await command('git',['config','user.name','Radar Demo'],checkout);
  await command('git',['config','user.email','radar@localhost'],checkout);
  await command('git',['add','.'],checkout);
  await command('git',['commit','-m',`Clean Radar seed for ${runId}`],checkout);
  const seedCommit = await command('git',['rev-parse','HEAD'],checkout);
  // gh refuses an existing remote repository. No force push, deletion, or reset is used.
  await command('gh',['repo','create',record.targetRepo,'--private','--source',checkout,'--remote','origin','--push'],root);
  record.seedCommit = seedCommit;
  record.status = 'seeded';
  await save(directory,record);
  return record;
}
export function assertStartAllowed(record:RadarRunRecord,presentationNow:boolean):void {
  if (record.mode==='judges' && !presentationNow) throw new Error('Judges run is prepared only. Pass --presentation-now only after explicit presentation-time signal.');
  if (record.status!=='seeded' || !record.seedCommit) throw new Error('Only a seeded, never-started run can start');
}
export async function startRun(input:{root:string;runId:string;presentationNow?:boolean;command?:RunCommand;execute?:(record:RadarRunRecord,directory:string)=>Promise<void>;now?:()=>Date}):Promise<RadarRunRecord> {
  const record = await readRun(input.root,input.runId);
  assertStartAllowed(record,!!input.presentationNow);
  const command = input.command??runCommand;
  const actual = await command('gh',['api',`repos/${record.targetRepo}/git/ref/heads/main`,'--jq','.object.sha'],input.root);
  if (actual !== record.seedCommit) throw new Error('Target main differs from recorded clean seed; prepare a separate run');
  const directory = runDir(input.root,input.runId);
  await writeFile(join(directory,'start.lock'),'started\n',{flag:'wx'});
  const now = input.now??(()=>new Date());
  record.status='starting'; record.startedAt=now().toISOString();
  await save(directory,record);
  try {
    if (input.execute) await input.execute(record,directory);
    else {
      const sourceHashes: Record<string,string> = {};
      for (const folder of ['src','scripts','fixtures','demo/radar-seed']) {
        for (const entry of await readdir(resolve(input.root,folder),{recursive:true,withFileTypes:true})) {
          if(!entry.isFile()) continue;
          const path=join(entry.parentPath,entry.name);
          const relative=path.slice(resolve(input.root).length+1);
          sourceHashes[relative]=createHash('sha256').update(await readFile(path)).digest('hex');
        }
      }
      await writeFile(join(directory,'software.json'),JSON.stringify({revision:await command('git',['rev-parse','HEAD'],input.root),sha256:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),sourceHashes},null,2));
      const {compose} = await import('../src/compose.js');
      await compose({radar:true,runId:record.runId,mode:record.mode,targetRepo:record.targetRepo,port:record.port,
        brief:await readFile(resolve(input.root,'demo/brief.md'),'utf8'),local:false,fakeAgent:false,fixturePlan:true,dryRun:false,
        outputDir:directory});
    }
    record.status='completed';
  } catch (error) {
    const cause=error as {name?:unknown;code?:unknown;status?:unknown;stack?:unknown};
    await writeFile(join(directory,'failure.json'),JSON.stringify({name:typeof cause?.name==='string'?cause.name:'Error',code:typeof cause?.code==='string'&&/^[A-Z_0-9]+$/.test(cause.code)?cause.code:undefined,status:typeof cause?.status==='number'?cause.status:undefined,frames:typeof cause?.stack==='string'?cause.stack.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,8):[]},null,2));
    record.status='failed'; record.failure='Execution failed; inspect preserved run evidence and logs. This run cannot be reused.';
  }
  record.endedAt=now().toISOString();
  await save(directory,record);
  if (record.status==='failed') throw new Error(record.failure);
  return record;
}

async function main():Promise<void> {
  try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  if (!process.env.GH_TOKEN && process.env.GITHUB_TOKEN) process.env.GH_TOKEN=process.env.GITHUB_TOKEN;
  const {positionals,values}=parseArgs({allowPositionals:true,options:{mode:{type:'string'},repo:{type:'string'},port:{type:'string'},run:{type:'string'},'presentation-now':{type:'boolean'},'github-cli-auth':{type:'boolean'},help:{type:'boolean'}}});
  const [action] = positionals;
  if (values['github-cli-auth']) {
    const cleanEnv = {...process.env};
    delete cleanEnv.GH_TOKEN; delete cleanEnv.GITHUB_TOKEN;
    const credential = (await exec('gh',['auth','token'],{env:cleanEnv,encoding:'utf8'})).stdout.trim();
    if (!credential) throw new Error('No stored GitHub CLI credential');
    process.env.GH_TOKEN = credential;
    process.env.GITHUB_TOKEN = credential;
    process.env.GITHUB_PUSH_TOKEN = credential;
    console.log('GitHub auth: existing CLI login (explicit override; no credential written)');
  }
  if (values.help || !action) {
    console.log('Radar run lifecycle (fresh Keenable research, real Archil/Codex workers):\n  prepare --mode rehearsal|judges --repo owner/new-repo [--port 3000]\n  seed --run <run-id>\n  start --run <run-id> [--presentation-now]\nFor a stored GitHub CLI login instead of env credentials, add --github-cli-auth.\nUse: node --import tsx scripts/radar-run.ts <command>'); return;
  }
  const root=process.cwd();
  let record:RadarRunRecord;
  if (action==='prepare') record=await prepareRun({root,mode:values.mode as RunMode,targetRepo:values.repo??'',port:values.port===undefined?undefined:Number(values.port)});
  else if (action==='seed' && values.run) record=await seedRun(root,values.run);
  else if (action==='start' && values.run) record=await startRun({root,runId:values.run,presentationNow:values['presentation-now']});
  else throw new Error('Unknown command or missing --run; use --help');
  console.log(JSON.stringify(record,null,2));
  if (action==='prepare') console.log(`Next: node --import tsx scripts/radar-run.ts seed --run ${record.runId}`);
  if (action==='seed') console.log(`Ready: node --import tsx scripts/radar-run.ts start --run ${record.runId}${record.mode==='judges'?' --presentation-now':''}`);
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error instanceof Error?error.message:'Radar command failed');process.exitCode=1;});
}
