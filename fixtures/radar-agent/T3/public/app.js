import { createShortlist } from './shortlist.js';
const $ = id => document.getElementById(id);
const labels = {location:'Location',attendanceMode:'Attendance',eventDates:'Event dates',deadline:'Submission deadline',timezone:'Deadline timezone',eligibility:'Eligibility',prizes:'Prizes',judging:'Judging criteria',deliverables:'What to submit'};
let dataset, shortlist;
const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
const safeLink = (url, label, className) => { const link = text('a',label,className); try { if (!['http:','https:'].includes(new URL(url).protocol)) throw new Error(); link.href=url; link.target='_blank'; link.rel='noopener noreferrer'; } catch { link.removeAttribute('href'); } return link; };
function citations(event, field) {
 const fragment = document.createDocumentFragment();
 for (const id of event.fields[field].findingIds) {
  const finding = dataset.findings.find(f => f.id===id && f.eventId===event.id && f.field===field);
  const source = finding && dataset.sources.find(s => s.id===finding.sourceId);
  if (!source) continue;
  const link = safeLink(source.url,'↗ source','citation'); link.dataset.findingId=finding.id; link.dataset.sourceId=source.id; link.title=`${source.title} · retrieved ${source.retrievedAt}`; fragment.append(link);
 }
 return fragment;
}
function claim(event, field) {
 const c = event.fields[field];
 const row = document.createElement('div'); row.dataset.field=field;
 const dt = text('dt',labels[field]);
 const value = c.status === 'unknown' ? 'Not verified' : c.status==='conflicting' ? `Conflicting sources${c.value ? ': '+c.value : ''}` : c.value ?? 'Not verified';
 const dd = text('dd',value); dd.append(citations(event,field)); row.append(dt,dd); return row;
}
function openDialog(content) { $('detail-body').replaceChildren(content); $('detail').showModal(); }
function showDetails(event) {
 const wrapper=text('section','', 'detail-list'); wrapper.append(text('div','Opportunity details','eyebrow'),text('h2',event.name),safeLink(event.officialUrl,'Visit official event page ↗'));
 const facts=text('dl','','facts'); for (const field of Object.keys(labels)) facts.append(claim(event,field)); wrapper.append(facts);
 const evidence=text('p','Each source link supports its specific field. Eligibility remains subject to the official rules.','disclosure'); wrapper.append(evidence); openDialog(wrapper);
}
function showEvidence() {
 const wrapper=text('section',''); wrapper.append(text('div',dataset.researchMode+' research','eyebrow'),text('h2','Follow the evidence'),text('p',`Run ${dataset.runId} · dataset ${dataset.datasetId}`,'source-meta'));
 for (const source of dataset.sources) {
  const item=text('div','','source-item'); item.append(safeLink(source.url,source.title || source.url),text('p',`Retrieved ${source.retrievedAt} · ${source.id}`,'source-meta'));
  for (const finding of dataset.findings.filter(f => f.sourceId===source.id)) { item.append(text('p',`${finding.eventId} → ${labels[finding.field] || finding.field} · ${finding.id}`,'source-meta'),text('div',finding.quote,'quote')); }
  wrapper.append(item);
 }
 openDialog(wrapper);
}
function card(event) {
 const article=text('article','','card'); article.dataset.eventId=event.id;
 const top=text('div','','card-top'); const chips=text('div','','chips');
 for (const field of ['attendanceMode','eligibility']) { const c=event.fields[field]; chips.append(text('span',c.status==='verified' ? c.value ?? 'Not verified' : 'Not verified',c.status==='verified' ? 'chip' : 'chip warn')); }
 const deadline=event.fields.deadline;
 if (deadline.status==='verified' && /^\d{4}-\d{2}-\d{2}/.test(deadline.value || '') && deadline.value.slice(0,10)<new Date().toISOString().slice(0,10)) chips.append(text('span','Deadline passed','chip warn'));
 top.append(chips,text('h2',event.name)); const facts=text('dl','','facts'); for (const field of ['location','deadline','prizes']) facts.append(claim(event,field)); top.append(facts);
 const footer=text('div','','card-footer'); const details=text('button','Explore details ↗','detail-button'); details.addEventListener('click',()=>showDetails(event));
 const save=text('button','','save'); save.setAttribute('aria-label',`Save ${event.name}`);
 const refresh=()=>{ const active=shortlist.has(event.id); save.textContent=active ? '✓ Shortlisted' : '+ Shortlist'; save.setAttribute('aria-pressed',String(active)); };
 refresh(); save.addEventListener('click',()=>{shortlist.toggle(event.id);refresh();updateCount();if($('saved').checked) render();}); footer.append(details,save); article.append(top,footer); return article;
}
function updateCount() { $('saved-count').textContent=String(shortlist.values().filter(id=>dataset.events.some(e=>e.id===id)).length); }
let requestVersion=0;
async function render() {
 const version=++requestVersion;
 try {
  const query=new URLSearchParams(); for (const field of ['mode','eligibility','after']) if ($(field).value) query.set(field,$(field).value);
  const response=await fetch('/api/events?'+query); if (!response.ok) throw new Error('The selected filters could not be loaded.');
  const result=await response.json(); if(version!==requestVersion) return;
  if(result.runId!==dataset.runId || result.datasetId!==dataset.datasetId) throw new Error('Dataset changed. Reload the page to continue.');
  const events=result.events.filter(event=>!$('saved').checked || shortlist.has(event.id));
  $('cards').replaceChildren(...events.map(card)); if(!events.length) $('cards').append(text('div','No matches yet. Try another filter or add an event to your shortlist.','empty'));
  $('count').textContent=`${events.length} ${events.length===1 ? 'opportunity' : 'opportunities'}${$('saved').checked ? ' in your shortlist' : ' to explore'}`; $('error').textContent=''; updateCount();
 } catch(error) { $('error').textContent=error.message; }
}
async function init() {
 try {
  const response=await fetch('/api/dataset'); if(!response.ok) throw new Error('Research data is not available yet. Please try again shortly.'); dataset=await response.json();
  let storage; try { storage=window.localStorage; } catch { storage={getItem:()=>null,setItem:()=>{}}; }
  shortlist=createShortlist(storage,dataset.runId);
  $('run').textContent=`${dataset.researchMode.toUpperCase()} · ${dataset.runId}`; $('footer-run').textContent=`Dataset ${dataset.datasetId}`;
  $('provenance').textContent=`Researched ${dataset.createdAt}. ${dataset.events.length} events; ${dataset.shortfall ? dataset.shortfall+' fewer than the requested five.' : 'each with linked evidence.'} Research mode: ${dataset.researchMode}. Dates and eligibility may change; confirm with the organizer.`;
  $('filters').addEventListener('change',render); $('filters').addEventListener('submit',e=>e.preventDefault()); $('filters').addEventListener('reset',()=>setTimeout(render,0)); $('evidence').addEventListener('click',showEvidence); $('detail').querySelector('.close').addEventListener('click',()=>$('detail').close()); await render();
 } catch(error) { $('loading')?.remove(); $('count').textContent='Research data unavailable'; $('error').textContent=error.message; }
}
init();
