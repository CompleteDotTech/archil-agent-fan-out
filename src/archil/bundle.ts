import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[], failure: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repoDir });
    return stdout.trim();
  } catch {
    // Git's error, command line and stderr may contain authenticated remote URLs.
    throw new Error(failure);
  }
}

/** Import a worker's bundle in the orchestrator's repository; pushing is opt-in. */
export async function importGitBundle(opts: {
  repoDir: string;
  bundlePath: string;
  branch: string;
  remote?: string;
  push?: boolean;
}): Promise<{ headCommit: string; branch: string }> {
  const { repoDir, branch } = opts;
  const checkedBranch = await git(
    repoDir, ['check-ref-format', '--branch', branch], 'Invalid bundle branch.',
  );
  // Reject shorthand such as @{-1}; only accept the exact supplied branch.
  if (checkedBranch !== branch) throw new Error('Invalid bundle branch.');

  const bundlePath = resolve(opts.bundlePath);
  try {
    if (!(await stat(bundlePath)).isFile()) throw new Error();
  } catch {
    throw new Error('Bundle file is missing or unreadable.');
  }
  await git(repoDir, ['bundle', 'verify', '--', bundlePath], 'Bundle verification failed.');
  const ref = `refs/heads/${branch}`;
  await git(repoDir, ['fetch', '--', bundlePath, `${ref}:${ref}`], 'Bundle branch import failed.');
  const headCommit = await git(
    repoDir, ['rev-parse', '--verify', `${ref}^{commit}`], 'Imported branch resolution failed.',
  );
  if (opts.push === true) {
    await git(repoDir, ['push', '--', opts.remote ?? 'origin', `${ref}:${ref}`], 'Bundle branch push failed.');
  }
  return { headCommit, branch };
}
