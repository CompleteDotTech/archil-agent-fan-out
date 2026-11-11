import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertStartAllowed,prepareRun,readRun,seedRun,startRun,validateRunId,type RadarRunRecord,type RunCommand} from '../../scripts/radar-run.js';
const roots:string[]=[];
async function root() { const path=await mkdtemp(join(tmpdir(),'radar-run-test-')); roots.push(path); return path; }
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const now=new Date('2026-11-11T12:13:14.000Z');
const revision='a'.repeat(40);
const command:RunCommand=async()=>revision;
async function prepared(mode:'rehearsal'|'judges'='rehearsal') { const directory=await root(); return {root:directory,record:await prepareRun({root:directory,mode,targetRepo:`owner/${mode}`,now,uuid:'12345678',command})}; }
async function seeded(mode:'rehearsal'|'judges'='rehearsal') {
  const value=await prepared(mode);
  value.record.status='seeded'; value.record.seedCommit=revision;
  await writeFile(join(value.root,'.swarm/radar',value.record.runId,'run.json'),JSON.stringify(value.record));
  return value;
}
describe('Radar repeat-run lifecycle',()=>{
  it('prepares distinct mode-specific run IDs without calling providers',async()=>{
    const one=await prepared(); const two=await prepared('judges');
    expect(one.record.runId).not.toBe(two.record.runId);
    expect(one.record).toMatchObject({status:'prepared',researchMode:'fresh',baseBranch:'main',port:3000,softwareRevision:revision});
    expect(two.record).toMatchObject({status:'prepared',port:3001});
    expect(await readRun(one.root,one.record.runId)).toEqual(one.record);
  });
  it('does not overwrite even a partially prepared run',async()=>{
    const {root:directory}=await prepared();
    await expect(prepareRun({root:directory,mode:'rehearsal',targetRepo:'owner/other',now,uuid:'12345678',command})).rejects.toThrow();
  });
  it.each(['../x','radar-judges-../x','legacy-id','radar-judges-'])('rejects unsafe ID %s',(id)=>{expect(()=>validateRunId(id)).toThrow();});
  it('seeds a separate repository and records its commit through the explicit seed step',async()=>{
    const {root:directory,record}=await prepared();
    await mkdir(join(directory,'demo/radar-seed'),{recursive:true});
    await writeFile(join(directory,'demo/radar-seed/README.md'),'seed');
    const calls:Array<[string,string[]]>=[];
    const result=await seedRun(directory,record.runId,async(file,args)=>{calls.push([file,args]); return revision;});
    expect(result).toMatchObject({status:'seeded',seedCommit:revision});
    expect(calls.at(-1)?.[1]).toContain('--private');
    expect(calls.at(-1)?.[1]).toContain('owner/rehearsal');
    await expect(seedRun(directory,record.runId,command)).rejects.toThrow('prepared');
  });
  it('refuses judges start before presentation signal without provider calls or state changes',async()=>{
    const {root:directory,record}=await seeded('judges'); let calls=0;
    await expect(startRun({root:directory,runId:record.runId,command:async()=>{calls++;return revision;},execute:async()=>{calls++;}})).rejects.toThrow('presentation-now');
    expect(calls).toBe(0);
    expect((await readRun(directory,record.runId)).status).toBe('seeded');
  });
  it('rejects a target changed from its clean seed',async()=>{
    const {root:directory,record}=await seeded();
    await expect(startRun({root:directory,runId:record.runId,command:async()=>'different',execute:async()=>{throw Error('not reached');}})).rejects.toThrow('differs');
    expect((await readRun(directory,record.runId)).status).toBe('seeded');
  });
  it('executes once, captures times and preserves evidence',async()=>{
    const {root:directory,record}=await seeded('judges'); let count=0;
    const result=await startRun({root:directory,runId:record.runId,presentationNow:true,command,now:()=>now,execute:async(value,path)=>{
      count++; expect(value.mode).toBe('judges'); await writeFile(join(path,'evidence.json'),'{}');
    }});
    expect(result).toMatchObject({status:'completed',startedAt:now.toISOString(),endedAt:now.toISOString()});
    expect(count).toBe(1);
    expect(await readFile(join(directory,'.swarm/radar',record.runId,'evidence.json'),'utf8')).toBe('{}');
    await expect(startRun({root:directory,runId:record.runId,presentationNow:true,command})).rejects.toThrow('never-started');
  });
  it('records failure without leaking external error text or allowing reuse',async()=>{
    const {root:directory,record}=await seeded();
    await expect(startRun({root:directory,runId:record.runId,command,execute:async()=>{throw Error('secret');}})).rejects.toThrow('Execution failed');
    const failed=await readRun(directory,record.runId);
    expect(failed.status).toBe('failed'); expect(JSON.stringify(failed)).not.toContain('secret');
    expect(()=>assertStartAllowed(failed,false)).toThrow();
  });
});
