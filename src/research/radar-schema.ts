import { z } from 'zod';

export const radarFields = ['location', 'attendanceMode', 'eventDates', 'deadline', 'timezone', 'eligibility', 'prizes', 'judging', 'deliverables'] as const;
export const radarRoles = ['discovery', 'requirements', 'comparison'] as const;
export type RadarField = typeof radarFields[number];
export type RadarRole = typeof radarRoles[number];
export const radarCandidateSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), url: z.url(),
  sourceUrls: z.array(z.url()).max(3).default([]), rationale: z.string().default('Official event candidate found during discovery.'),
});
export const radarSourceSchema = z.object({
  id: z.string().min(1), url: z.url(), title: z.string(), retrievedAt: z.iso.datetime(),
  query: z.string(), contentHash: z.string(), contentPath: z.string(),
});
export const radarFindingSchema = z.object({
  id: z.string().min(1), eventId: z.string().min(1), role: z.enum(radarRoles),
  field: z.enum(radarFields), value: z.string().min(1), sourceId: z.string().min(1),
  quote: z.string().min(1), status: z.literal('verified'),
}).superRefine((finding, ctx) => {
  if (finding.field === 'attendanceMode' && !['online','in-person','hybrid'].includes(finding.value)) ctx.addIssue({code:'custom',message:'Invalid attendance mode'});
  if (finding.field === 'eligibility' && !['open','student-only'].includes(finding.value)) ctx.addIssue({code:'custom',message:'Invalid eligibility category'});
  if (finding.field === 'deadline' && !isIsoDeadline(finding.value)) ctx.addIssue({code:'custom',message:'Deadline must be an ISO date or datetime'});
});
export function isIsoDeadline(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false;
  const date = new Date(value.slice(0,10));
  return Number.isFinite(Date.parse(value)) && Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === value.slice(0,10);
}
export const radarClaimSchema = z.object({
  value: z.string().nullable(), status: z.enum(['verified', 'unknown', 'conflicting']), findingIds: z.array(z.string()),
});
export const radarEventSchema = z.object({
  id: z.string(), name: z.string(), officialUrl: z.url(),
  fields: z.object(Object.fromEntries(radarFields.map(field => [field, radarClaimSchema])) as Record<RadarField, typeof radarClaimSchema>),
});
export const radarRoleResultSchema = z.object({
  role: z.enum(radarRoles), status: z.enum(['complete', 'failed']),
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime(), queries: z.array(z.string()),
  candidates: z.array(radarCandidateSchema), sources: z.array(radarSourceSchema),
  findings: z.array(radarFindingSchema), errors: z.array(z.string()),
});
export const radarDatasetSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), datasetId: z.string().min(1),
  createdAt: z.iso.datetime(), researchMode: z.enum(['fresh', 'fixture', 'cache']),
  events: z.array(radarEventSchema).max(5), sources: z.array(radarSourceSchema),
  findings: z.array(radarFindingSchema), roles: z.array(radarRoleResultSchema), shortfall: z.number().int().min(0).max(5),
}).superRefine((data, ctx) => {
  const sourceIds = new Set(data.sources.map(source => source.id));
  const eventIds = new Set(data.events.map(event => event.id));
  const findings = new Map(data.findings.map(finding => [finding.id, finding]));
  if (sourceIds.size !== data.sources.length || eventIds.size !== data.events.length || findings.size !== data.findings.length) {
    ctx.addIssue({code:'custom', message:'Duplicate evidence IDs'});
  }
  if (data.shortfall !== 5 - data.events.length) ctx.addIssue({code:'custom', message:'Incorrect shortfall'});
  for (const finding of data.findings) {
    if (!sourceIds.has(finding.sourceId) || !eventIds.has(finding.eventId)) ctx.addIssue({code:'custom', message:`Dangling evidence ${finding.id}`});
  }
  for (const event of data.events) for (const field of radarFields) {
    const claim = event.fields[field];
    const cited = claim.findingIds.map(id => findings.get(id));
    if (cited.some(finding => !finding || finding.eventId !== event.id || finding.field !== field)) ctx.addIssue({code:'custom', message:`Invalid claim mapping ${event.id}/${field}`});
    if (claim.status === 'verified' && (!claim.value || !cited.some(finding => finding?.value === claim.value))) ctx.addIssue({code:'custom', message:`Uncited claim ${event.id}/${field}`});
    if (claim.status !== 'verified' && claim.value !== null) ctx.addIssue({code:'custom', message:`Uncertain claim must have null value ${event.id}/${field}`});
    if (claim.status === 'conflicting' && new Set(cited.map(finding => finding?.value)).size < 2) ctx.addIssue({code:'custom', message:`Conflict requires alternatives ${event.id}/${field}`});
  }
});
export type RadarCandidate = z.infer<typeof radarCandidateSchema>;
export type RadarSource = z.infer<typeof radarSourceSchema>;
export type RadarFinding = z.infer<typeof radarFindingSchema>;
export type RadarClaim = z.infer<typeof radarClaimSchema>;
export type RadarEvent = z.infer<typeof radarEventSchema>;
export type RadarRoleResult = z.infer<typeof radarRoleResultSchema>;
export type RadarDataset = z.infer<typeof radarDatasetSchema>;
