import { Hono } from 'hono';
import type { RadarDataset, FilterEvents } from '../types.js';
export function createApi(dataset: RadarDataset, filter: FilterEvents): Hono {
 const app = new Hono();
 app.get('/api/dataset', c => c.json(dataset));
 app.get('/api/evidence', c => c.json({runId:dataset.runId,datasetId:dataset.datasetId,findings:dataset.findings,sources:dataset.sources,roles:dataset.roles}));
 app.get('/api/events', c => {
  const { mode, eligibility, after } = c.req.query();
  if (mode && !['online','in-person','hybrid','unknown'].includes(mode) || eligibility && !['open','student-only','unknown'].includes(eligibility) || after && (!/^\d{4}-\d{2}-\d{2}$/.test(after) || !Number.isFinite(Date.parse(after)) || new Date(after).toISOString().slice(0,10)!==after)) return c.json({error:'Invalid filters'},400);
  return c.json({runId:dataset.runId,datasetId:dataset.datasetId,events:filter(dataset.events,{mode,eligibility,after})});
 });
 app.get('/api/events/:id', c => {
  const event = dataset.events.find(e => e.id === c.req.param('id'));
  if (!event) return c.json({error:'Unknown event'},404);
  const findings = dataset.findings.filter(f => f.eventId === event.id);
  const sourceIds = new Set(findings.map(f => f.sourceId));
  return c.json({event,findings,sources:dataset.sources.filter(s => sourceIds.has(s.id)),runId:dataset.runId,datasetId:dataset.datasetId});
 });
 return app;
}
