import { describe, expect, it } from 'vitest';
import { MemoryDisk } from '../../src/contracts/fakes.js';
import type { Research, Source } from '../../src/contracts/types.js';
import { runRadarResearch, radarDatasetSchema, extractLabeledClaims } from '../../src/research/radar.js';
import type { RadarResearchEvent } from '../../src/research/radar.js';

const timestamp = '2026-11-11T12:00:00.000Z';
const candidates: Source[] = Array.from({length:5}, (_, i) => ({title:`Event ${i+1}`,url:`https://event${i+1}.test/`}));
const page = (i: number) => `# Event ${i+1}\nLocation: Worldwide\nAttendance mode: Online\nEvent dates: 2026-12-01 to 2026-12-03\nSubmission deadline: 2026-12-03T17:00:00Z\nTimezone: UTC\nEligibility: Open to everyone\nPrizes: $${(i+1)*1000} in sponsor credits\nJudging: Usability and technical execution\nDeliverables: Repository and demo video`;
function fakeResearch(pages: Record<string,string> = {}): Research {
  return {search:async () => candidates,fetch:async url => pages[url] ?? page(Number(new URL(url).hostname.match(/\d+/)?.[0] ?? 1)-1)};
}
const options = (disk: MemoryDisk, runId='rehearsal-1') => ({runId,disk,research:fakeResearch(),now:()=>timestamp,researchMode:'fixture' as const});

describe('Radar research preflight', () => {
  it('executes discovery then parallel verification roles and publishes validated source-mapped dataset last', async () => {
    const disk = new MemoryDisk();
    const events: RadarResearchEvent[] = [];
    const dataset = await runRadarResearch({...options(disk),onEvent:async event => {
      if (event.status === 'complete') expect(await disk.read(event.artifactPath!)).toBeDefined();
      events.push(event);
    }});
    expect(dataset.events).toHaveLength(5);
    expect(dataset.shortfall).toBe(0);
    expect(dataset.researchMode).toBe('fixture');
    expect(dataset.roles.map(role => role.role)).toEqual(['discovery','requirements','comparison']);
    const discoveryComplete = events.findIndex(event => event.role === 'discovery' && event.status === 'complete');
    const requirementStart = events.findIndex(event => event.role === 'requirements' && event.status === 'running');
    const comparisonStart = events.findIndex(event => event.role === 'comparison' && event.status === 'running');
    const requirementComplete = events.findIndex(event => event.role === 'requirements' && event.status === 'complete');
    expect(requirementStart).toBeGreaterThan(discoveryComplete);
    expect(comparisonStart).toBeGreaterThan(discoveryComplete);
    expect(comparisonStart).toBeLessThan(requirementComplete);
    expect(events.at(-1)).toMatchObject({role:'consolidation',status:'complete',count:5});
    for (const event of dataset.events) {
      expect(event.fields.attendanceMode.value).toBe('online');
      expect(event.fields.eligibility.value).toBe('open');
      expect(event.fields.deadline.value).toBe('2026-12-03T17:00:00Z');
      for (const claim of Object.values(event.fields)) for (const id of claim.findingIds) {
        const finding = dataset.findings.find(item => item.id === id)!;
        expect(finding.eventId).toBe(event.id);
        const source = dataset.sources.find(item => item.id === finding.sourceId)!;
        expect(await disk.read(source.contentPath)).toContain(finding.quote);
        expect(source.retrievedAt).toBe(timestamp);
      }
    }
    expect(JSON.parse((await disk.read('/research/rehearsal-1/dataset.json'))!)).toEqual(dataset);
    expect(await disk.read('/research/rehearsal-1/roles/requirements/sources.md')).toContain('untrusted source material');
  });

  it('keeps absent facts unknown and rejects invented quotes or out-of-role fields', async () => {
    const dataset = await runRadarResearch({...options(new MemoryDisk()),extract:async ({fields}) => [
      {field:fields[0],value:'invented',quote:'this quote never appeared'},
      {field:'deadline',value:'wrong',quote:'Location: Worldwide'},
    ]});
    expect(dataset.events[0].fields.prizes).toEqual({value:null,status:'unknown',findingIds:[]});
    expect(dataset.roles[2].errors).toContain('Rejected unsupported claim on https://event1.test');
  });

  it('preserves competing official statements as a conflict instead of selecting a deadline', async () => {
    const research = fakeResearch({'https://event1.test/rules':page(0).replace('2026-12-03T17:00:00Z','2026-12-04T17:00:00Z')});
    const dataset = await runRadarResearch({...options(new MemoryDisk()),research,candidates:candidates.map((candidate,index) => ({name:candidate.title,url:candidate.url,sourceUrls:index ? []:['https://event1.test/rules']}))});
    const deadline = dataset.events[0].fields.deadline;
    expect(deadline.status).toBe('conflicting');
    expect(deadline.value).toBeNull();
    expect(deadline.findingIds).toHaveLength(2);
    expect(dataset.findings.filter(finding => deadline.findingIds.includes(finding.id)).map(finding => finding.value)).toEqual(['2026-12-03T17:00:00Z','2026-12-04T17:00:00Z']);
  });

  it('reports a discovery shortfall and source errors without manufacturing events', async () => {
    const dataset = await runRadarResearch({...options(new MemoryDisk()),research:{search:async()=>candidates.slice(0,2),fetch:async()=>''}});
    expect(dataset.events).toHaveLength(2);
    expect(dataset.shortfall).toBe(3);
    expect(dataset.roles[0].errors).toContain('Only 2 candidates discovered; shortfall 3');
    expect(dataset.roles[1].status).toBe('failed');
    expect(dataset.events[0].fields.deadline.status).toBe('unknown');
  });

  it('rejects candidate overrides not found by real discovery and ignores cross-host extra pages', async () => {
    const dataset = await runRadarResearch({...options(new MemoryDisk()),candidates:[
      {name:'Invented',url:'https://made-up.test'},
      {name:'Event 1',url:'https://event1.test',sourceUrls:['https://unrelated.test/rules']},
    ]});
    expect(dataset.events).toHaveLength(1);
    expect(dataset.roles[0].errors).toContain('Candidate URL was not present in discovery results');
    expect(dataset.roles[0].candidates[0].sourceUrls).toEqual([]);
  });

  it('isolates IDs and artifact paths by run and refuses to overwrite a started run', async () => {
    const disk = new MemoryDisk();
    const first = await runRadarResearch(options(disk,'run-a'));
    const second = await runRadarResearch(options(disk,'run-b'));
    expect(first.runId).not.toBe(second.runId);
    expect(first.datasetId).not.toBe(second.datasetId);
    expect(second.sources.every(source => source.contentPath.startsWith('/research/run-b/'))).toBe(true);
    await expect(runRadarResearch(options(disk,'run-a'))).rejects.toThrow('already exists');
    await expect(runRadarResearch(options(disk,'../unsafe'))).rejects.toThrow('Unsafe');
  });

  it('validates claim and source references, unknowns and conflicts', async () => {
    const dataset = await runRadarResearch(options(new MemoryDisk()));
    const sourceMissing = structuredClone(dataset);
    sourceMissing.sources = [];
    expect(radarDatasetSchema.safeParse(sourceMissing).success).toBe(false);
    const wrongField = structuredClone(dataset);
    wrongField.events[0].fields.deadline.findingIds = wrongField.events[0].fields.prizes.findingIds;
    expect(radarDatasetSchema.safeParse(wrongField).success).toBe(false);
    const falseUnknown = structuredClone(dataset);
    falseUnknown.events[0].fields.deadline.status = 'unknown';
    expect(radarDatasetSchema.safeParse(falseUnknown).success).toBe(false);
    const falseConflict = structuredClone(dataset);
    falseConflict.events[0].fields.deadline = {...falseConflict.events[0].fields.deadline,value:null,status:'conflicting'};
    expect(radarDatasetSchema.safeParse(falseConflict).success).toBe(false);
  });

  it('does not confuse event dates, ambiguous eligibility, or unspecified prizes with established facts', () => {
    const claims = extractLabeledClaims('Event dates: 2026-12-01\nEligibility: Students welcome\nPrizes: Not announced\nDeadline: Not verified',['eventDates','deadline','eligibility','prizes']);
    expect(claims).toEqual([{field:'eventDates',value:'2026-12-01',quote:'Event dates: 2026-12-01'}]);
  });
});
