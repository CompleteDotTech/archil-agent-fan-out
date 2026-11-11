import { StringDecoder } from "node:string_decoder";
import {
  Archil,
  type CreateSandboxRequest,
  type SandboxMount,
  type SandboxProcessResult,
  type SandboxProcessStartOptions,
  type SandboxStartOptions,
  type SandboxTimeoutOptions,
} from "disk";
import type { ExecResult, SandboxRunner } from "../contracts/types.js";

export interface ArchilProcessLike {
  wait(): Promise<SandboxProcessResult>;
  kill(): Promise<void>;
}

/** Only the SDK surface this adapter uses; no live service is needed in tests. */
export interface ArchilSandboxLike {
  id: string;
  status: string;
  maxTtlSeconds: number;
  mounts: Pick<SandboxMount, "diskId" | "path" | "conditional">[];
  run(command: string, options?: SandboxProcessStartOptions): Promise<ArchilProcessLike>;
  refresh(): Promise<unknown>;
  setTimeout(options: SandboxTimeoutOptions): Promise<unknown>;
  fork(): Promise<ArchilSandboxLike>;
  stop(): Promise<unknown>;
  start(options?: SandboxStartOptions): Promise<unknown>;
  delete(): Promise<void>;
}

export interface ArchilSdkLike {
  sandboxes: {
    create(request: CreateSandboxRequest): Promise<ArchilSandboxLike>;
    get(id: string): Promise<ArchilSandboxLike>;
  };
}

export interface ArchilSandboxRunnerOptions {
  region: string;
  diskId: string;
  baseImage?: string;
  vcpuCount?: number;
  memSizeMiB?: number;
  env: Record<string, string>;
  sdk?: ArchilSdkLike;
  log?: (message: string) => void;
}

function isRunning(status: string): boolean {
  return status === "running";
}

function alreadyRunning(error: unknown): boolean {
  return error instanceof Error && /already[ _-]running/i.test(error.message);
}

export function createArchilSandboxRunner(options: ArchilSandboxRunnerOptions): SandboxRunner {
  // Credentials come from composition, never from process.env in this module.
  const sdk: ArchilSdkLike = options.sdk ?? new Archil({
    apiKey: options.env.ARCHIL_API_KEY,
    region: options.region,
  });
  const mounts = [{ disk: options.diskId, path: "/mnt/archil", conditional: true }];
  const active = new Map<string, Set<(reason: string) => void>>();
  const log = options.log ?? ((message: string) => console.warn(message));

  async function configureTimeout(sandbox: ArchilSandboxLike): Promise<void> {
    // Request a full day; plans with shorter limits keep their accepted lifetime.
    try {
      await sandbox.setTimeout({ timeoutSeconds: Math.max(86_400, sandbox.maxTtlSeconds), idleTtlSeconds: 0 });
    } catch {
      log("Archil refused the extended sandbox timeout; retaining the plan limit.");
      try {
        await sandbox.setTimeout({ timeoutSeconds: sandbox.maxTtlSeconds, idleTtlSeconds: 0 });
      } catch {
        log("Archil refused the timeout update; retaining its existing timeout settings.");
      }
    }
  }

  function interrupt(id: string): void {
    for (const cancel of active.get(id) ?? []) cancel("Sandbox stopped during execution");
  }

  async function startSandbox(sandbox: ArchilSandboxLike, repairMounts = false): Promise<void> {
    try {
      await sandbox.start(repairMounts ? { mounts } : undefined);
    } catch (error) {
      if (!alreadyRunning(error)) throw error;
    }
  }

  const runner: SandboxRunner = {
    async prepareTemplate(input) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.targetRepo)) {
        throw new Error("Target repository must be owner/name");
      }
      const sandbox = await sdk.sandboxes.create({
        baseImage: options.baseImage ?? "node:22-bookworm",
        vcpuCount: options.vcpuCount,
        memSizeMiB: options.memSizeMiB,
        env: { ...options.env },
        mounts,
      });
      try {
        await configureTimeout(sandbox);
        const commands = [
          // Expansion happens only in the guest; neither a token nor this URL is logged.
          `git clone "https://x-access-token:$GITHUB_PUSH_TOKEN@github.com/${input.targetRepo}.git" /repo`,
          "npm install -g @openai/codex",
          ...input.setup.map(command => `cd /repo && ${command}`),
          "git -C /repo rev-parse HEAD",
        ];
        let result: ExecResult | undefined;
        for (const command of commands) {
          result = await runner.exec(sandbox.id, command);
          if (result.exitCode !== 0) throw new Error("Template command failed");
        }
        const baseCommit = result!.stdout.trim();
        if (!baseCommit) throw new Error("Template HEAD was empty");
        await runner.stop(sandbox.id);
        return { templateId: sandbox.id, baseCommit };
      } catch {
        // SDK errors and command output can contain the clone URL or environment.
        try { await runner.stop(sandbox.id); } catch { /* Best-effort cleanup. */ }
        throw new Error("Archil template preparation failed");
      }
    },

    async fork(templateId, count) {
      if (!Number.isInteger(count) || count < 0) throw new Error("Fork count must be a non-negative integer");
      const template = await sdk.sandboxes.get(templateId);
      await runner.stop(templateId);
      const ids: string[] = [];
      const children: ArchilSandboxLike[] = [];
      try {
        for (let index = 0; index < count; index++) {
          const child = await template.fork();
          // Register immediately: mount repair or startup can fail before the
          // caller receives this child's ID and can take responsibility for it.
          children.push(child);
          const hasMount = child.mounts.some(mount =>
            mount.path === "/mnt/archil" && mount.diskId === options.diskId && mount.conditional);
          if (!hasMount) {
            await child.stop();
            await startSandbox(child, true);
          } else if (!isRunning(child.status)) {
            await startSandbox(child);
          }
          await configureTimeout(child);
          ids.push(child.id);
        }
        return ids;
      } catch (error) {
        await Promise.all(children.map(async child => {
          let stopped = false;
          try { await child.stop(); stopped = true; } catch { /* Delete still gets a chance. */ }
          interrupt(child.id);
          try { await child.delete(); }
          catch {
            if (!stopped) {
              // Do not log SDK errors, which may contain credentials. Logging
              // must never replace the original failure either.
              try { log(`Archil could not stop or delete failed fork ${child.id}.`); } catch { /* Preserve original error. */ }
            }
          }
        }));
        throw error;
      }
    },

    exec(sandboxId, command, execOptions = {}) {
      if (execOptions.timeoutMs !== undefined &&
          (!Number.isFinite(execOptions.timeoutMs) || execOptions.timeoutMs <= 0)) {
        return Promise.reject(new Error("Execution timeout must be a positive finite number"));
      }
      return new Promise<ExecResult>((resolve, reject) => {
        let settled = false;
        let process: ArchilProcessLike | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
        const pending = active.get(sandboxId) ?? new Set<(reason: string) => void>();
        active.set(sandboxId, pending);
        function finish(error?: Error, result?: ExecResult): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(pollTimer);
          pending.delete(cancel);
          if (pending.size === 0) active.delete(sandboxId);
          if (error) reject(error);
          else resolve(result!);
        }
        function cancel(reason: string): void {
          if (settled) return;
          finish(new Error(reason));
          void process?.kill().catch(() => undefined);
        }
        pending.add(cancel);
        if (execOptions.timeoutMs !== undefined) {
          timer = setTimeout(() => cancel("Sandbox execution timed out"), execOptions.timeoutMs);
        }
        void (async () => {
          const sandbox = await sdk.sandboxes.get(sandboxId);
          if (settled) return;
          if (!isRunning(sandbox.status)) return cancel("Sandbox is not running");
          process = await sandbox.run(command, {
            env: { ...options.env, ...execOptions.env },
            timeoutSeconds: execOptions.timeoutMs === undefined ? undefined : Math.ceil(execOptions.timeoutMs / 1000),
            onOutput: output => {
              if (!settled) {
                const chunk = decoders[output.stream].write(Buffer.from(output.data));
                if (chunk) execOptions.onOutput?.(chunk);
              }
            },
          });
          if (settled) {
            await process.kill().catch(() => undefined);
            return;
          }
          const poll = async (): Promise<void> => {
            try {
              await sandbox.refresh();
              if (settled) return;
              if (!isRunning(sandbox.status)) return cancel("Sandbox stopped during execution");
              pollTimer = setTimeout(() => { void poll(); }, 1000);
            } catch {
              if (!settled) cancel("Sandbox status check failed");
            }
          };
          pollTimer = setTimeout(() => { void poll(); }, 1000);
          const result = await process.wait();
          if (result.status === "timed_out") return cancel("Sandbox execution timed out");
          if (result.status === "cancelled" || result.exitCode === undefined) {
            return cancel("Sandbox execution interrupted");
          }
          if (!settled) {
            for (const decoder of Object.values(decoders)) {
              const chunk = decoder.end();
              if (chunk) execOptions.onOutput?.(chunk);
            }
          }
          finish(undefined, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        })().catch(() => finish(new Error("Archil sandbox execution failed")));
      });
    },

    async stop(id) {
      await (await sdk.sandboxes.get(id)).stop();
      interrupt(id);
    },
    async start(id) {
      await startSandbox(await sdk.sandboxes.get(id));
    },
    async remove(id) {
      await (await sdk.sandboxes.get(id)).delete();
      interrupt(id);
    },
  };
  return runner;
}
