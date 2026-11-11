import { describe,expect,it } from 'vitest';
import { filterEvents } from '../../src/filter/index.js';
import { exampleDataset } from './data.js';
describe('evidence-aware filters',()=>{
 it('combines category and inclusive deadline filters',()=>{const events=exampleDataset().events;expect(filterEvents(events,{mode:'online',eligibility:'open',after:'2026-12-10'})).toEqual(events);expect(filterEvents(events,{mode:'in-person'})).toEqual([]);expect(filterEvents(events,{after:'2026-12-11'})).toEqual([]);});
 it('does not infer eligibility or deadline from unknown/conflicting claims or event dates',()=>{const event=exampleDataset().events[0];event.fields.eligibility.status='conflicting';event.fields.deadline={value:null,status:'unknown',findingIds:[]};expect(filterEvents([event],{eligibility:'open'})).toEqual([]);expect(filterEvents([event],{eligibility:'unknown'})).toEqual([event]);expect(filterEvents([event],{after:'2020-01-01'})).toEqual([]);});
});
