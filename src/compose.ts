import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const load = (name: string): Promise<any> => import(name);
  const [planning, researchModule, orchestration, dashboard, { serve }] = await Promise.all([
    load('./planner/index.js'), load('./research/index.js'), load('./orchestrator/index.js'),
    load('./dashboard/server.js'), import('@hono/node-server'),
  ]);
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const temporary = options.local ? await mkdtemp(join(tmpdir(), 'archil-swarm-')) : undefined;
  let store: Store;
  let disk: SharedDisk;
  let sandboxes: SandboxRunner;
  let publisher: Publisher;
  let localRemote: string | undefined;
  let localMerge: string | undefined;
  const workerEnv: Record<string,string> = { AGENT: options.fakeAgent ? 'fake' : 'codex', PUSH: '1', TARGET_REPO: options.targetRepo };
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
    const runtime = await load('./archil/index.js');
    const github = await load('./github/index.js');
    const sdk = await import('disk');
    const region = process.env.ARCHIL_REGION || 'aws-us-west-2';
    const diskId = process.env.ARCHIL_DISK_ID;
    if (!diskId || !process.env.ARCHIL_API_KEY) throw new Error('ARCHIL_DISK_ID and ARCHIL_API_KEY are required without --local');
    disk = runtime.createArchilDisk({ diskId, region });
    const archilDisk = await (sdk as any).getDisk(diskId);
    store = runtime.createSqliteStore(await runtime.archilDb(archilDisk, 'swarm/state.sqlite'));
    for (const name of ['GITHUB_PUSH_TOKEN', 'CODEX_API_KEY'] as const) {
      const value = name === 'CODEX_API_KEY' ? process.env.OPENAI_API_KEY : process.env[name];
      if (value) workerEnv[name] = value;
    }
    sandboxes = runtime.createArchilSandboxRunner({region, diskId, env: workerEnv});
    const [owner, repo] = options.targetRepo.split('/');
    const client = github.createGitHubClient({owner, repo, token: process.env.GITHUB_TOKEN,
      dryRun: options.dryRun || !process.env.GITHUB_TOKEN});
    publisher = github.createPublisher({client, issueOf: async (run: string, task: string) => {
      const issue = (await store.getIssueNumbers(run))[task];
      if (issue === undefined) throw new Error(`No issue for ${task}`);
      return issue;
    }});
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
      const { openAiGenerate } = await load('./planner/planner.js');
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
      plan = await planning.createPlanner({generate: openAiGenerate({model: 'gpt-5.1', apiKey: process.env.OPENAI_API_KEY})}).plan(planInput);
      const validation = planning.validatePlan(plan);
      if (!validation.ok) throw new Error(validation.errors.join('; '));
    } catch (error) {
      console.warn('Planner unavailable or invalid; using the fixture plan.');
      plan = await new FixturePlanner().plan(planInput);
    }
  }
  await planning.runResearch({plan, research, disk});
  await store.savePlan(plan);
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
  const gate = orchestration.createGate(sandboxes);
  const recovery = orchestration.createRecovery({store, sandboxes, disk});
  const app = dashboard.createDashboard({store}, {stopTask: (run: string, task: string) => recovery.requestStop(run,task)});
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
    await sandboxes.exec(prepared.templateId, 'bash /mnt/archil/swarm/worker/run-task.sh', {env:{...workerEnv,
      RUN_ID:runId,TASK_ID:architecture.id,ATTEMPT_ID:attemptId,BASE_COMMIT:prepared.baseCommit,RESUME:'0'},timeoutMs:900000});
    const text = await disk.read(`${taskPath}/manifest.json`);
    if (!text) throw new Error('Architecture worker did not produce a manifest');
    const manifest = JSON.parse(text) as Manifest;
    if (manifest.attemptId !== attemptId) throw new Error('Stale architecture manifest');
    await store.saveManifest(manifest);
    const result = await gate.check({task:architecture,manifest,sandboxId:prepared.templateId});
    if (!result.pass) throw new Error(`Architecture gate failed: ${result.findings.join('; ')}`);
    const pr = await publisher.openPullRequest({runId,taskId:architecture.id,branch:manifest.branch,title:architecture.title,body:manifest.summary});
    await publisher.mergePullRequest(pr.number);
    await store.updateAttempt(runId,attemptId,{state:'passed'});
    await store.setTaskStatus(runId,architecture.id,'done');
    await publisher.setStatus(runId,architecture.id,'done');
    await sandboxes.stop(prepared.templateId);
    const [integrationId, ...pool] = await sandboxes.fork(prepared.templateId, 4);
    for (const id of [integrationId,...pool]) sandboxIds.add(id);
    const integrator = orchestration.createIntegrator({publisher,store,sandboxes,disk}, {
      runId,integrationSandboxId:integrationId,finalVerify:['npm test'],
    });
    const scheduler = orchestration.createScheduler({store,publisher,sandboxes,gate,disk,recovery,integrator}, {
      concurrency:3,attemptTimeoutMs:900000,baseCommit:manifest.headCommit,workerEnv,sandboxPool:pool,pollMs:50,
    });
    const outcome = await scheduler.runUntilDone(runId);
    await integrator.idle();
    const reportPath = await integrator.writeReport();
    await store.appendEvent({runId,at:new Date().toISOString(),type:'run.done',data:{reportPath}});
    console.log(`Done: ${outcome.done.join(', ')}; blocked: ${outcome.blocked.join(', ') || 'none'}`);
    console.log(`Report: ${reportPath}`);
    if (temporary) console.log(await disk.read(reportPath));
    if (outcome.blocked.length) throw new Error('Run has blocked tasks');
  } finally {
    if (options.local) {
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await Promise.allSettled([...sandboxIds].map(id => sandboxes.remove(id)));
      if (temporary) await rm(temporary,{recursive:true,force:true});
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
  override exec(id: string, cmd: string, opts?: Parameters<SandboxRunner['exec']>[2]) {
    const repo = this.directory(id);
    const translated = cmd.replaceAll('/mnt/archil', this.disk.root).replaceAll('/repo', repo);
    return super.exec(id, translated, { ...opts, env: { ...process.env, ...opts?.env, REPO_DIR: repo, DISK: this.disk.root } as Record<string,string> });
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
