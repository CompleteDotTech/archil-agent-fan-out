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
