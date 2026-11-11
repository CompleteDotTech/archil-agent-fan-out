import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxProcessResult, SandboxProcessStartOptions } from "disk";
import { MemoryDisk } from "../../src/contracts/fakes.js";
import {
  createArchilSandboxRunner,
  type ArchilSandboxLike,
  type ArchilSdkLike,
} from "../../src/archil/sandbox.js";

const mounts = [{ disk: "shared", path: "/mnt/archil", conditional: true }];
const mounted = [{ diskId: "shared", path: "/mnt/archil", conditional: true }];
const success: SandboxProcessResult = { status: "completed", exitCode: 0, stdout: "abc123\n", stderr: "" };

function fixture() {
  const calls: string[] = [];
  const kill = vi.fn(async () => {});
  const wait = vi.fn(async (): Promise<SandboxProcessResult> => success);
  const boxes = new Map<string, ReturnType<typeof makeBox>>();
  function makeBox(id: string) {
    const box: ArchilSandboxLike = {
      id, status: "running", maxTtlSeconds: 1800, mounts: [...mounted],
      run: vi.fn(async (_command: string, _options?: SandboxProcessStartOptions) => ({ wait, kill })),
      refresh: vi.fn(async () => {}),
      setTimeout: vi.fn(async () => {}),
      fork: vi.fn(async () => {
        calls.push(`fork:${id}`);
        return makeBox(`fork-${boxes.size}`);
      }),
      stop: vi.fn(async () => { calls.push(`stop:${id}`); box.status = "stopped"; }),
      start: vi.fn(async () => { calls.push(`start:${id}`); box.status = "running"; }),
      delete: vi.fn(async () => { calls.push(`delete:${id}`); }),
    };
    boxes.set(id, box);
    return box;
  }
  const template = makeBox("template");
  const sdk: ArchilSdkLike = {
    sandboxes: {
      create: vi.fn(async () => template),
      get: vi.fn(async id => {
        const box = boxes.get(id);
        if (!box) throw new Error("Missing sandbox");
        return box;
      }),
    },
  };
  const log = vi.fn();
  const env = { GITHUB_PUSH_TOKEN: "test-only-credential", CODEX_API_KEY: "test-only-model-key" };
  const runner = createArchilSandboxRunner({
    sdk, log, env, region: "aws-us-west-2", diskId: "shared", vcpuCount: 2, memSizeMiB: 4096,
  });
  return { runner, sdk, template, boxes, makeBox, calls, wait, kill, log, env };
}

afterEach(() => vi.useRealTimers());

describe("Archil sandbox runner", () => {
  it("prepares a conditional-mounted template, installs, sets up, records HEAD, and stops", async () => {
    const f = fixture();
    await expect(f.runner.prepareTemplate({ runId: "r1", targetRepo: "owner/repo", setup: ["npm ci", "npm run build"] }))
      .resolves.toEqual({ templateId: "template", baseCommit: "abc123" });
    expect(f.sdk.sandboxes.create).toHaveBeenCalledWith({
      baseImage: "node:22-bookworm", vcpuCount: 2, memSizeMiB: 4096, env: f.env, mounts,
    });
    expect(f.template.setTimeout).toHaveBeenCalledWith({ timeoutSeconds: 86400, idleTtlSeconds: 0 });
    const commands = vi.mocked(f.template.run).mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      'git clone "https://x-access-token:$GITHUB_PUSH_TOKEN@github.com/owner/repo.git" /repo',
      "npm install -g @openai/codex", "cd /repo && npm ci", "cd /repo && npm run build", "git -C /repo rev-parse HEAD",
    ]);
    expect(commands.join("\n")).not.toContain(f.env.GITHUB_PUSH_TOKEN);
    expect(f.template.status).toBe("stopped");
    expect(f.log).not.toHaveBeenCalled();
  });

  it("honors a configured base image", async () => {
    const f = fixture();
    const runner = createArchilSandboxRunner({ sdk: f.sdk, env: {}, region: "aws-us-west-2", diskId: "shared", baseImage: "custom:tag" });
    await runner.prepareTemplate({ runId: "r", targetRepo: "a/b", setup: [] });
    expect(f.sdk.sandboxes.create).toHaveBeenCalledWith(expect.objectContaining({ baseImage: "custom:tag" }));
  });

  it("falls back to the plan timeout and logs no SDK error details", async () => {
    const f = fixture();
    vi.mocked(f.template.setTimeout).mockRejectedValueOnce(new Error(JSON.stringify(f.env)));
    await f.runner.prepareTemplate({ runId: "r", targetRepo: "a/b", setup: [] });
    expect(f.template.setTimeout).toHaveBeenLastCalledWith({ timeoutSeconds: 1800, idleTtlSeconds: 0 });
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("test-only");
  });

  it("continues when the service refuses both timeout updates", async () => {
    const f = fixture();
    vi.mocked(f.template.setTimeout).mockRejectedValue(new Error("refused"));
    await expect(f.runner.prepareTemplate({ runId: "r", targetRepo: "a/b", setup: [] })).resolves.toBeDefined();
    expect(f.log).toHaveBeenCalledTimes(2);
  });

  it("stops after a failed setup without leaking command output", async () => {
    const f = fixture();
    f.wait.mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, exitCode: 1, stderr: JSON.stringify(f.env) });
    await expect(f.runner.prepareTemplate({ runId: "r", targetRepo: "a/b", setup: [] }))
      .rejects.toThrow(/^Archil template preparation failed$/);
    expect(f.template.stop).toHaveBeenCalledOnce();
    expect(f.template.run).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid repositories before creating a sandbox", async () => {
    const f = fixture();
    await expect(f.runner.prepareTemplate({ runId: "r", targetRepo: 'a/b; echo bad', setup: [] })).rejects.toThrow("owner/name");
    expect(f.sdk.sandboxes.create).not.toHaveBeenCalled();
  });

  it("stops before sequential forks and repairs absent or unsafe mounts", async () => {
    const f = fixture();
    const first = f.makeBox("first");
    first.mounts = [];
    const second = f.makeBox("second");
    second.mounts = [{ ...mounted[0], conditional: false }];
    const third = f.makeBox("third");
    third.status = "stopped";
    let pending = false;
    const children = [first, second, third];
    vi.mocked(f.template.fork).mockImplementation(async () => {
      expect(f.template.status).toBe("stopped");
      expect(pending).toBe(false);
      pending = true;
      await Promise.resolve();
      pending = false;
      return children.shift()!;
    });
    await expect(f.runner.fork("template", 3)).resolves.toEqual(["first", "second", "third"]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.start).toHaveBeenCalledWith({ mounts });
    expect(second.start).toHaveBeenCalledWith({ mounts });
    expect(third.start).toHaveBeenCalledWith(undefined);
    expect(third.stop).not.toHaveBeenCalled();
  });

  it("keeps running forks with the correct mount and validates counts", async () => {
    const f = fixture();
    const child = f.makeBox("child");
    vi.mocked(f.template.fork).mockResolvedValue(child);
    await expect(f.runner.fork("template", 1)).resolves.toEqual(["child"]);
    expect(child.start).not.toHaveBeenCalled();
    expect(child.stop).not.toHaveBeenCalled();
    await expect(f.runner.fork("template", -1)).rejects.toThrow("count");
    await expect(f.runner.fork("template", 1.5)).rejects.toThrow("count");
  });

  it("cleans up an earlier child when the next fork fails and preserves the failure", async () => {
    const f = fixture();
    const first = f.makeBox("first");
    const failure = new Error("fork quota reached");
    vi.mocked(f.template.fork).mockResolvedValueOnce(first).mockRejectedValueOnce(failure);
    await expect(f.runner.fork("template", 2)).rejects.toBe(failure);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.delete).toHaveBeenCalledOnce();
    expect(first.status).toBe("stopped");
    expect(f.template.delete).not.toHaveBeenCalled();
  });

  it("includes the current child in cleanup if its mount repair start fails", async () => {
    const f = fixture();
    const first = f.makeBox("first");
    const current = f.makeBox("current");
    current.mounts = [];
    const failure = new Error("start failed");
    vi.mocked(current.start).mockRejectedValueOnce(failure);
    vi.mocked(f.template.fork).mockResolvedValueOnce(first).mockResolvedValueOnce(current);
    await expect(f.runner.fork("template", 2)).rejects.toBe(failure);
    expect(current.start).toHaveBeenCalledWith({ mounts });
    for (const child of [first, current]) {
      expect(child.stop).toHaveBeenCalled();
      expect(child.delete).toHaveBeenCalledOnce();
      expect(child.status).toBe("stopped");
    }
  });

  it("attempts every cleanup despite failures and leaves undeletable children safely stopped", async () => {
    const f = fixture();
    const first = f.makeBox("first");
    const second = f.makeBox("second");
    const failure = new Error("third fork failed");
    vi.mocked(first.stop).mockRejectedValueOnce(new Error("stop unavailable"));
    vi.mocked(second.delete).mockRejectedValueOnce(new Error("delete unavailable"));
    vi.mocked(f.template.fork).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValueOnce(failure);
    await expect(f.runner.fork("template", 3)).rejects.toBe(failure);
    expect(first.delete).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(second.status).toBe("stopped");
    expect(second.delete).toHaveBeenCalledOnce();
  });

  it("streams both output channels and returns nonzero exits as results", async () => {
    const f = fixture();
    const disk = new MemoryDisk();
    const output: string[] = [];
    vi.mocked(f.template.run).mockImplementation(async (_cmd, options) => {
      options?.onOutput?.({ stream: "stdout", offset: 0, data: Buffer.from("out") });
      options?.onOutput?.({ stream: "stderr", offset: 0, data: Buffer.from("err") });
      return { wait: async () => ({ ...success, exitCode: 7, stdout: "out", stderr: "err" }), kill: f.kill };
    });
    await expect(f.runner.exec("template", "check", { env: { EXTRA: "ok" }, onOutput: chunk => output.push(chunk), timeoutMs: 2500 }))
      .resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
    await disk.write("/runs/r/log", output.join(""));
    expect(await disk.read("/runs/r/log")).toBe("outerr");
    expect(f.template.run).toHaveBeenCalledWith("check", expect.objectContaining({ env: { ...f.env, EXTRA: "ok" }, timeoutSeconds: 3 }));
  });

  it("times out and kills the remote process even when wait never settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.wait.mockImplementation(() => new Promise(() => {}));
    const promise = f.runner.exec("template", "long", { timeoutMs: 50 });
    const rejected = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(f.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves UTF-8 characters split across streamed chunks", async () => {
    const f = fixture();
    const output: string[] = [];
    vi.mocked(f.template.run).mockImplementation(async (_cmd, options) => {
      const bytes = Buffer.from("✓");
      options?.onOutput?.({ stream: "stdout", offset: 0, data: bytes.subarray(0, 1) });
      options?.onOutput?.({ stream: "stdout", offset: 1, data: bytes.subarray(1) });
      return { wait: f.wait, kill: f.kill };
    });
    await f.runner.exec("template", "check", { onOutput: chunk => output.push(chunk) });
    expect(output.join("")).toBe("✓");
  });

  it("kills a process whose start finishes after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let started!: (value: { wait: typeof f.wait; kill: typeof f.kill }) => void;
    vi.mocked(f.template.run).mockImplementation(() => new Promise(resolve => { started = resolve; }));
    const rejected = expect(f.runner.exec("template", "long", { timeoutMs: 10 })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    started({ wait: f.wait, kill: f.kill });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.kill).toHaveBeenCalledOnce();
    expect(f.wait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects active commands on stop without waiting for the SDK process", async () => {
    const f = fixture();
    f.wait.mockImplementation(() => new Promise(() => {}));
    const command = f.runner.exec("template", "long");
    const rejected = expect(command).rejects.toThrow("stopped");
    await f.runner.stop("template");
    await rejected;
    expect(f.kill).toHaveBeenCalledOnce();
  });

  it("detects a sandbox stopped outside this runner", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.wait.mockImplementation(() => new Promise(() => {}));
    const command = f.runner.exec("template", "long");
    const rejected = expect(command).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(0);
    f.template.status = "stopped";
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(f.kill).toHaveBeenCalledOnce();
  });

  it.each(["timed_out", "cancelled"] as const)("rejects SDK terminal state %s", async status => {
    const f = fixture();
    f.wait.mockResolvedValue({ status, stdout: "", stderr: "" });
    await expect(f.runner.exec("template", "check")).rejects.toThrow(status === "timed_out" ? "timed out" : "interrupted");
  });

  it("rejects commands on stopped sandboxes and invalid deadlines", async () => {
    const f = fixture();
    f.template.status = "stopped";
    await expect(f.runner.exec("template", "check")).rejects.toThrow("not running");
    await expect(f.runner.exec("template", "check", { timeoutMs: 0 })).rejects.toThrow("positive finite");
    expect(f.template.run).not.toHaveBeenCalled();
  });

  it("passes lifecycle operations through and tolerates only already-running start errors", async () => {
    const f = fixture();
    vi.mocked(f.template.start).mockRejectedValueOnce(new Error("Sandbox already running"));
    await expect(f.runner.start("template")).resolves.toBeUndefined();
    vi.mocked(f.template.start).mockRejectedValueOnce(new Error("unauthorized"));
    await expect(f.runner.start("template")).rejects.toThrow("unauthorized");
    await f.runner.stop("template");
    await f.runner.remove("template");
    expect(f.calls).toEqual(["stop:template", "delete:template"]);
  });
});
