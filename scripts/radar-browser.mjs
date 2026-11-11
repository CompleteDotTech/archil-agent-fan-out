#!/usr/bin/env node
/** Local-only browser QA and honestly labelled, silent rehearsal recording.
 * node scripts/radar-browser.mjs http://127.0.0.1:3100 out/browser --record-seconds 180 --dashboard http://127.0.0.1:3000/?run=...
 * Requires system chromium, ffmpeg and ffprobe. No npm dependencies.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.includes('--help') || args.length < 2) {
  console.log('Usage: node scripts/radar-browser.mjs APP_URL NEW_OUTPUT_DIR [--record-seconds 180] [--dashboard LOCAL_DASHBOARD_URL]');
  process.exit(args.includes('--help') ? 0 : 2);
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only local HTTP app/dashboard URLs are allowed');
  return url.href;
}
const appUrl = localUrl(args[0]);
const output = path.resolve(args[1]);
const secondsIndex = args.indexOf('--record-seconds');
const recordSeconds = secondsIndex < 0 ? 0 : Number(args[secondsIndex + 1]);
if (!Number.isInteger(recordSeconds) || recordSeconds < 0 || recordSeconds > 600) throw new Error('Record duration must be 0–600 seconds');
const dashboardIndex = args.indexOf('--dashboard');
const dashboardUrl = dashboardIndex < 0 ? undefined : localUrl(args[dashboardIndex + 1]);
await mkdir(output); // Deliberately refuse overwriting any earlier evidence.
const profile = await mkdtemp(path.join(tmpdir(), 'radar-chromium-'));
const report = { appUrl, dashboardUrl: dashboardUrl ?? null, startedAt: new Date().toISOString(), recording: null, checks: [], errors: [] };
let chromium;
let cdp;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, pass, details) {
  report.checks.push({ name, pass: Boolean(pass), details });
  if (!pass) throw new Error(`Browser acceptance failed: ${name}`);
}
async function connect() {
  chromium = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('Chromium CDP startup timed out')), 20000);
    chromium.once('error', reject);
    chromium.once('exit', code => reject(new Error(`Chromium exited before CDP startup (${code})`)));
    chromium.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-10000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', message => {
    const data = JSON.parse(message.data);
    if (!data.id) return;
    const operation = pending.get(data.id);
    if (!operation) return;
    pending.delete(data.id); clearTimeout(operation.timer);
    if (data.error) operation.reject(new Error(data.error.message)); else operation.resolve(data.result);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  cdp = { send: (method, params) => send(method, params, sessionId), close: () => socket.close() };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description ?? ''));
  return result.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await sleep(150); }
  throw new Error(`Timed out waiting for browser: ${expression}`);
}
async function navigate(url, ready) {
  await cdp.send('Page.navigate', { url });
  await waitFor(ready);
}
async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(data, 'base64'));
}
async function setFilter(id, value) {
  await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(350);
  await waitFor(`!document.getElementById('error')?.textContent`);
}
async function visibleIds() { return evaluate(`Array.from(document.querySelectorAll('.card')).map(e=>e.dataset.eventId).sort()`); }
async function reset() { await evaluate(`document.getElementById('filters').reset()`); await sleep(400); }
async function label(text) {
  await evaluate(`(() => { let e=document.getElementById('recording-label'); if(!e){e=document.createElement('div');e.id='recording-label'; e.style.cssText='position:fixed;bottom:12px;right:12px;z-index:100000;background:#172d2a;color:white;border:1px solid #bacdbc;border-radius:8px;padding:12px 18px;font:14px system-ui;max-width:500px;box-shadow:0 3px 15px #0006';document.body.append(e);} e.textContent=${JSON.stringify(text)}; })()`);
}
try {
  await connect();
  await navigate(appUrl, `document.querySelectorAll('.card').length > 0`);
  const dataset = await evaluate(`fetch('/api/dataset').then(r=>r.json())`);
  report.runId = dataset.runId; report.datasetId = dataset.datasetId; report.researchMode = dataset.researchMode;
  check('five researched events rendered', dataset.events.length === 5 && (await visibleIds()).length === 5, { expected: 5, actual: dataset.events.length });
  await screenshot('01-delivered-app.png');
  // Use source-derived values, so QA remains valid for future fresh datasets.
  for (const [id, field] of [['mode', 'attendanceMode'], ['eligibility', 'eligibility']]) {
    const candidate = dataset.events.find(e => e.fields[field].status === 'verified' && e.fields[field].value);
    if (!candidate) { check(`${id} filter has verified evidence`, false, 'No verified field to exercise'); }
    const value = candidate.fields[field].value;
    await setFilter(id, value);
    const actual = await visibleIds();
    const expected = dataset.events.filter(e => e.fields[field].status === 'verified' && e.fields[field].value === value).map(e => e.id).sort();
    check(`${id} filter`, JSON.stringify(actual) === JSON.stringify(expected), { value, expected, actual });
    await reset();
  }
  const deadline = dataset.events.find(e => e.fields.deadline.status === 'verified' && /^\d{4}-\d{2}-\d{2}/.test(e.fields.deadline.value || ''));
  check('deadline filter has verified evidence', Boolean(deadline), { eventId: deadline?.id });
  const after = deadline.fields.deadline.value.slice(0, 10);
  await setFilter('after', after);
  const actual = await visibleIds();
  const expected = dataset.events.filter(e => e.fields.deadline.status === 'verified' && /^\d{4}-\d{2}-\d{2}/.test(e.fields.deadline.value || '') && e.fields.deadline.value.slice(0, 10) >= after).map(e => e.id).sort();
  check('deadline filter excludes unknown and earlier dates', JSON.stringify(actual) === JSON.stringify(expected), { after, expected, actual });
  await screenshot('02-deadline-filter.png'); await reset();
  const selected = await evaluate(`(() => {const card=document.querySelector('.card');const save=card.querySelector('.save');if(save.getAttribute('aria-pressed')!=='true')save.click();return card.dataset.eventId})()`);
  await navigate(appUrl, `document.querySelectorAll('.card').length > 0`);
  const persisted = await evaluate(`document.querySelector('.card[data-event-id='+CSS.escape(${JSON.stringify(selected)})+'] .save')?.getAttribute('aria-pressed')`);
  check('shortlist survives browser reload', persisted === 'true', { eventId: selected });
  const isolation = await evaluate(`(async()=>{ const {createShortlist}=await import('/shortlist.js');const other=createShortlist(localStorage,${JSON.stringify(dataset.runId + '-isolated-browser-check')});return {current:JSON.parse(localStorage.getItem(${JSON.stringify('radar:' + dataset.runId + ':shortlist')})||'[]'),other:other.values()};})()`);
  check('shortlist isolated by run ID', isolation.current.includes(selected) && isolation.other.length === 0, isolation);
  await evaluate(`document.querySelector('.detail-button').click()`);
  await waitFor(`document.getElementById('detail').open`);
  const links = await evaluate(`Array.from(document.querySelectorAll('#detail .citation')).map(a=>({href:a.href,findingId:a.dataset.findingId,sourceId:a.dataset.sourceId,title:a.title,target:a.target}))`);
  check('details have cited claims', links.length > 0, { count: links.length });
  const mapped = links.every(link => {
    const finding = dataset.findings.find(f => f.id === link.findingId);
    const source = dataset.sources.find(s => s.id === link.sourceId);
    return finding && source && finding.sourceId === source.id && link.href === new URL(source.url).href && link.title.includes(source.retrievedAt) && link.target === '_blank';
  });
  check('clickable citations map to findings and intended sources', mapped, links);
  await screenshot('03-details-citations.png');
  await evaluate(`document.querySelector('#detail .close').click();document.getElementById('evidence').click()`);
  await waitFor(`document.querySelectorAll('.source-item').length > 0`);
  check('evidence view exposes all dataset sources', await evaluate(`document.querySelectorAll('.source-item').length`) === dataset.sources.length, { sources: dataset.sources.length });
  await screenshot('04-evidence.png');
  await evaluate(`document.querySelector('#detail .close').click()`);
  if (recordSeconds) {
    const frames = path.join(output, 'frames'); await mkdir(frames);
    const start = Date.now(); let frame = 0; let stage = -1;
    const baseLabel = `REHEARSAL RECORDING · ${dataset.runId} · ${dataset.researchMode} research`;
    while ((Date.now() - start) / 1000 < recordSeconds) {
      const elapsed = (Date.now() - start) / 1000;
      const nextStage = elapsed < 25 ? 0 : elapsed < 60 ? 1 : elapsed < 95 ? 2 : elapsed < 140 ? 3 : 4;
      if (nextStage !== stage) {
        stage = nextStage;
        if (stage === 0) { await reset(); await setFilter('mode', 'online'); }
        if (stage === 1 && dashboardUrl) await navigate(dashboardUrl, `document.getElementById('research-roles')?.children.length > 0`);
        if (stage === 2 && dashboardUrl) await evaluate(`document.getElementById('tasks')?.scrollIntoView({block:'start'})`);
        if (stage === 3 && dashboardUrl) { await evaluate(`(() => { const tasks=Array.from(document.querySelectorAll('.task-select'));(tasks.at(-1)||tasks[0])?.click();document.getElementById('trace')?.scrollIntoView({block:'center'});})()`); }
        if (stage === 4 || (!dashboardUrl && stage > 0)) { await navigate(appUrl, `document.querySelectorAll('.card').length > 0`); if (stage === 4) await evaluate(`document.getElementById('evidence').click()`); }
        await label(baseLabel + (dashboardUrl && stage > 0 && stage < 4 ? ' · recorded run evidence; no fresh judges run claimed' : ' · delivered app walkthrough'));
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path.join(frames, `${String(frame++).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
      await sleep(Math.max(0, (start + frame * 1000) - Date.now()));
    }
    const movie = path.join(output, 'rehearsal.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', path.join(frames, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-movflags', '+faststart', movie], { maxBuffer: 1024 * 1024 });
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', movie])).stdout);
    await exec('ffmpeg', ['-v', 'error', '-i', movie, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 });
    check('backup recording decodes completely', Number(probe.format.duration) >= recordSeconds - 2, probe);
    report.recording = { file: movie, frames: frame, requestedSeconds: recordSeconds, duration: Number(probe.format.duration), bytes: (await stat(movie)).size, validation: 'ffprobe metadata and complete ffmpeg decode; silent browser walkthrough, not a narrated presentation or judges execution' };
  }
} catch (error) {
  report.errors.push(error.message);
  if (cdp) { try { await screenshot('failure.png'); } catch {} }
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.pass = report.errors.length === 0 && report.checks.every(item => item.pass);
  await writeFile(path.join(output, 'browser-qa.json'), JSON.stringify(report, null, 2) + '\n');
  cdp?.close(); chromium?.kill('SIGTERM');
  await sleep(300); await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ output, pass: report.pass, checks: report.checks.length, errors: report.errors, recording: report.recording?.file ?? null }));
}
