/** Execute one explicit, verified post-delivery correction on a completed judges run.
 * Never starts a judges run. Usage: node --import tsx scripts/radar-followup.ts
 *   --run ID --task trusted-task.json [--github-cli-auth] [--retry]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as sdk from 'disk';
import { serve } from '@hono/node-server';
import { readRun, type RadarRunRecord } from './radar-run.js';
import { createArchilDisk, createArchilSandboxRunner, createSqliteStore, archilDb } from '../src/archil/index.js';
import { createGitHubClient, createPublisher, type ProjectConfig } from '../src/github/index.js';
import { createGate, createIntegrator } from '../src/orchestrator/index.js';
import { createDashboard } from '../src/dashboard/server.js';
import { taskSpecSchema } from '../src/planner/schema.js';
import { validatePlan } from '../src/planner/validate.js';
import { radarDatasetSchema } from '../src/research/radar-schema.js';
import type { Attempt, Manifest, Publisher, TaskStatus } from '../src/contracts/types.js';

const exec = promisify(execFile);
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
interface Followup {
  taskId: string; status: 'running'|'completed'|'failed'; startedAt: string; endedAt?: string;
  previousCompletedAt?: string; softwareRevision: string; taskSha256: string;
  sandboxId?: string; baseCommit?: string; headCommit?: string; prNumber?: number; prUrl?: string;
  failurePhase?: string; phase?: string; attemptId?: string; n?: number;
  diagnostic?: ReturnType<typeof safeDiagnostic>;
}
type RecordWithFollowups = RadarRunRecord & { followups?: Followup[] };

/** Keep useful SDK failure metadata without copying credentials into evidence. */
export function safeDiagnostic(error: unknown, env: NodeJS.ProcessEnv = process.env): { name: string; code?: string; status?: number; message: string } {
  const redact = (text: string): string => {
    let value = text;
    const secrets = Object.entries(env).filter(([key, item]) => /token|key|secret|password|credential|auth/i.test(key) && item && item.length >= 4)
      .flatMap(([, item]) => [item!, encodeURIComponent(item!)]).sort((a, b) => b.length - a.length);
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b(?:github_pat_[\w]+|gh[pousr]_[\w]+|sk-[\w-]{8,})\b/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[\w+/=._-]+/gi, '$1 [REDACTED]')
      .slice(0, 3000);
  };
  const value = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown } | null;
  const status = typeof value?.status === 'number' ? value.status : typeof value?.statusCode === 'number' ? value.statusCode : undefined;
  return {
    name: redact(typeof value?.name === 'string' ? value.name : 'Error'),
    ...(typeof value?.code === 'string' ? { code: redact(value.code) } : {}),
    ...(status === undefined ? {} : { status }),
    message: redact(typeof value?.message === 'string' ? value.message : String(error)),
  };
}

export async function executeFollowup(root: string, runId: string, taskPath: string, options: { retry?: boolean } = {}): Promise<void> {
  const record = await readRun(root, runId) as RecordWithFollowups;
  if (record.mode !== 'judges' || record.status !== (options.retry ? 'failed' : 'completed')) throw new Error(options.retry
    ? 'Retry requires a judges run failed by its previous followup' : 'Followup requires a completed judges run');
  const taskText = await readFile(resolve(root, taskPath), 'utf8');
  const task = taskSpecSchema.parse(JSON.parse(taskText));
  if (task.kind !== 'task' || !/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error('Expected one task with a safe task ID');
  const taskSha256 = createHash('sha256').update(taskText).digest('hex');
  const previousFollowups = (record.followups ?? []).filter(item => item.taskId === task.id);
  const previousFollowup = previousFollowups.at(-1);
  if (options.retry) {
    if (previousFollowups.length !== 1 || previousFollowup?.status !== 'failed' || record.followups?.at(-1) !== previousFollowup
      || previousFollowup.taskSha256 !== taskSha256) throw new Error('Retry requires the same TaskSpec hash and exactly one failed prior attempt');
  } else if (previousFollowups.length) throw new Error('Followup task already recorded; use --retry for one failed matching attempt');
  const n = previousFollowups.length + 1;
  const attemptId = `${task.id}-a${n}`;
  const followupScope = n === 1 ? task.id : attemptId;
  for (const name of ['ARCHIL_API_KEY','ARCHIL_DISK_ID','OPENAI_API_KEY','GITHUB_TOKEN','GITHUB_PUSH_TOKEN']) {
    if (!process.env[name]) throw new Error(`${name} is required for a real followup`);
  }
  const region = process.env.ARCHIL_REGION || 'aws-us-west-2';
  const diskId = process.env.ARCHIL_DISK_ID!;
  sdk.configure({ apiKey: process.env.ARCHIL_API_KEY!, region });
  const disk = createArchilDisk({ diskId, region, apiKey: process.env.ARCHIL_API_KEY! });
  const store = createSqliteStore(archilDb(await sdk.getDisk(diskId), `swarm/${runId}/state.sqlite`));
  await store.init();
  const previousPlan = await store.getPlan(runId);
  if (!previousPlan || previousPlan.targetRepo !== record.targetRepo || previousPlan.baseBranch !== 'main') throw new Error('Persisted plan does not match run target');
  const existingTask = previousPlan.tasks.find(item => item.id === task.id);
  if (options.retry ? !existingTask || JSON.stringify(taskSpecSchema.parse(existingTask)) !== JSON.stringify(task) : !!existingTask) {
    throw new Error(options.retry ? 'Retry task does not match the persisted TaskSpec' : 'Task ID already exists in persisted plan');
  }
  if ((await store.listAttempts(runId)).some(item => item.taskId === task.id && item.n >= n)) throw new Error('Attempt ID already exists; at most two followup attempts are permitted');
  const datasetRaw = await disk.read(`/research/${runId}/dataset.json`);
  if (!datasetRaw) throw new Error('Existing research dataset is required');
  const dataset = radarDatasetSchema.parse(JSON.parse(datasetRaw));
  if (dataset.runId !== runId) throw new Error('Research dataset belongs to another run');
  const statuses = await store.getTaskStatuses(runId);
  if (previousPlan.tasks.some(item => item.kind === 'task' && item.id !== task.id && statuses[item.id] !== 'done')) throw new Error('All other coding tasks must be delivered before followup');
  if (task.dependsOn.some(id => statuses[id] !== 'done')) throw new Error('Followup dependencies must already be done');
  const plan = { ...previousPlan, tasks: options.retry ? previousPlan.tasks : [...previousPlan.tasks, task] };
  const validation = validatePlan(plan, { maxTasks: previousPlan.tasks.length + 1 });
  if (!validation.ok) throw new Error(`Invalid followup plan: ${validation.errors.join('; ')}`);
  const directory = resolve(root, '.swarm', 'radar', runId);
  const followupDirectory = join(directory, 'followups', followupScope);
  await mkdir(join(directory, 'followups'), { recursive: true });
  await mkdir(followupDirectory); // Refuse to overwrite an interrupted or completed attempt.
  await writeFile(join(followupDirectory, 'task.json'), taskText);
  const previousReport = await disk.read(`/delivery/${runId}/report.md`);
  if (!previousReport) throw new Error('Previous delivery report is missing');
  const archiveReport = `/delivery/${runId}/report-before-followup.md`;
  if (await disk.read(archiveReport) === undefined) await disk.write(archiveReport, previousReport);
  await disk.write(`/delivery/${runId}/report-before-${followupScope}.md`, previousReport);
  await writeFile(join(directory, 'report-before-followup.md'), previousReport, { flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await writeFile(join(followupDirectory, 'report-before.md'), previousReport);
  try { await copyFile(join(directory, 'app.tgz'), join(followupDirectory, 'app-before.tgz')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(join(followupDirectory, 'events-before.json'), JSON.stringify(await store.listEvents(runId), null, 2));
  await disk.write(`/spec/${runId}/followups/${followupScope}/plan-before.json`, JSON.stringify(previousPlan, null, 2));
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  const followup: Followup = { taskId: task.id, attemptId, n, status: 'running', startedAt: new Date().toISOString(), previousCompletedAt: previousFollowup?.previousCompletedAt ?? record.endedAt,
    softwareRevision: revision, taskSha256 };
  record.followups = [...(record.followups ?? []), followup];
  record.status = 'starting';
  delete record.failure;
  const saveRecord = async () => { await writeFile(join(directory, 'run.json'), JSON.stringify(record, null, 2) + '\n'); };
  const append = (type: string, data: Record<string,unknown>, attemptId?: string) => store.appendEvent({ runId, taskId: task.id,
    ...(attemptId ? { attemptId } : {}), at: new Date().toISOString(), type, data });
  await saveRecord();
  const [owner, repo] = record.targetRepo.split('/');
  const client = createGitHubClient({ owner, repo, token: process.env.GITHUB_TOKEN!, dryRun: false });
  let project: ProjectConfig | undefined;
  let sandboxId: string | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let publisher: Publisher | undefined;
  let phase = 'opening followup';
  async function setPhase(next: string) {
    phase = next; followup.phase = next;
    await saveRecord();
    await writeFile(join(followupDirectory, 'progress.json'), JSON.stringify({ phase, at: new Date().toISOString(),
      attemptId, sandboxId: followup.sandboxId, baseCommit: followup.baseCommit }, null, 2));
  }
  let integrator: ReturnType<typeof createIntegrator> | undefined;
  const workerEnv = { AGENT: 'codex', PUSH: '1', TARGET_REPO: record.targetRepo,
    CODEX_API_KEY: process.env.OPENAI_API_KEY!, GITHUB_PUSH_TOKEN: process.env.GITHUB_PUSH_TOKEN! };
  const sandboxes = createArchilSandboxRunner({ region, diskId, env: workerEnv, sdk: new sdk.Archil({ apiKey: process.env.ARCHIL_API_KEY!, region }) });
  async function exportEvidence() {
    for (const kind of ['research', 'runs', 'delivery', 'spec', 'swarm']) {
      const sources=await disk.list(`/${kind}/${runId}/`);
      for(let i=0;i<sources.length;i+=6) await Promise.all(sources.slice(i,i+6).map(async source => {
        const contents = await disk.read(source);
        if (contents === undefined) return;
        const target = resolve(directory, 'artifacts', source.slice(1));
        const prefix = resolve(directory, 'artifacts') + '/';
        if (!target.startsWith(prefix)) throw new Error('Invalid artifact path');
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents);
      }));
    }
    await writeFile(join(directory, 'events.json'), JSON.stringify(await store.listEvents(runId), null, 2));
    await writeFile(join(directory, 'dataset.json'), datasetRaw!);
  }
  try {
    await setPhase('starting followup dashboard');
    const app = createDashboard({ store, disk }, { stopTask: async (run, id) => {
      if (run !== runId || id !== task.id || !sandboxId) throw new Error('No active followup sandbox for this task');
      await sandboxes.stop(sandboxId);
    } }, { projectUrl: process.env.GITHUB_PROJECT_URL });
    app.get('/delivery/:id/report.md', async context => {
      if (context.req.param('id') !== runId) return context.notFound();
      const report = await disk.read(`/delivery/${runId}/report.md`);
      return report === undefined ? context.notFound() : context.text(report);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server = serve({ fetch: app.fetch, port: record.port }, () => resolveListen());
      server.once('error', rejectListen);
    });
    console.log(`Followup ${task.id} — dashboard http://localhost:${record.port}/?run=${runId}`);
    await setPhase('publishing reopened plan');
    await append('run.reopened', { taskId: task.id, attemptId, retry: !!options.retry, reason: task.title, previousCompletedAt: followup.previousCompletedAt, datasetId: dataset.datasetId, researchMode: 'reuse-existing-run-dataset' });
    await store.savePlan(plan); // Existing statuses and issue numbers are preserved by the store.
    await disk.write(`/spec/${runId}/plan.json`, JSON.stringify(plan, null, 2));
    await disk.write(`/spec/${runId}/followups/${followupScope}/task.json`, taskText);
    if (process.env.GITHUB_PROJECT_ID && process.env.GITHUB_STATUS_FIELD_ID) {
      const data = await client.graphql('query($id: ID!) { node(id: $id) { ... on ProjectV2SingleSelectField { options { id name } } } }', { id: process.env.GITHUB_STATUS_FIELD_ID });
      const statusOptionIds = Object.fromEntries((data.node?.options ?? []).map((item: {id:string;name:string}) => [item.name.toLowerCase(), item.id])) as Record<TaskStatus,string>;
      if (!['backlog','ready','running','review','done','blocked'].every(status => statusOptionIds[status as TaskStatus])) throw new Error('Project is missing required status options');
      project = { projectId: process.env.GITHUB_PROJECT_ID, statusFieldId: process.env.GITHUB_STATUS_FIELD_ID, statusOptionIds };
    }
    publisher = createPublisher({ client, project, issueOf: async (run, id) => {
      const issue = (await store.getIssueNumbers(run))[id]; if (issue === undefined) throw new Error('Task issue missing'); return issue;
    } });
    const setStatus = async (id: string, status: TaskStatus) => {
      await store.setTaskStatus(runId, id, status); await publisher!.setStatus(runId, id, status);
      await store.appendEvent({ runId, taskId: id, at: new Date().toISOString(), type: 'task.status', data: { status } });
    };
    await setPhase('publishing followup issue');
    const issues = await publisher.publishPlan(plan);
    for (const [id, number] of Object.entries(issues)) await store.setIssueNumber(runId, id, number);
    // Project publication resets UI status fields; restore every previous state.
    for (const previous of previousPlan.tasks) await publisher.setStatus(runId, previous.id, statuses[previous.id]);
    await append('plan.published', { issues, followup: true });
    for (const epic of plan.tasks.filter(item => item.kind === 'epic')) await setStatus(epic.id, 'running');
    await setStatus(task.id, 'ready');
    await setPhase('preparing followup sandbox');
    const prepared = await sandboxes.prepareTemplate({ runId, targetRepo: record.targetRepo, setup: ['npm ci'] });
    sandboxId = prepared.templateId; followup.sandboxId = sandboxId; followup.baseCommit = prepared.baseCommit;
    await setPhase('creating followup integrator');
    integrator = createIntegrator({ publisher, store, sandboxes, disk }, { runId, integrationSandboxId: sandboxId, finalVerify: ['npm run typecheck','npm test'], deferRunDone: true });
    const workerPath = `/swarm/${runId}/followups/${followupScope}/worker/run-task.sh`;
    await setPhase('reading followup worker script');
    const workerScript = await readFile(resolve(root, 'src/worker/run-task.sh'), 'utf8');
    await setPhase('uploading followup worker script');
    await disk.write(workerPath, workerScript);
    const attemptPath = `/runs/${runId}/${task.id}/${attemptId}`;
    await setPhase('writing followup attempt input');
    await disk.write(`${attemptPath}/task.json`, JSON.stringify(task));
    await setPhase('starting followup sandbox');
    await sandboxes.start(sandboxId);
    const attempt: Attempt = { runId, taskId: task.id, attemptId, n, sandboxId, resume: false, state: 'running',
      startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 900000).toISOString() };
    await setPhase('creating followup attempt record');
    await store.createAttempt(attempt);
    await setPhase('publishing followup running status');
    await setStatus(task.id, 'running');
    await append('attempt.started', { sandboxId, resume: false, followup: true }, attemptId);
    await setPhase('followup coding worker');
    let logs = Promise.resolve();
    let lastLog = 0;
    let logError: unknown;
    await sandboxes.exec(sandboxId, `bash ${quote('/mnt/archil' + workerPath)}`, { timeoutMs: 900000,
      env: { ...workerEnv, RUN_ID: runId, TASK_ID: task.id, ATTEMPT_ID: attemptId, BASE_COMMIT: prepared.baseCommit, RESUME: '0' },
      onOutput: line => { const now=Date.now();if(now-lastLog<2000)return;lastLog=now;logs = logs.then(() => append('agent.log', { line:line.slice(-8000) }, attemptId)).catch(error => { logError = error; }); },
    });
    await logs;
    if (logError) throw logError;
    const raw = await disk.read(`${attemptPath}/manifest.json`);
    if (!raw) throw new Error('Followup worker did not produce a manifest');
    const manifest = JSON.parse(raw) as Manifest;
    if (manifest.runId !== runId || manifest.taskId !== task.id || manifest.attemptId !== attemptId || manifest.baseCommit !== prepared.baseCommit
      || manifest.branch !== `swarm/${runId}/${task.id}/${attemptId}` || !Array.isArray(manifest.changedFiles)) throw new Error('Followup manifest identity mismatch');
    await store.saveManifest(manifest); await store.updateAttempt(runId, attemptId, { state: 'submitted' });
    await setPhase('followup verification gate');
    const gate = await createGate(sandboxes, { timeoutMs: 120000 }).check({ task, manifest, sandboxId });
    await append('gate.result', { pass: gate.pass, findings: gate.findings }, attemptId);
    if (!gate.pass) throw new Error('Followup ownership or verification gate failed');
    await store.updateAttempt(runId, attemptId, { state: 'passed' }); await setStatus(task.id, 'review');
    await setPhase('followup PR delivery');
    const pr = await publisher.openPullRequest({ runId, taskId: task.id, branch: manifest.branch, title: task.title,
      body: `${manifest.summary}\n\nPost-delivery correction for ${runId}. Reuses the existing cited research dataset ${dataset.datasetId}.\n\nVerified: ${task.verify.join('; ')}.` });
    followup.prNumber = pr.number; followup.prUrl = pr.url; followup.headCommit = manifest.headCommit;
    await append('pr.opened', pr, attemptId); await saveRecord();
    integrator.enqueue(task, manifest, pr);
    await integrator.idle(); // Sequential merge, main refresh, and final checks in the same sandbox.
    if ((await store.getTaskStatuses(runId))[task.id] !== 'done') throw new Error('Followup integration failed');
    await setPhase('final integrated verification');
    const integration = (await store.listEvents(runId)).map(item => item.event).filter(event =>
      event.taskId === task.id && event.attemptId === attemptId && event.type === 'integration.result').at(-1);
    if (integration?.data.pass !== true) throw new Error('Final followup integrated tests were not recorded as passing');
    // These are the integrator's actual main-branch checks, not a second run of
    // an already passing suite. Mark them as the final delivery verification.
    await append('integration.result', { pass: true, final: true, followup: true, output: integration.data.output,
      verifiedAt: integration.at, commands: ['npm run typecheck', 'npm test'] }, attemptId);
    await setPhase('archiving delivered app');
    const archive = await sandboxes.exec(sandboxId, 'cd /repo && tar --exclude=node_modules --exclude=.git -czf /tmp/radar-followup.tgz . && base64 -w0 /tmp/radar-followup.tgz', { timeoutMs: 120000 });
    if (archive.exitCode !== 0 || !archive.stdout.trim()) throw new Error('Followup archive failed');
    const bytes = Buffer.from(archive.stdout.trim(), 'base64');
    await writeFile(join(followupDirectory, 'app.tgz'), bytes); await writeFile(join(directory, 'app.tgz'), bytes);
    for (const epic of plan.tasks.filter(item => item.kind === 'epic')) await setStatus(epic.id, 'done');
    const reportPath = await integrator.writeReport();
    await exportEvidence();
    await append('run.done', { reportPath, followupTaskId: task.id, success: true });
    followup.status = 'completed'; record.status = 'completed';
  } catch (error) {
    followup.status = 'failed'; followup.failurePhase = phase; record.status = 'failed';
    const diagnostic = safeDiagnostic(error);
    followup.diagnostic = diagnostic;
    await writeFile(join(followupDirectory, 'failure.json'), JSON.stringify({ phase, attemptId, ...diagnostic }, null, 2)).catch(() => {});
    console.error(JSON.stringify({ phase, attemptId, ...diagnostic }));
    record.failure = `Post-delivery followup failed during ${phase}; inspect preserved evidence.`;
    await store.setTaskStatus(runId, task.id, 'blocked').catch(() => {});
    await publisher?.setStatus(runId, task.id, 'blocked').catch(() => {});
    const current = await store.currentAttempt(runId, task.id).catch(() => undefined);
    if (current?.attemptId === attemptId) await store.updateAttempt(runId, current.attemptId, { state: 'failed' }).catch(() => {});
    for (const epic of plan.tasks.filter(item => item.kind === 'epic')) {
      await store.setTaskStatus(runId, epic.id, 'blocked').catch(() => {});
      await publisher?.setStatus(runId, epic.id, 'blocked').catch(() => {});
    }
    await append('run.failed', { phase, followupTaskId: task.id, attemptId, diagnostic }).catch(() => {});
    if (integrator) await integrator.writeReport().catch(() => {});
    throw new Error(record.failure);
  } finally {
    if (sandboxId) await sandboxes.stop(sandboxId).catch(() => { console.warn('Followup sandbox stop failed; inspect recorded sandbox ID.'); });
    if (server) {
      const closed = new Promise<void>(resolveClose => server!.close(() => resolveClose()));
      (server as typeof server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await closed;
    }
    followup.endedAt = new Date().toISOString(); record.endedAt = followup.endedAt;
    await saveRecord();
    await writeFile(join(followupDirectory, 'followup.json'), JSON.stringify(followup, null, 2));
    await disk.write(`/spec/${runId}/followups/${followupScope}/followup.json`, JSON.stringify(followup, null, 2)).catch(error => {
      console.warn(JSON.stringify({ phase: 'exporting followup metadata', ...safeDiagnostic(error) }));
    });
    await exportEvidence().catch(() => { console.warn('Followup evidence export incomplete; rerun radar-export for this run.'); });
  }
  console.log(`Followup ${task.id} delivered for ${runId}; PR ${followup.prUrl}`);
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' }, task: { type: 'string' }, 'github-cli-auth': { type: 'boolean' }, retry: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Usage: node --import tsx scripts/radar-followup.ts --run ID --task TASK.json [--github-cli-auth] [--retry]\nRequires an already completed judges run. --retry permits one retry of the same failed TaskSpec; does not start a new run.'); return; }
  if (!values.run || !values.task) throw new Error('Pass --run and --task');
  try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (values['github-cli-auth']) {
    const env = { ...process.env }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    const credential = (await exec('gh', ['auth', 'token'], { env, encoding: 'utf8' })).stdout.trim();
    if (!credential) throw new Error('No stored GitHub CLI credential');
    process.env.GH_TOKEN = credential; process.env.GITHUB_TOKEN = credential; process.env.GITHUB_PUSH_TOKEN = credential;
    console.log('GitHub auth: existing CLI login (explicit override; no credential written)');
  }
  await executeFollowup(process.cwd(), values.run, values.task, { retry: values.retry });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ result: 'Followup failed', ...safeDiagnostic(error) })); process.exitCode = 1; });
}
