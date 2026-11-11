import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDisk } from '../../src/contracts/fakes.js';
import type { Manifest, TaskSpec } from '../../src/contracts/types.js';

const script = fileURLToPath(new URL('../../src/worker/run-task.sh', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(verify: string[] = ['node -e "process.exit(0)"']) {
  const root = await mkdtemp(path.join(tmpdir(), 'swarm worker '));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const disk = path.join(root, 'disk');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Worker Test');
  git('config', 'user.email', 'worker@example.invalid');
  await writeFile(path.join(repo, 'seed.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'seed');
  const baseCommit = git('rev-parse', 'HEAD');
  const task: TaskSpec & { findings: string[] } = {
    id: 'T1', title: 'Implement fixture', kind: 'task', dependsOn: [],
    owns: ['result.txt'], acceptance: ['Result exists'], verify,
    prompt: 'Keep the fixture text.', findings: ['Previous check needs attention'],
  };
  const attemptPath = '/runs/run-1/T1/T1-a1';
  const memory = new MemoryDisk();
  await memory.write(`${attemptPath}/task.json`, JSON.stringify(task));
  await memory.write('/swarm/fixtures/agent/T1/result.txt', 'fixture result\n');
  await memory.write('/research/run-1/T1/sources.md', '# Sources\n');
  for (const file of await memory.list('/')) {
    const target = path.join(disk, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, (await memory.read(file))!);
  }
  const dir = path.join(disk, attemptPath);
  const env = {
    ...process.env, RUN_ID: 'run-1', TASK_ID: 'T1', ATTEMPT_ID: 'T1-a1',
    BASE_COMMIT: baseCommit, AGENT: 'fake', PUSH: '0', RESUME: '0', REPO_DIR: repo, DISK: disk,
  };
  const run = (overrides: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script], { env: { ...env, ...overrides }, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  const manifest = async () => JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  return { root, repo, disk, dir, baseCommit, task, git, run, manifest };
}

async function stubCodex(root: string) {
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
console.error('agent diagnostic');
process.exit(Number(process.env.TEST_AGENT_EXIT || 0));
`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

describe('sandbox worker', { timeout: 20_000 }, () => {
  it('copies the fixture, commits on the attempt branch, and writes a contract manifest', async () => {
    const ctx = await setup();
    ctx.run();
    const manifest = await ctx.manifest();
    expect(manifest).toEqual({
      runId: 'run-1', taskId: 'T1', attemptId: 'T1-a1', baseCommit: ctx.baseCommit,
      headCommit: ctx.git('rev-parse', 'HEAD'), branch: 'swarm/run-1/T1/T1-a1',
      changedFiles: ['result.txt'], status: 'complete',
      summary: 'Applied fake agent fixture for T1.\n',
      checks: [{ cmd: ctx.task.verify[0], exitCode: 0, logPath: path.join(ctx.dir, 'verify.log') }],
    });
    expect(ctx.git('branch', '--show-current')).toBe(manifest.branch);
    expect(ctx.git('log', '-1', '--format=%s')).toBe('T1 (T1-a1)');
    expect(ctx.git('status', '--porcelain')).toBe('');
    expect(await readFile(path.join(ctx.repo, 'result.txt'), 'utf8')).toBe('fixture result\n');
    expect(await readFile(path.join(ctx.dir, 'verify.log'), 'utf8')).toContain('Exit code: 0');
  });

  it('records failed checks and still runs subsequent verification commands', async () => {
    const ctx = await setup(['node -e "console.error(\'bad check\'); process.exit(7)"', 'node -e "console.log(\'next check\')"']);
    ctx.run();
    expect((await ctx.manifest()).checks.map(check => check.exitCode)).toEqual([7, 0]);
    expect((await ctx.manifest()).status).toBe('complete');
    const log = await readFile(path.join(ctx.dir, 'verify.log'), 'utf8');
    expect(log).toContain('bad check');
    expect(log).toContain('next check');
  });

  it('commits with explicit identity in a fresh sandbox without Git configuration', async () => {
    const ctx = await setup();
    ctx.git('config', '--unset', 'user.name');
    ctx.git('config', '--unset', 'user.email');
    const home = path.join(ctx.root, 'home');
    await mkdir(home);
    const globalConfig = path.join(home, '.gitconfig');
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('GIT_') && key !== 'EMAIL'));
    Object.assign(env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
      RUN_ID: 'run-1', TASK_ID: 'T1', ATTEMPT_ID: 'T1-a1',
      BASE_COMMIT: ctx.baseCommit, AGENT: 'fake', PUSH: '0', RESUME: '0',
      REPO_DIR: ctx.repo, DISK: ctx.disk,
    });
    const result = spawnSync('bash', [script], { env, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const manifest = await ctx.manifest();
    expect(manifest.status).toBe('complete');
    expect(manifest.changedFiles).toEqual(['result.txt']);
    expect(manifest.headCommit).not.toBe(ctx.baseCommit);
    expect(ctx.git('show', '-s', '--format=%an <%ae>|%cn <%ce>', manifest.headCommit))
      .toBe('Archil Swarm <swarm@localhost>|Archil Swarm <swarm@localhost>');
    const localConfig = ctx.git('config', '--local', '--list');
    expect(localConfig).not.toMatch(/user\.(name|email)=/);
    await expect(readFile(globalConfig, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes task context to Codex and records agent failure independently of verification', async () => {
    const ctx = await setup();
    const output = ctx.run({ AGENT: 'codex', PATH: await stubCodex(ctx.root), TEST_AGENT_EXIT: '3' });
    expect(output.stdout).toContain('dangerously-bypass-approvals-and-sandbox');
    expect(output.stderr).toContain('agent diagnostic');
    const args = JSON.parse(await readFile(path.join(ctx.dir, 'final.md'), 'utf8')) as string[];
    expect(args.slice(0, 2)).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox']);
    for (const text of [ctx.task.title, ctx.task.prompt!, 'Acceptance:', 'Result exists', 'OWNS:', 'result.txt', 'VERIFY:', ctx.task.verify[0]!, 'Previous check needs attention', `Research notes:\n${ctx.disk}/research/run-1/T1/sources.md`, 'Never edit package.json or the lockfile.', 'Do not commit.']) {
      expect(args[2]).toContain(text);
    }
    const manifest = await ctx.manifest();
    expect(manifest.status).toBe('failed');
    expect(manifest.changedFiles).toEqual([]);
    expect(manifest.summary).toBe((await readFile(path.join(ctx.dir, 'final.md'), 'utf8')).slice(0, 500));
    expect(await readFile(path.join(ctx.dir, 'agent.log'), 'utf8')).toContain('agent diagnostic');
  });

  it('resumes the last Codex session while preserving uncommitted work', async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.repo, 'seed.txt'), 'interrupted work\n');
    await writeFile(path.join(ctx.repo, 'pending.txt'), 'new work\n');
    ctx.run({ AGENT: 'codex', RESUME: '1', PATH: await stubCodex(ctx.root) });
    const args = JSON.parse(await readFile(path.join(ctx.dir, 'final.md'), 'utf8')) as string[];
    expect(args).toEqual(['exec', 'resume', '--last', '--dangerously-bypass-approvals-and-sandbox', 'You were interrupted. Check git status and the task above, then finish it.']);
    expect((await ctx.manifest()).changedFiles).toEqual(['pending.txt', 'seed.txt']);
    expect(await readFile(path.join(ctx.repo, 'seed.txt'), 'utf8')).toBe('interrupted work\n');
  });
});
