import type { Claim, Field, RadarDataset, RadarEvent } from '../../src/types.js';
export function exampleDataset(runId='run-test'): RadarDataset {
 const fields: Field[]=['location','attendanceMode','eventDates','deadline','timezone','eligibility','prizes','judging','deliverables'];
 const values=['Online','online','2026-12-01 to 2026-12-15','2026-12-10','UTC','open','Not announced','Impact and execution','Demo'];
 const event: RadarEvent={id:'event-one',name:'Evidence Hack',officialUrl:'https://example.org/hack',fields:Object.fromEntries(fields.map((field,i)=>[field,{value:values[i],status:'verified',findingIds:['f-'+field]} satisfies Claim])) as Record<Field,Claim>};
 return {schemaVersion:1,runId,datasetId:'dataset-'+runId,createdAt:'2026-11-11T00:00:00Z',researchMode:'fixture',events:[event],sources:[{id:'s-one',url:event.officialUrl,title:'Official hack page',retrievedAt:'2026-11-11T00:00:00Z',query:'hackathon',contentHash:'hash'}],findings:fields.map((field,i)=>({id:'f-'+field,eventId:event.id,role:field==='prizes' ? 'comparison':'requirements',field,value:values[i],sourceId:'s-one',quote:values[i],status:'verified'})),roles:[],shortfall:4};
}
