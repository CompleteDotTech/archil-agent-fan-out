import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importGitBundle } from '../../src/archil/bundle.js';
import { MemoryDisk } from '../../src/contracts/fakes.js';

async function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
    child.stdin?.end();
  });
}

describe('importGitBundle', () => {
  let root: string;
  let repoDir: string;
  let bundlePath: string;
  let headCommit: string;
  const branch = 'swarm/run/task/attempt';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bundle-import-'));
    const source = join(root, 'source');
    repoDir = join(root, 'clone');
    bundlePath = join(root, 'worker bundle.git');
    await mkdir(source);
    await git(source, 'init', '--initial-branch=main');
    await git(source, 'config', 'user.name', 'Bundle Test');
    await git(source, 'config', 'user.email', 'bundle@example.invalid');
    // Plumbing builds commits without checking out or committing in the task worktree.
    const tree = await git(source, 'mktree');
    const base = await git(source, 'commit-tree', tree, '-m', 'base');
    await git(source, 'update-ref', 'refs/heads/main', base);
    await git(root, 'clone', source, repoDir);
    headCommit = await git(source, 'commit-tree', tree, '-p', base, '-m', 'worker result');
    await git(source, 'update-ref', `refs/heads/${branch}`, headCommit);
    await git(source, 'bundle', 'create', bundlePath, `refs/heads/${branch}`, '^main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('imports a bundle handoff into the same local branch without pushing by default', async () => {
    const bare = join(root, 'unpublished.git');
    await git(root, 'init', '--bare', bare);
    await git(repoDir, 'remote', 'set-url', 'origin', bare);
    const disk = new MemoryDisk();
    await disk.write('/runs/run/task/attempt/bundle.json', JSON.stringify({ bundlePath, branch }));
    const handoff = JSON.parse((await disk.read('/runs/run/task/attempt/bundle.json'))!);
    expect(await importGitBundle({ repoDir, ...handoff })).toEqual({ headCommit, branch });
    expect(await git(repoDir, 'rev-parse', `refs/heads/${branch}`)).toBe(headCommit);
    expect(await git(repoDir, 'ls-remote', 'origin', `refs/heads/${branch}`))
      .toBe('');
  });

  it.each([undefined, 'delivery'])('optionally pushes to a bare remote (%s)', async remote => {
    const bare = join(root, 'remote.git');
    await git(root, 'init', '--bare', bare);
    if (remote) await git(repoDir, 'remote', 'add', remote, bare);
    else await git(repoDir, 'remote', 'set-url', 'origin', bare);
    expect(await importGitBundle({ repoDir, bundlePath, branch, push: true, remote }))
      .toEqual({ headCommit, branch });
    expect(await git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(headCommit);
  });

  it.each(['../bad', '--all', 'bad:ref', 'bad branch', '@{-1}'])('rejects invalid branch %s', async invalid => {
    await expect(importGitBundle({ repoDir, bundlePath, branch: invalid }))
      .rejects.toThrow('Invalid bundle branch.');
  });

  it('rejects missing files and directories', async () => {
    for (const path of [join(root, 'missing'), root]) {
      await expect(importGitBundle({ repoDir, bundlePath: path, branch }))
        .rejects.toThrow('Bundle file is missing or unreadable.');
    }
  });

  it('rejects malformed bundles', async () => {
    await writeFile(bundlePath, 'not a bundle');
    await expect(importGitBundle({ repoDir, bundlePath, branch }))
      .rejects.toThrow('Bundle verification failed.');
  });

  it('rejects bundles with prerequisites missing from the destination', async () => {
    const empty = join(root, 'empty');
    await git(root, 'init', '--bare', empty);
    await expect(importGitBundle({ repoDir: empty, bundlePath, branch }))
      .rejects.toThrow('Bundle verification failed.');
  });

  it('rejects a branch absent from the bundle', async () => {
    await expect(importGitBundle({ repoDir, bundlePath, branch: 'absent' }))
      .rejects.toThrow('Bundle branch import failed.');
  });

  it('sanitizes push failures without exposing remote contents', async () => {
    // A nonexistent local path tests sanitization without network access.
    const remote = join(root, 'https-token-secret@example.invalid');
    const error = await importGitBundle({ repoDir, bundlePath, branch, push: true, remote })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Bundle branch push failed.');
    expect(String(error)).not.toContain(remote);
    expect((error as Error).cause).toBeUndefined();
  });
});
