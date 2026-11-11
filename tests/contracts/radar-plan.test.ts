import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { validatePlan } from '../../src/planner/validate.js';
import type { Plan } from '../../src/contracts/types.js';
it('uses a valid architecture-first Radar plan with disjoint coding ownership', async () => {
 const plan=JSON.parse(await readFile('fixtures/plan.radar.json','utf8')) as Plan;
 expect(validatePlan(plan)).toEqual({ok:true,errors:[]});
 const tasks=plan.tasks.filter(task=>task.kind==='task');
 expect(tasks.find(task=>task.id==='T1')?.owns).toContain('**');
 for(const task of tasks.filter(task=>task.id!=='T1')) expect(task.dependsOn).toEqual(['T1']);
 expect(JSON.stringify(plan)).not.toMatch(/bookmark/i);
 expect(tasks.every(task=>!task.research?.length)).toBe(true); // explicit preflight, not scheduler research nodes
});
it('clean seed excludes installed dependency files from worker commits',async()=>{
 const {mkdtemp,cp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const exec=promisify(execFile);const dir=await mkdtemp(join(tmpdir(),'radar-seed-test-'));
 try{
  await cp('demo/radar-seed',dir,{recursive:true});
  await mkdir(join(dir,'node_modules'),{recursive:true});await writeFile(join(dir,'node_modules','installed.js'),'dependency');
  await exec('git',['init'],{cwd:dir});await exec('git',['add','.'],{cwd:dir});
  const {stdout}=await exec('git',['ls-files'],{cwd:dir});
  expect(stdout).toContain('.gitignore');expect(stdout).not.toContain('node_modules');
 }finally{await rm(dir,{recursive:true,force:true});}
});
