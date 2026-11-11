import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxRunner } from "../types.js";

type Running = { cancel: (reason: string) => void };
type Sandbox = { directory: string; stopped: boolean; running: Set<Running> };

/** A filesystem-and-process fake; commands are real local shell commands. */
export class LocalSandboxRunner implements SandboxRunner {
  private readonly sandboxes = new Map<string, Sandbox>();
  private nextId = 1;

  directory(sandboxId: string): string {
    return this.lookup(sandboxId).directory;
  }

  getDirectory(sandboxId: string): string {
    return this.directory(sandboxId);
  }

  private lookup(id: string): Sandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`Unknown sandbox: ${id}`);
    return sandbox;
  }

  private async create(): Promise<string> {
    const id = `local-${this.nextId++}`;
    const directory = await mkdtemp(join(tmpdir(), "swarm-sandbox-"));
    this.sandboxes.set(id, { directory, stopped: false, running: new Set() });
    return id;
  }

  async prepareTemplate(input: {
    runId: string; targetRepo: string; setup: string[];
  }): Promise<{ templateId: string; baseCommit: string }> {
    const templateId = await this.create();
    try {
      for (const command of input.setup) {
        const result = await this.exec(templateId, command);
        if (result.exitCode !== 0) throw new Error(`Template setup failed (${result.exitCode}): ${result.stderr}`);
      }
      const head = await this.exec(templateId, "git rev-parse HEAD 2>/dev/null");
      await this.stop(templateId);
      return { templateId, baseCommit: head.exitCode === 0 ? head.stdout.trim() : "local-base" };
    } catch (error) {
      await this.remove(templateId);
      throw error;
    }
  }

  async fork(templateId: string, count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count < 0) throw new Error("Fork count must be a non-negative integer");
    const template = this.lookup(templateId);
    const ids: string[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const id = await this.create();
        ids.push(id);
        await cp(template.directory, this.directory(id), { recursive: true, force: true });
      }
      return ids;
    } catch (error) {
      await Promise.all(ids.map(id => this.remove(id)));
      throw error;
    }
  }

  async exec(sandboxId: string, cmd: string, opts?: {
    env?: Record<string, string>; onOutput?: (chunk: string) => void; timeoutMs?: number;
  }): Promise<ExecResult> {
    const sandbox = this.lookup(sandboxId);
    if (sandbox.stopped) throw new Error(`Sandbox stopped: ${sandboxId}`);
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("bash", ["-lc", cmd], {
        cwd: sandbox.directory, env: opts?.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, exitCode = 0) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        sandbox.running.delete(running);
        if (error) reject(error);
        else resolve({ exitCode, stdout, stderr });
      };
      const running: Running = { cancel: reason => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        finish(new Error(reason));
      } };
      sandbox.running.add(running);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); opts?.onOutput?.(chunk.toString()); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); opts?.onOutput?.(chunk.toString()); });
      child.on("error", error => finish(error));
      child.on("close", (code, signal) => finish(undefined, code ?? (signal ? 128 : 1)));
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => running.cancel(`Sandbox execution timed out: ${sandboxId}`), opts.timeoutMs);
      }
    });
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = this.lookup(sandboxId);
    sandbox.stopped = true;
    for (const running of [...sandbox.running]) running.cancel(`Sandbox stopped: ${sandboxId}`);
  }

  async start(sandboxId: string): Promise<void> {
    this.lookup(sandboxId).stopped = false;
  }

  async remove(sandboxId: string): Promise<void> {
    const sandbox = this.lookup(sandboxId);
    await this.stop(sandboxId);
    await rm(sandbox.directory, { recursive: true, force: true });
    this.sandboxes.delete(sandboxId);
  }
}
