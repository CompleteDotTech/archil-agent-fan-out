import { describe,expect,it } from 'vitest';
import { createApp } from '../../src/app.js';
import { exampleDataset } from './data.js';
describe('Radar API and provenance',()=>{
 it('serves the exact research dataset and claim-specific sources',async()=>{const dataset=exampleDataset();const app=createApp({dataset});expect(await (await app.request('/api/dataset')).json()).toEqual(dataset);const detail=await (await app.request('/api/events/event-one')).json();expect(detail.event).toEqual(dataset.events[0]);for(const [field,claim] of Object.entries(detail.event.fields)){for(const id of (claim as {findingIds:string[]}).findingIds){const finding=detail.findings.find((f:{id:string})=>f.id===id);expect(finding.field).toBe(field);expect(detail.sources.some((s:{id:string})=>s.id===finding.sourceId)).toBe(true);}}});
 it('has evidence endpoint and rejects unknown ids and filters',async()=>{const app=createApp({dataset:exampleDataset()});expect((await app.request('/api/events/missing')).status).toBe(404);for(const path of ['/api/events?mode=moon','/api/events?eligibility=anyone','/api/events?after=2026-02-31'])expect((await app.request(path)).status).toBe(400);const evidence=await (await app.request('/api/evidence')).json();expect(evidence.runId).toBe('run-test');expect(evidence.findings.length).toBe(9);});
});
