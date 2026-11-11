import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as planning from './planner/index.js';
import * as researchModule from './research/index.js';
import * as orchestration from './orchestrator/index.js';
import * as runtime from './archil/index.js';
import * as github from './github/index.js';
import * as sdk from 'disk';
import { createDashboard } from './dashboard/server.js';
import { serve } from '@hono/node-server';
import { FixturePlanner, FixtureResearch, MemoryDisk, MemoryStore, RecordingPublisher, LocalSandboxRunner } from './contracts/fakes.js';
import type { Plan, Store, SharedDisk, Publisher, SandboxRunner, Manifest, Attempt } from './contracts/types.js';

export interface ComposeOptions {
  brief: string;
  targetRepo: string;
  port: number;
  local: boolean;
  fakeAgent: boolean;
  fixturePlan: boolean;
  dryRun: boolean;
}

export async function compose(options: ComposeOptions): Promise<void> {
  try { process.loadEnvFile('.env'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const temporary = options.local ? await mkdtemp(join(tmpdir(), 'archil-swarm-')) : undefined;
  let store: Store;
  let disk: SharedDisk;
  let sandboxes: SandboxRunner;
  let publisher: Publisher;
  let localRemote: string | undefined;
  let localMerge: string | undefined;
  let dryRemote = false;
  let dryIntegrationId: string | undefined;
  const workerEnv: Record<string,string> = { AGENT: options.fakeAgent ? 'fake' : 'codex', PUSH: options.local ? '0' : '1', TARGET_REPO: options.targetRepo };
  if (temporary) {
    const localDisk = new LocalDisk(join(temporary, 'disk'));
    await mkdir(localDisk.root, { recursive: true });
    disk = localDisk;
    store = new MemoryStore();
    sandboxes = new LocalRunner(localDisk);
    localRemote = join(temporary, 'remote.git');
    localMerge = join(temporary, 'merge');
    await runFile('git', ['init', '--bare', '--initial-branch=main', localRemote]);
    publisher = new LocalPublisher(localRemote, localMerge);
  } else {
    const region = process.env.ARCHIL_REGION || 'aws-us-west-2';
    const diskId = process.env.ARCHIL_DISK_ID;
    if (!diskId || !process.env.ARCHIL_API_KEY) throw new Error('ARCHIL_DISK_ID and ARCHIL_API_KEY are required without --local');
    sdk.configure({ apiKey: process.env.ARCHIL_API_KEY, region });
    disk = runtime.createArchilDisk({ diskId, region, apiKey: process.env.ARCHIL_API_KEY });
    const archilDisk = await sdk.getDisk(diskId);
    store = runtime.createSqliteStore(await runtime.archilDb(archilDisk, 'swarm/state.sqlite'));
    for (const name of ['GITHUB_PUSH_TOKEN', 'CODEX_API_KEY'] as const) {
      const value = name === 'CODEX_API_KEY' ? process.env.OPENAI_API_KEY : process.env[name];
      if (value) workerEnv[name] = value;
    }
    sandboxes = runtime.createArchilSandboxRunner({region, diskId, env: workerEnv, sdk: new sdk.Archil({apiKey:process.env.ARCHIL_API_KEY,region})});
    const [owner, repo] = options.targetRepo.split('/');
    dryRemote = options.dryRun || !process.env.GITHUB_TOKEN;
    const client = github.createGitHubClient({owner, repo, token: process.env.GITHUB_TOKEN,
      dryRun: dryRemote});
    let project: {projectId:string;statusFieldId:string;statusOptionIds:Record<string,string>} | undefined;
    if (process.env.GITHUB_PROJECT_ID && process.env.GITHUB_STATUS_FIELD_ID) {
      const data = dryRemote ? {node:{options:['Backlog','Ready','Running','Review','Done','Blocked'].map(name => ({name,id:`dry-${name.toLowerCase()}`}))}}
        : await client.graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2SingleSelectField { options { id name } } } }`, {id:process.env.GITHUB_STATUS_FIELD_ID});
      const statusOptionIds = Object.fromEntries((data.node?.options ?? []).map((item: {id:string;name:string}) => [item.name.toLowerCase(),item.id]));
      if (!['backlog','ready','running','review','done','blocked'].every(status => statusOptionIds[status])) {
        throw new Error('GitHub Project Status field must have Backlog, Ready, Running, Review, Done, Blocked options');
      }
      project = {projectId:process.env.GITHUB_PROJECT_ID,statusFieldId:process.env.GITHUB_STATUS_FIELD_ID,statusOptionIds};
    }
    publisher = github.createPublisher({client, project, issueOf: async (run: string, task: string) => {
      const issue = (await store.getIssueNumbers(run))[task];
      if (issue === undefined) throw new Error(`No issue for ${task}`);
      return issue;
    }});
  }
  if (dryRemote) {
    const delegate = publisher;
    const branches = new Map<number,string>();
    publisher = {
      publishPlan: plan => delegate.publishPlan(plan),
      setStatus: (run, task, status) => delegate.setStatus(run, task, status),
      comment: (run, task, body) => delegate.comment(run, task, body),
      async openPullRequest(input) {
        const pr = await delegate.openPullRequest(input);
        branches.set(pr.number,input.branch);
        return pr;
      },
      async mergePullRequest(number) {
        if (dryIntegrationId) {
          const branch = branches.get(number);
          if (!branch) throw new Error(`Unknown dry-run PR ${number}`);
          const result = await sandboxes.exec(dryIntegrationId,
            `cd /repo && git fetch origin ${quote(branch)} && git cherry-pick FETCH_HEAD`, {timeoutMs:120000});
          if (result.exitCode !== 0) throw new Error('Dry-run integration merge failed');
        }
        return delegate.mergePullRequest(number);
      },
    };
  }
  await store.init();
  const research = options.local ? new FixtureResearch() : researchModule.createKeenableResearch({
    apiKey: process.env.KEENABLE_API_KEY, appTitle: 'Archil Agent Swarm',
  });
  let plan: Plan;
  const planInput = {runId, brief: options.brief, targetRepo: options.targetRepo};
  if (options.fixturePlan || options.local) plan = await new FixturePlanner().plan(planInput);
  else {
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
      plan = await planning.createPlanner({generate: planning.openAiGenerate({model: process.env.OPENAI_MODEL || 'gpt-5.1', apiKey: process.env.OPENAI_API_KEY})}).plan(planInput);
      const validation = planning.validatePlan(plan);
      if (!validation.ok) throw new Error(validation.errors.join('; '));
    } catch (error) {
      console.warn('Planner unavailable or invalid; using the fixture plan.');
      plan = await new FixturePlanner().plan(planInput);
    }
  }
  const sources = await planning.runResearch({plan, research, disk}) as Record<string, unknown[]>;
  await store.savePlan(plan);
  for (const [taskId, items] of Object.entries(sources)) {
    await store.appendEvent({runId,taskId,at:new Date().toISOString(),type:'research.done',
      data:{count:items.length,sourcesPath:`/research/${runId}/${taskId}/sources.md`}});
  }
  await store.appendEvent({runId, at: new Date().toISOString(), type:'run.started', data:{brief:options.brief}});
  const issues = await publisher.publishPlan(plan);
  for (const [id, number] of Object.entries(issues)) await store.setIssueNumber(runId, id, number);
  await store.appendEvent({runId, at:new Date().toISOString(),type:'plan.published',data:{issues}});
  await uploadTree(disk, 'fixtures/agent', '/swarm/fixtures/agent');
  await disk.write('/swarm/worker/run-task.sh', await readFile('src/worker/run-task.sh', 'utf8'));
  await disk.write(`/spec/${runId}/plan.json`, JSON.stringify(plan, null, 2));
  const architecture = plan.tasks.find(task => task.kind === 'task' && task.dependsOn.length === 0);
  if (!architecture) throw new Error('Plan has no architecture task');
  const attemptId = `${architecture.id}-a1`;
  const taskPath = `/runs/${runId}/${architecture.id}/${attemptId}`;
  await disk.write(`${taskPath}/task.json`, JSON.stringify(architecture));
  const setup: string[] = [];
  if (temporary) {
    setup.push(`cp -R ${quote(resolve('demo/target-seed'))}/. .`,
      `ln -s ${quote(resolve('node_modules'))} node_modules`,
      'git init --initial-branch=main', 'git config user.name "Swarm Local"', 'git config user.email "swarm@local.invalid"',
      'git add . && git commit -m "Seed demo"', `git remote add origin ${quote(localRemote!)}`, 'git push -u origin main');
  } else setup.push('npm install');
  const prepared = await sandboxes.prepareTemplate({runId, targetRepo:options.targetRepo, setup});
  const sandboxIds = new Set([prepared.templateId]);
  if (localRemote && localMerge) {
    await runFile('git', ['clone', localRemote, localMerge]);
    await runFile('git', ['config', 'user.name', 'Swarm Local'], {cwd:localMerge});
    await runFile('git', ['config', 'user.email', 'swarm@local.invalid'], {cwd:localMerge});
  }
  const gate = orchestration.createGate(sandboxes, {timeoutMs:120000});
  const recovery = orchestration.createRecovery({store, sandboxes, disk});
  const app = createDashboard({store}, {stopTask: (run: string, task: string) => recovery.requestStop(run,task)}, {projectUrl:process.env.GITHUB_PROJECT_URL});
  app.get('/delivery/:runId/report.md', async context => {
    if (context.req.param('runId') !== runId) return context.notFound();
    const report = await disk.read(`/delivery/${runId}/report.md`);
    return report === undefined ? context.notFound() : context.text(report);
  });
  const server = serve({fetch:app.fetch, port:options.port});
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  console.log(`Run ${runId} — dashboard http://localhost:${port}/?run=${runId}`);
  try {
    await sandboxes.start(prepared.templateId);
    const now = new Date();
    const attempt: Attempt = {runId,taskId:architecture.id,attemptId,n:1,sandboxId:prepared.templateId,
      resume:false,state:'running',startedAt:now.toISOString(),deadlineAt:new Date(now.getTime()+900000).toISOString()};
    await store.createAttempt(attempt);
    await store.setTaskStatus(runId, architecture.id, 'running');
    await publisher.setStatus(runId,architecture.id,'running');
    const emit = (type: string, data: Record<string,unknown>) => store.appendEvent({
      runId,taskId:architecture.id,attemptId,at:new Date().toISOString(),type,data,
    });
    await emit('task.status',{status:'running'});
    await emit('attempt.started',{attemptId,sandboxId:prepared.templateId,resume:false});
    await sandboxes.exec(prepared.templateId, 'bash /mnt/archil/swarm/worker/run-task.sh', {env:{...workerEnv,
      RUN_ID:runId,TASK_ID:architecture.id,ATTEMPT_ID:attemptId,BASE_COMMIT:prepared.baseCommit,RESUME:'0'},timeoutMs:900000,
      onOutput: (line: string) => { void emit('agent.log',{line}).catch(() => {}); }});
    const text = await disk.read(`${taskPath}/manifest.json`);
    if (!text) throw new Error('Architecture worker did not produce a manifest');
    const manifest = JSON.parse(text) as Manifest;
    if (manifest.attemptId !== attemptId) throw new Error('Stale architecture manifest');
    await store.saveManifest(manifest);
    const result = await gate.check({task:architecture,manifest,sandboxId:prepared.templateId});
    await emit('gate.result',{pass:result.pass,findings:result.findings});
    if (!result.pass) throw new Error(`Architecture gate failed: ${result.findings.join('; ')}`);
    const pr = await publisher.openPullRequest({runId,taskId:architecture.id,branch:manifest.branch,title:architecture.title,body:manifest.summary});
    await emit('pr.opened',{number:pr.number,url:pr.url});
    await store.setTaskStatus(runId,architecture.id,'review');
    await emit('task.status',{status:'review'});
    await publisher.mergePullRequest(pr.number);
    await emit('pr.merged',{number:pr.number});
    let workerBaseCommit = manifest.headCommit;
    if (!dryRemote && !options.local) {
      // GitHub squash-merges rewrite the architecture commit. Fork from the
      // published history so later task PRs share main's actual merge base.
      const refreshed = await sandboxes.exec(prepared.templateId,
        'cd /repo && git fetch origin main && git checkout -B main origin/main && git rev-parse HEAD',
        {timeoutMs:120000});
      if (refreshed.exitCode !== 0) throw new Error('Failed to refresh template after architecture merge');
      workerBaseCommit = refreshed.stdout.trim().split('\n').at(-1)!;
    }
    await store.updateAttempt(runId,attemptId,{state:'passed'});
    await store.setTaskStatus(runId,architecture.id,'done');
    await publisher.setStatus(runId,architecture.id,'done');
    await emit('task.status',{status:'done'});
    await sandboxes.stop(prepared.templateId);
    const [integrationId, ...pool] = await sandboxes.fork(prepared.templateId, 4);
    for (const id of [integrationId,...pool]) sandboxIds.add(id);
    dryIntegrationId = integrationId;
    const integrationRunner = dryRemote ? new Proxy(sandboxes, {
      get(target, property) {
        if (property === 'exec') return (id: string, command: string, opts?: Parameters<SandboxRunner['exec']>[2]) =>
          target.exec(id, command.includes('git checkout -B main origin/main') ? 'true' : command, opts);
        const value = Reflect.get(target,property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) : sandboxes;
    const finalVerify = ['npm run typecheck'];
    const integrator = orchestration.createIntegrator({publisher,store,sandboxes:integrationRunner,disk}, {
      runId,integrationSandboxId:integrationId,finalVerify,
    });
    const scheduler = orchestration.createScheduler({store,publisher,sandboxes,gate,disk,recovery,integrator}, {
      concurrency:3,attemptTimeoutMs:900000,baseCommit:workerBaseCommit,workerEnv,sandboxPool:pool,pollMs:50,
    });
    const outcome = await scheduler.runUntilDone(runId);
    await integrator.idle();
    // T1 deliberately installs red acceptance tests for not-yet-built sibling tasks.
    // Task gates and typecheck protect each merge; the full suite gates delivery.
    const finalCheck = await sandboxes.exec(integrationId, 'cd /repo && npm test', {timeoutMs:120000});
    await store.appendEvent({runId,at:new Date().toISOString(),type:'integration.result',
      data:{pass:finalCheck.exitCode === 0,final:true,output:finalCheck.stdout + finalCheck.stderr}});
    finalVerify.push('npm test');
    const success = outcome.blocked.length === 0 && finalCheck.exitCode === 0;
    for (const epic of plan.tasks.filter(task => task.kind === 'epic')) {
      await store.setTaskStatus(runId,epic.id,success ? 'done' : 'blocked');
      await publisher.setStatus(runId,epic.id,success ? 'done' : 'blocked');
      await store.appendEvent({runId,taskId:epic.id,at:new Date().toISOString(),type:'task.status',data:{status:success ? 'done' : 'blocked'}});
    }
    const reportPath = await integrator.writeReport();
    await store.appendEvent({runId,at:new Date().toISOString(),type:'run.done',data:{reportPath}});
    console.log(`Done: ${outcome.done.join(', ')}; blocked: ${outcome.blocked.join(', ') || 'none'}`);
    console.log(`Report: ${reportPath}`);
    if (temporary) {
      const localReport = resolve('.swarm','runs',runId,'report.md');
      await mkdir(dirname(localReport),{recursive:true});
      await writeFile(localReport,(await disk.read(reportPath)) ?? '');
      console.log(`Saved report: ${localReport}`);
    }
    console.log(`Final acceptance suite: ${finalCheck.exitCode === 0 ? 'PASS' : 'FAIL'}`);
    if (outcome.blocked.length) throw new Error('Run has blocked tasks');
    if (finalCheck.exitCode !== 0) throw new Error('Final acceptance suite failed');
  } finally {
    if (options.local) {
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await Promise.allSettled([...sandboxIds].map(id => sandboxes.remove(id)));
      if (temporary) await rm(temporary,{recursive:true,force:true});
    } else {
      await Promise.allSettled([...sandboxIds].map(id => sandboxes.stop(id)));
    }
  }
}

async function uploadTree(disk: SharedDisk, source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, {withFileTypes:true})) {
    const child = join(source, entry.name);
    const destination = `${target}/${entry.name}`;
    if (entry.isDirectory()) await uploadTree(disk,child,destination);
    else if (entry.isFile()) await disk.write(destination,await readFile(child,'utf8'));
  }
}

const runFile = promisify(execFile);
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** Mirror the in-memory fake onto a temporary shared mount for the real worker script. */
class LocalDisk extends MemoryDisk {
  constructor(readonly root: string) { super(); }
  path(path: string): string {
    const full = resolve(this.root, `.${path.startsWith('/') ? path : '/' + path}`);
    if (full !== this.root && !full.startsWith(this.root + '/')) throw new Error('Disk path escapes mount');
    return full;
  }
  override async write(path: string, data: string): Promise<void> {
    await super.write(path, data);
    await mkdir(dirname(this.path(path)), { recursive: true });
    await writeFile(this.path(path), data);
  }
  override async read(path: string): Promise<string | undefined> {
    try { return await readFile(this.path(path), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  override async list(prefix: string): Promise<string[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => '/' + join(entry.parentPath, entry.name).slice(this.root.length + 1)).filter(path => path.startsWith(prefix)).sort();
  }
}

/** Keep the production commands intact while translating their two absolute mount paths. */
class LocalRunner extends LocalSandboxRunner {
  constructor(readonly disk: LocalDisk) { super(); }
  override async exec(id: string, cmd: string, opts?: Parameters<SandboxRunner['exec']>[2]) {
    const repo = this.directory(id);
    const translated = cmd.replaceAll('/mnt/archil', this.disk.root).replaceAll('/repo', repo);
    const result = await super.exec(id, translated, { ...opts, env: { ...process.env, ...opts?.env, REPO_DIR: repo, DISK: this.disk.root } as Record<string,string> });
    if (result.exitCode === 0 && cmd.includes('/swarm/worker/run-task.sh')) {
      const pushed = await super.exec(id, 'git push origin HEAD', {timeoutMs:30000});
      if (pushed.exitCode !== 0) throw new Error(`Local branch push failed: ${pushed.stderr}`);
    }
    return result;
  }
}

class LocalPublisher extends RecordingPublisher {
  private branches = new Map<number,string>();
  constructor(private readonly remote: string, private readonly checkout: string) { super(); }
  override async openPullRequest(input: Parameters<Publisher['openPullRequest']>[0]) {
    const pr = await super.openPullRequest(input);
    this.branches.set(pr.number, input.branch);
    return pr;
  }
  override async mergePullRequest(number: number) {
    const branch = this.branches.get(number);
    if (!branch) throw new Error(`Unknown local PR ${number}`);
    await super.mergePullRequest(number);
    await runFile('git', ['fetch', this.remote, branch], { cwd: this.checkout });
    await runFile('git', ['cherry-pick', 'FETCH_HEAD'], { cwd: this.checkout });
    await runFile('git', ['push', this.remote, 'HEAD:main'], { cwd: this.checkout });
    const { stdout } = await runFile('git', ['rev-parse', 'HEAD'], { cwd: this.checkout });
    return { mergeCommit: stdout.trim() };
  }
}
