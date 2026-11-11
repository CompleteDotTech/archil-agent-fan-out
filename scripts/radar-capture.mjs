#!/usr/bin/env node
// Capture observed live rehearsal state; never starts or represents a judges' run.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const [address, destination, maximum = '900'] = process.argv.slice(2);
if (!address || !destination) { console.log('Usage: node scripts/radar-capture.mjs LOCAL_DASHBOARD_URL NEW_OUTPUT_DIR [MAX_SECONDS=900]'); process.exit(2); }
const url = new URL(address);
const runId = url.searchParams.get('run');
const maxSeconds = Number(maximum);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !runId || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 900) throw new Error('Expected local HTTP dashboard with run ID and 0 < MAX_SECONDS <= 900');
const output = path.resolve(destination);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // A previous capture is immutable.
await mkdir(path.join(output, 'frames'));
const profile = await mkdtemp(path.join(tmpdir(), 'radar-live-capture-'));
const report = { runId, dashboardUrl: url.href, label: 'Actual live rehearsal capture, not a judges run', startedAt: new Date().toISOString(), maximumSeconds: maxSeconds, intervalSeconds: 2, frames: 0, stopReason: null, recording: null, errors: [] };
let browser, socket, sessionId;
const pending = new Map();
let sequence = 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = sequence++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function startBrowser() {
  browser = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Chromium startup timed out')), 20000);
    browser.once('error', reject);
    browser.once('exit', code => reject(new Error(`Chromium exited (${code})`)));
    browser.stderr.on('data', chunk => { log = (log + chunk).slice(-10000); const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', message => { const data = JSON.parse(message.data); const operation = pending.get(data.id); if (!operation) return; pending.delete(data.id); clearTimeout(operation.timer); data.error ? operation.reject(new Error(data.error.message)) : operation.resolve(data.result); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: url.href });
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.getElementById('research-roles')`)) return; await sleep(100); }
  throw new Error('Dashboard UI did not load');
}
function safeSnapshot(snapshot, capturedAt) {
  const events = snapshot.evidenceEvents ?? snapshot.events ?? [];
  return {
    capturedAt, runId, statuses: snapshot.statuses, attempts: (snapshot.attempts ?? []).map(({ runId, taskId, attemptId, sandboxId, n, state, resume, startedAt, deadlineAt }) => ({ runId, taskId, attemptId, sandboxId, n, state, resume, startedAt, deadlineAt })),
    evidence: events.filter(({ event }) => ['research.role', 'research.dataset', 'gate.result', 'pr.opened', 'pr.merged', 'integration.result', 'run.done'].includes(event.type)).map(({ index, event }) => ({ index, type: event.type, taskId: event.taskId, at: event.at, data: event.type === 'integration.result' ? { pass: event.data.pass, final: event.data.final } : event.data })),
  };
}
async function finishVideo() {
  if (!report.frames) return;
  const movie = path.join(output, 'live-rehearsal.mp4');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '0.5', '-i', path.join(output, 'frames', '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-movflags', '+faststart', movie], { maxBuffer: 1024 * 1024 });
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', movie])).stdout);
  await exec('ffmpeg', ['-v', 'error', '-i', movie, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 });
  report.recording = { path: movie, bytes: (await stat(movie)).size, metadata: probe, completeDecodePassed: true, note: 'Silent 0.5fps browser capture. Frame sidecars contain actual timestamps; nominal video duration reflects two seconds per frame.' };
}
try {
  await startBrowser();
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxSeconds) {
    const tick = Date.now();
    const capturedAt = new Date().toISOString();
    const response = await fetch(new URL(`/api/runs/${encodeURIComponent(runId)}`, url));
    if (!response.ok) throw new Error(`Run snapshot HTTP ${response.status}`);
    const snapshot = await response.json();
    const summary = safeSnapshot(snapshot, capturedAt);
    const view = Math.floor(report.frames / 4) % 3;
    await evaluate(`(() => { const target=${JSON.stringify(view === 0 ? 'research-heading' : view === 1 ? 'tasks-heading' : 'trace-heading')}; document.getElementById(target)?.scrollIntoView({block:'start'}); if(target==='trace-heading'){ const rows=Array.from(document.querySelectorAll('.task-select'));(rows.at(-1)||rows[0])?.click(); } let e=document.getElementById('live-capture-label'); if(!e){e=document.createElement('div');e.id='live-capture-label';e.style.cssText='position:fixed;bottom:14px;right:14px;z-index:10000;background:#101a2a;border:2px solid #80d8ff;color:white;padding:14px 20px;font:15px system-ui;border-radius:10px;box-shadow:0 3px 20px #000';document.body.append(e);} e.textContent=${JSON.stringify(`LIVE REHEARSAL CAPTURE · ${runId} · ${capturedAt}`)}; })()`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const basename = String(report.frames).padStart(5, '0');
    await writeFile(path.join(output, 'frames', basename + '.png'), Buffer.from(data, 'base64'));
    await writeFile(path.join(output, 'frames', basename + '.json'), JSON.stringify(summary, null, 2) + '\n');
    report.frames++;
    await writeFile(path.join(output, 'capture.json'), JSON.stringify(report, null, 2) + '\n');
    if (report.frames === 1 || report.frames % 15 === 0) console.log(JSON.stringify({ capturedAt, runId, frames: report.frames, statuses: snapshot.statuses }));
    if (summary.evidence.some(item => item.type === 'run.done')) { report.stopReason = 'Observed run.done event'; break; }
    await sleep(Math.max(0, 2000 - (Date.now() - tick)));
  }
  report.stopReason ??= 'Maximum capture duration reached; no completion inferred';
} catch (error) {
  report.errors.push(error.message); report.stopReason = 'Capture error'; process.exitCode = 1;
} finally {
  try { await finishVideo(); } catch (error) { report.errors.push(`Video validation: ${error.message}`); process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  report.actualElapsedSeconds = (Date.parse(report.completedAt) - Date.parse(report.startedAt)) / 1000;
  await writeFile(path.join(output, 'capture.json'), JSON.stringify(report, null, 2) + '\n');
  socket?.close(); browser?.kill('SIGTERM'); await sleep(300); await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ output, frames: report.frames, stopReason: report.stopReason, recording: report.recording?.path ?? null, errors: report.errors }));
}
