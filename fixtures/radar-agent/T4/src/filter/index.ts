import type { FilterEvents, Claim } from '../types.js';
const category = (claim: Claim): string => claim.status === 'verified' && claim.value ? claim.value : 'unknown';
export const filterEvents: FilterEvents = (events, filters) => events.filter(event => {
 if (filters.mode && category(event.fields.attendanceMode) !== filters.mode) return false;
 if (filters.eligibility && category(event.fields.eligibility) !== filters.eligibility) return false;
 if (filters.after) {
  const claim = event.fields.deadline;
  if (claim.status !== 'verified' || !claim.value || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(claim.value) || !Number.isFinite(Date.parse(claim.value)) || claim.value.slice(0,10) < filters.after) return false;
 }
 return true;
});
