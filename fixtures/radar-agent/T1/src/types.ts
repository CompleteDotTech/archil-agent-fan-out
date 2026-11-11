export interface Claim { value: string | null; status: 'verified' | 'unknown' | 'conflicting'; findingIds: string[] }
export type Field = 'location' | 'attendanceMode' | 'eventDates' | 'deadline' | 'timezone' | 'eligibility' | 'prizes' | 'judging' | 'deliverables';
export interface RadarEvent { id: string; name: string; officialUrl: string; fields: Record<Field, Claim> }
export interface RadarSource { id: string; url: string; title: string; retrievedAt: string; query: string; contentHash: string }
export interface RadarFinding { id: string; eventId: string; role: string; field: string; value: string; sourceId: string; quote: string; status: string }
export interface RadarDataset { schemaVersion: 1; runId: string; datasetId: string; createdAt: string; researchMode: 'fresh' | 'fixture' | 'cache'; events: RadarEvent[]; sources: RadarSource[]; findings: RadarFinding[]; roles: unknown[]; shortfall: number }
export interface Filters { mode?: string; eligibility?: string; after?: string }
export type FilterEvents = (events: RadarEvent[], filters: Filters) => RadarEvent[];
