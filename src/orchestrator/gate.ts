import type { Gate, SandboxRunner } from "../contracts/types.js";
import { matchesAny } from "./globs.js";

function outputTail(output: string): string {
  return output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").slice(-40).join("\n");
}

export function createGate(sandboxes: SandboxRunner, opts?: { timeoutMs?: number }): Gate {
  return {
    async check({ task, manifest, sandboxId }) {
      const findings: string[] = [];
      if (manifest.status !== "complete") {
        findings.push(`Manifest status is ${manifest.status}; expected complete.`);
      }
      for (const path of manifest.changedFiles) {
        if (!matchesAny(path, task.owns)) {
          findings.push(`Changed file is outside task ownership: ${path}`);
        }
      }

      // Always rerun every command, regardless of the worker's reported checks.
      for (const cmd of task.verify) {
        let streamedOutput = "";
        try {
          const result = await sandboxes.exec(sandboxId, `cd /repo && ${cmd}`, {
            timeoutMs: opts?.timeoutMs ?? 120_000,
            onOutput: chunk => { streamedOutput += chunk; },
          });
          if (result.exitCode !== 0) {
            const separator = result.stdout && result.stderr && !result.stdout.endsWith("\n") ? "\n" : "";
            const output = result.stdout + separator + result.stderr;
            findings.push(`Verification command failed (${result.exitCode}): ${cmd}\n${outputTail(output)}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          findings.push(`Verification command failed: ${cmd}\n${message}\n${outputTail(streamedOutput)}`);
        }
      }
      return { pass: findings.length === 0, findings };
    },
  };
}
