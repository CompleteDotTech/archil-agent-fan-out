import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../src/app.js';
import { exampleDataset } from './data.js';
describe('Radar product UI',()=>{
 it('serves filters, details and evidence separately from the engineering dashboard',async()=>{const app=createApp({dataset:exampleDataset()});const html=await (await app.request('/')).text();for(const id of ['mode','eligibility','after','saved','cards','detail','evidence'])expect(html).toContain(`id="${id}"`);expect(html).toContain('Hackathon opportunity finder');expect((await app.request('/../src/types.ts')).status).toBe(404);const js=await (await app.request('/app.js')).text();expect(js).not.toContain('not implemented');expect((await app.request('/shortlist.js')).status).toBe(200);});
 it('persists shortlist through reload while isolating runs and handling corrupt storage',async()=>{const code=await readFile('public/shortlist.js','utf8');const {createShortlist}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v)};const a=createShortlist(storage,'rehearsal');expect(a.toggle('event-one')).toBe(true);expect(createShortlist(storage,'rehearsal').has('event-one')).toBe(true);expect(createShortlist(storage,'judges').has('event-one')).toBe(false);expect(a.toggle('event-one')).toBe(false);storage.setItem('radar:broken:shortlist','not json');expect(createShortlist(storage,'broken').values()).toEqual([]);});
});
