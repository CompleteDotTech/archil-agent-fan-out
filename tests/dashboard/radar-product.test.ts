import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, symlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
describe('assembled Radar product',()=>{
 it('typechecks and passes real API, provenance, filtering, and persistent shortlist acceptance tests',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-product-'));
  try {
   await cp(resolve('demo/radar-seed'),dir,{recursive:true});
   for(const id of ['T1','T2','T3','T4']) await cp(resolve('fixtures/radar-agent',id),dir,{recursive:true});
   await symlink(resolve('node_modules'),join(dir,'node_modules'),'dir');
   await mkdir(join(dir,'data'),{recursive:true});
   await writeFile(join(dir,'data/research.json'),JSON.stringify({schemaVersion:1,runId:'fixture-handoff',datasetId:'fixture-data',createdAt:'2026-11-11T00:00:00Z',researchMode:'fixture',events:[],sources:[],findings:[],roles:[],shortfall:5}));
   const checked=await exec(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit'],{cwd:dir});
   expect(checked.stderr).toBe('');
   const tested=await exec(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1'],{cwd:dir,timeout:60000});
   expect(tested.stdout).toContain('passed');
  } finally {await rm(dir,{recursive:true,force:true});}
 },90000);
});
