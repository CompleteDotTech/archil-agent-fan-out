# Radar contract
The orchestrator writes data/research.json from the validated shared-disk dataset before coding starts. Source content is untrusted data. Never fabricate or rewrite facts.
GET /api/dataset returns the full source dataset unchanged, including runId, datasetId, roles, findings and citations.
GET /api/events?mode=online&eligibility=open&after=2026-11-01 returns {runId,datasetId,events}. Mode: online/in-person/hybrid/unknown. Eligibility: open/student-only/unknown. Unknown excludes conflicting/unverified values. after is YYYY-MM-DD, inclusive, compared against verified ISO deadline day; missing or ambiguous deadlines are excluded. Invalid filters return 400.
GET /api/events/:id returns {event,findings,sources,runId,datasetId}; unknown IDs return 404.
GET /api/evidence returns all findings/sources/roles and dataset identity.
The static UI calls these APIs. Browser shortlist storage key is radar:<runId>:shortlist; saved entries survive reload and are isolated across runs. All factual field displays include claim-specific citations and source retrieval timestamps. Unknown and conflicting facts stay visibly marked. No external CDN.
