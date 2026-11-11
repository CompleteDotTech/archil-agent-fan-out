import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LocalSandboxRunner } from "../../src/contracts/fakes.js";

const script = resolve("src/worker/bundle.sh");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("offline git bundle handoff", () => {
  let runner: LocalSandboxRunner;
  let sandbox: string;
  let root: string;
  let repo: string;
  let base: string;
  let head: string;
  let output: string;

  async function command(args: string[], cwd?: string) {
    return runner.exec(sandbox, `${cwd ? `cd ${quote(cwd)} && ` : ""}${args.map(quote).join(" ")}`);
  }

  async function git(...args: string[]) {
    const result = await command(["git", "-C", repo, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  async function bundle(baseArg = base, branch = "swarm/task", path = output) {
    return command(["bash", script, repo, baseArg, branch, path]);
  }

  beforeEach(async () => {
    runner = new LocalSandboxRunner();
    ({ templateId: sandbox } = await runner.prepareTemplate({ runId: "bundle", targetRepo: "local/test", setup: [] }));
    await runner.start(sandbox);
    root = runner.directory(sandbox);
    repo = join(root, "source repo");
    output = join(root, "delivery with spaces", "attempt.bundle");
    await mkdir(repo);
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Bundle Test");
    await git("config", "user.email", "bundle@example.invalid");
    await writeFile(join(repo, "base.txt"), "base\n");
    await git("add", "base.txt");
    const baseTree = await git("write-tree");
    base = await git("commit-tree", baseTree, "-m", "base");
    await git("update-ref", "refs/heads/main", base);
    // Clone before creating the task history, so the recipient only has base.
    const cloned = await command(["git", "clone", "--local", repo, join(root, "recipient")]);
    expect(cloned.exitCode, cloned.stderr).toBe(0);
    await writeFile(join(repo, "task.txt"), "task result\n");
    await git("add", "task.txt");
    const taskTree = await git("write-tree");
    const first = await git("commit-tree", taskTree, "-p", base, "-m", "task first");
    head = await git("commit-tree", taskTree, "-p", first, "-m", "task second");
    await git("update-ref", "refs/heads/swarm/task", head);
  });

  afterEach(async () => { await runner.remove(sandbox); });

  it.each(["swarm/task", "refs/heads/swarm/task"])("verifies and imports incremental history using %s", async branch => {
    const result = await bundle(base, branch);
    expect(result.exitCode, result.stderr).toBe(0);
    const recipient = join(root, "recipient");
    const verified = await command(["git", "-C", recipient, "bundle", "verify", output]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(verified.stdout + verified.stderr).toContain(base);
    const imported = await command(["git", "-C", recipient, "fetch", output, "refs/heads/swarm/task:refs/heads/imported"]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    const received = await command(["git", "-C", recipient, "rev-parse", "imported"]);
    expect(received.stdout.trim()).toBe(head);
    const history = await command(["git", "-C", recipient, "rev-list", "--count", `${base}..imported`]);
    expect(history.stdout.trim()).toBe("2");
    const content = await command(["git", "-C", recipient, "show", "imported:task.txt"]);
    expect(content.stdout).toBe("task result\n");
    expect(await readdir(join(root, "delivery with spaces"))).toEqual(["attempt.bundle"]);
  });

  it("bundles full reachable history when branch has no changes", async () => {
    expect((await bundle(base, "main")).exitCode).toBe(0);
    const empty = join(root, "empty");
    expect((await command(["git", "init", "--bare", empty])).exitCode).toBe(0);
    const imported = await command(["git", "-C", empty, "fetch", output, "refs/heads/main:refs/heads/imported"]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect((await command(["git", "-C", empty, "rev-parse", "imported"])).stdout.trim()).toBe(base);
  });

  it.each([
    ["not-a-commit", "swarm/task", "base does not resolve"],
    ["--all", "swarm/task", "base does not resolve"],
    ["BASE", "missing", "branch does not resolve"],
    ["BASE", "refs/tags/task", "local branch"],
    ["BASE", "swarm/../task", "invalid branch name"],
  ])("rejects invalid input %s / %s without replacing output", async (baseArg, branch, error) => {
    await mkdir(join(root, "delivery with spaces"));
    await writeFile(output, "existing output");
    const result = await bundle(baseArg === "BASE" ? base : baseArg, branch);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(await readFile(output, "utf8")).toBe("existing output");
    expect(await readdir(join(root, "delivery with spaces"))).toEqual(["attempt.bundle"]);
  });

  it("rejects a base outside the branch ancestry", async () => {
    const tree = await git("write-tree");
    const unrelated = await git("commit-tree", tree, "-m", "unrelated root");
    const result = await bundle(unrelated);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ancestor");
    await expect(access(output)).rejects.toThrow();
  });

  it("replaces an existing output and resolves relative paths from the caller", async () => {
    await mkdir(join(root, "delivery"));
    await writeFile(join(root, "delivery", "result.bundle"), "old result");
    const result = await bundle(base, "swarm/task", "delivery/result.bundle");
    expect(result.exitCode, result.stderr).toBe(0);
    const verified = await command(["git", "-C", repo, "bundle", "verify", join(root, "delivery", "result.bundle")]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(await readdir(join(root, "delivery"))).toEqual(["result.bundle"]);
  });
});
