export function createShortlist(storage, runId) {
 const key = `radar:${runId}:shortlist`;
 let ids = new Set();
 try { const parsed = JSON.parse(storage.getItem(key) || '[]'); if (Array.isArray(parsed)) ids = new Set(parsed.filter(id => typeof id === 'string')); } catch {}
 return { has: id => ids.has(id), values: () => [...ids], toggle(id) { ids.has(id) ? ids.delete(id) : ids.add(id); try { storage.setItem(key,JSON.stringify([...ids])); } catch {} return ids.has(id); } };
}
