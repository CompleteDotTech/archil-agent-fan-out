#!/usr/bin/env node
/** Play an actual local MP4 in Chromium and capture decoded start/mid/end frames.
 * Usage: node scripts/radar-playback.mjs RECORDING.mp4 NEW_OUTPUT_DIR
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const [input, directory] = process.argv.slice(2);
if (!input || !directory) { console.log('Usage: node scripts/radar-playback.mjs RECORDING.mp4 NEW_OUTPUT_DIR'); process.exit(2); }
const recording = path.resolve(input);
const output = path.resolve(directory);
const file = await stat(recording);
if (!file.isFile()) throw new Error('Input is not a recording file');
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const profile = await mkdtemp(path.join(tmpdir(), 'radar-playback-'));
const report = { recording, startedAt: new Date().toISOString(), label: 'Browser playback check of a silent recording; not a live run', checks: [], samples: [], errors: [] };
let browser, socket, sessionId;
let id = 0;
const operations = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#08131e;color:#eaf7ff;font:16px system-ui}header{padding:18px 24px;border-bottom:1px solid #5286a4}video{display:block;width:100%;height:calc(100vh - 62px);object-fit:contain;background:#000}</style></head><body><header>SILENT RECORDING · Browser playback verification · not a live run</header><video id="video" src="/recording.mp4" controls autoplay muted playsinline preload="auto"></video></body></html>`);
    return;
  }
  if (req.url !== '/recording.mp4') { res.writeHead(404); res.end(); return; }
  const range = req.headers.range;
  if (!range) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': file.size, 'Accept-Ranges': 'bytes' }); createReadStream(recording).pipe(res); return; }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
  const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
  if (start > end || start >= file.size) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
  res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Accept-Ranges': 'bytes' });
  createReadStream(recording, { start, end }).pipe(res);
});
function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const sequence = ++id;
    const timer = setTimeout(() => { operations.delete(sequence); reject(new Error(`CDP ${method} timed out`)); }, 20000);
    operations.set(sequence, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: sequence, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await sleep(100); }
  const error = await evaluate(`document.getElementById('video')?.error?.message || ''`);
  throw new Error(`Playback condition timed out: ${expression}${error ? ': ' + error : ''}`);
}
function check(name, pass, details) {
  report.checks.push({ name, pass: Boolean(pass), details });
  if (!pass) throw new Error(`Playback check failed: ${name}`);
}
async function connect(url) {
  browser = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Chromium startup timed out')), 20000);
    browser.once('error', reject); browser.once('exit', code => reject(new Error(`Chromium exited (${code})`)));
    browser.stderr.on('data', chunk => { log = (log + chunk).slice(-10000); const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', message => { const data = JSON.parse(message.data); const op = operations.get(data.id); if (!op) return; operations.delete(data.id); clearTimeout(op.timer); data.error ? op.reject(new Error(data.error.message)) : op.resolve(data.result); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await connect(`http://127.0.0.1:${port}/`);
  await waitFor(`(() => { const v=document.getElementById('video');return v && Number.isFinite(v.duration) && v.duration>0 && v.readyState>=2;})()`);
  const metadata = await evaluate(`(() => {const v=document.getElementById('video');v.pause();return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState};})()`);
  report.metadata = metadata;
  check('loaded recording metadata and decoded video', metadata.duration > 0 && metadata.width > 0 && metadata.height > 0, metadata);
  await evaluate(`(async()=>{const v=document.getElementById('video');v.currentTime=0;await v.play();})()`);
  const before = await evaluate(`document.getElementById('video').currentTime`);
  await sleep(Math.min(800, metadata.duration * 250));
  const after = await evaluate(`document.getElementById('video').currentTime`);
  check('video clock advances during actual playback', after > before + Math.min(0.1, metadata.duration / 5), { before, after });
  await evaluate(`document.getElementById('video').pause()`);
  for (const [name, target] of [['start', Math.min(0.05, metadata.duration / 10)], ['middle', metadata.duration / 2], ['end', Math.max(0, metadata.duration - 0.1)]]) {
    await evaluate(`document.getElementById('video').currentTime=${target}`);
    await waitFor(`(() => {const v=document.getElementById('video');return !v.seeking && v.readyState>=2 && Math.abs(v.currentTime-${target})<0.1;})()`);
    // Give Chromium a paint turn after the decoded seek frame is available.
    await sleep(150);
    const actual = await evaluate(`(() => {const v=document.getElementById('video');return {currentTime:v.currentTime,readyState:v.readyState,paused:v.paused,error:v.error?.message||null,decodedFrames:v.getVideoPlaybackQuality?.().totalVideoFrames ?? null};})()`);
    check(`seek and decode ${name} sample`, Math.abs(actual.currentTime - target) < 0.1 && !actual.error, actual);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const filename = `${name}.png`;
    await writeFile(path.join(output, filename), Buffer.from(data, 'base64'));
    report.samples.push({ name, target, ...actual, screenshot: filename });
  }
} catch (error) {
  report.errors.push(error.message); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.pass = report.errors.length === 0 && report.checks.every(item => item.pass);
  await writeFile(path.join(output, 'playback.json'), JSON.stringify(report, null, 2) + '\n');
  socket?.close(); browser?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await sleep(250); await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ output, pass: report.pass, checks: report.checks.length, errors: report.errors }));
}
