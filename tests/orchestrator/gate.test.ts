import { describe, expect, it, vi } from "vitest";
import { LocalSandboxRunner } from "../../src/contracts/fakes.js";
import type { Manifest, SandboxRunner, TaskSpec } from "../../src/contracts/types.js";
import { createGate } from "../../src/orchestrator/gate.js";
import { globToRegExp, matchesAny } from "../../src/orchestrator/globs.js";

class StubSandboxRunner extends LocalSandboxRunner {
  override exec = vi.fn<SandboxRunner["exec"]>().mockResolvedValue({
    exitCode: 0, stdout: "passed\n", stderr: "",
  });
}

const task: TaskSpec = {
  id: "T1", title: "Implement API", kind: "task", dependsOn: [],
  owns: ["src/api/**", "tests/api/*.test.ts"], acceptance: [],
  verify: ["npm run typecheck", "npm test"],
};
const manifest: Manifest = {
  runId: "run", taskId: "T1", attemptId: "T1-a1", baseCommit: "base",
  headCommit: "head", branch: "swarm/run/T1/T1-a1",
  changedFiles: ["src/api/index.ts", "src/api/nested/routes.ts", "tests/api/index.test.ts"],
  checks: [], summary: "Done", status: "complete",
};

describe("ownership globs", () => {
  it.each([
    ["src/**/index.ts", "src/index.ts", true],
    ["src/**/index.ts", "src/api/nested/index.ts", true],
    ["src/*.ts", "src/nested/index.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/?.ts", "src//.ts", false],
    ["src/[a]+(b).ts", "src/[a]+(b).ts", true],
    ["src/a.ts", "other/src/a.ts", false],
    ["src/a.ts", "src/aXts", false],
  ])("%s matches %s: %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it("matches any owned glob and rejects an empty ownership list", () => {
    expect(matchesAny("tests/api/index.test.ts", task.owns)).toBe(true);
    expect(matchesAny("src/api/index.ts", [])).toBe(false);
  });
});

describe("deterministic gate", () => {
  it("passes owned changes after independently rerunning every command", async () => {
    const sandboxes = new StubSandboxRunner();
    const result = await createGate(sandboxes, { timeoutMs: 1234 }).check({ task, manifest, sandboxId: "fork" });
    expect(result).toEqual({ pass: true, findings: [] });
    expect(sandboxes.exec.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ["fork", "cd /repo && npm run typecheck"], ["fork", "cd /repo && npm test"],
    ]);
    expect(sandboxes.exec.mock.calls[0]?.[2]?.timeoutMs).toBe(1234);
  });

  it("reports every unowned file while still running verification", async () => {
    const sandboxes = new StubSandboxRunner();
    const result = await createGate(sandboxes).check({
      task, manifest: { ...manifest, changedFiles: [...manifest.changedFiles, "package.json", "src/other.ts"] },
      sandboxId: "fork",
    });
    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.join("\n")).toContain("package.json");
    expect(result.findings.join("\n")).toContain("src/other.ts");
    expect(sandboxes.exec).toHaveBeenCalledTimes(2);
  });

  it("ignores claimed success, reports the command and last 40 output lines, and continues", async () => {
    const sandboxes = new StubSandboxRunner();
    sandboxes.exec.mockResolvedValueOnce({
      exitCode: 1, stdout: Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
      stderr: "error detail\n",
    });
    const result = await createGate(sandboxes).check({
      task, manifest: { ...manifest, checks: task.verify.map(cmd => ({ cmd, exitCode: 0 })) }, sandboxId: "fork",
    });
    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    const [header, ...lines] = result.findings[0]!.split("\n");
    expect(header).toContain("npm run typecheck");
    expect(header).toContain("(1)");
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 7");
    expect(lines.at(-1)).toBe("error detail");
    expect(sandboxes.exec).toHaveBeenCalledTimes(2);
  });

  it("rejects an incomplete manifest even when checks pass", async () => {
    const sandboxes = new StubSandboxRunner();
    const result = await createGate(sandboxes).check({ task, manifest: { ...manifest, status: "failed" }, sandboxId: "fork" });
    expect(result.pass).toBe(false);
    expect(result.findings[0]).toContain("expected complete");
    expect(sandboxes.exec).toHaveBeenCalledTimes(2);
  });

  it("turns execution errors into findings and runs remaining commands", async () => {
    const sandboxes = new StubSandboxRunner();
    sandboxes.exec.mockImplementationOnce(async (_id, _cmd, opts) => {
      opts?.onOutput?.("partial output\n");
      throw new Error("Timed out");
    });
    const result = await createGate(sandboxes).check({ task, manifest, sandboxId: "fork" });
    expect(result.pass).toBe(false);
    expect(result.findings[0]).toContain("npm run typecheck");
    expect(result.findings[0]).toContain("Timed out");
    expect(result.findings[0]).toContain("partial output");
    expect(sandboxes.exec).toHaveBeenCalledTimes(2);
  });
});
