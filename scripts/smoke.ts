import { pathToFileURL } from "node:url";
import * as archil from "disk";
import { createDatabase } from "@archildata/sqlite";

interface SmokeConfig {
  apiKey?: string;
  region?: string;
  diskId?: string;
  targetRepo?: string;
}

type SmokeSandbox = Pick<archil.Sandbox, "run" | "stop" | "delete">;
interface SmokeDependencies {
  configure: typeof archil.configure;
  createSandbox: (request: archil.CreateSandboxRequest) => Promise<SmokeSandbox>;
  getDisk: typeof archil.getDisk;
  createDatabase: typeof createDatabase;
  log: (line: string) => void;
  now: () => Date;
}
interface Result {
  step: string;
  status: "PASS" | "FAIL";
  reason: string;
}

class ProbeFailure extends Error {}

const endpoints = [
  ["OpenAI egress", "https://api.openai.com/v1/models"],
  ["GitHub API egress", "https://api.github.com"],
  ["GitHub egress", "https://github.com"],
  ["npm egress", "https://registry.npmjs.org/hono"],
  ["Keenable egress", "https://api.keenable.ai/v1/search/public"],
] as const;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Never print SDK error messages or raw subprocess output: they can contain
// credentials, repository names, disk IDs, or request URLs with credentials.
function failureReason(error: unknown): string {
  if (error instanceof ProbeFailure) return error.message;
  if (error instanceof archil.ArchilError) {
    return `SDK request failed (HTTP ${error.status})`;
  }
  return "operation failed; details suppressed";
}

export async function runSmoke(
  config: SmokeConfig,
  overrides: Partial<SmokeDependencies> = {},
): Promise<boolean> {
  const deps: SmokeDependencies = {
    configure: archil.configure,
    createSandbox: archil.createSandbox,
    getDisk: archil.getDisk,
    createDatabase,
    log: console.log,
    now: () => new Date(),
    ...overrides,
  };
  const results: Result[] = [];
  const report = (step: string, status: Result["status"], reason: string) => {
    results.push({ step, status, reason });
    deps.log(`${status} ${step}: ${reason}`);
  };
  const check = async (step: string, action: () => Promise<string>) => {
    try {
      report(step, "PASS", await action());
    } catch (error) {
      report(step, "FAIL", failureReason(error));
    }
  };
  const summary = () => {
    deps.log("\nSummary");
    deps.log("Step | Result | Reason");
    for (const result of results) {
      deps.log(`${result.step} | ${result.status} | ${result.reason}`);
    }
    const failed = results.filter((result) => result.status === "FAIL").length;
    deps.log(`${results.length - failed} passed; ${failed} failed`);
    return failed === 0;
  };

  const missing = [
    ["ARCHIL_API_KEY", config.apiKey],
    ["ARCHIL_REGION", config.region],
    ["ARCHIL_DISK_ID", config.diskId],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) {
    report("Configuration", "FAIL", `missing ${missing.join(", ")}`);
    return summary();
  }

  let sandbox: SmokeSandbox | undefined;
  const timestamp = deps.now().toISOString().replaceAll(":", "-");
  const marker = `archil-smoke-${timestamp}`;
  try {
    deps.configure({ apiKey: config.apiKey, region: config.region });
    await check("Create sandbox", async () => {
      sandbox = await deps.createSandbox({
        name: `smoke-${timestamp}`,
        baseImage: "node:24-bookworm",
        vcpuCount: 1,
        memSizeMiB: 2048,
        mounts: [{ disk: config.diskId!, path: "/mnt/archil", conditional: true }],
      });
      return "node:24-bookworm; conditional disk mounted at /mnt/archil";
    });

    const run = async (command: string, timeoutSeconds = 30) => {
      if (!sandbox) throw new Error("sandbox unavailable");
      const execution = await sandbox.run(command, { timeoutSeconds });
      return execution.wait();
    };
    const unavailable = (step: string) => report(step, "FAIL", "not run: sandbox unavailable");
    for (const [step, url] of endpoints) {
      if (!sandbox) {
        unavailable(step);
        continue;
      }
      // A nonzero curl exit can still accompany an HTTP response. Reachability
      // depends on the response status, including authentication failures.
      await check(step, async () => {
        const post = step === "Keenable egress"
          ? ` -X POST -H 'X-Keenable-Title: smoke' -H 'Content-Type: application/json' --data '{"query":"archil"}'`
          : "";
        const result = await run(`curl -s -o /dev/null -w '%{http_code}' --max-time 10${post} ${quote(url)}`);
        const status = result.stdout.trim();
        if (/^[1-5]\d\d$/.test(status)) return `reachable (HTTP ${status})`;
        if (status === "000") {
          throw new ProbeFailure("blocked or unreachable (HTTP 000)");
        }
        throw new Error("no HTTP response");
      });
    }

    if (!config.targetRepo?.trim()) {
      report("Public repository", "PASS", "skipped: TARGET_REPO is not set");
    } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.targetRepo)) {
      report("Public repository", "FAIL", "TARGET_REPO must be owner/name");
    } else if (!sandbox) {
      unavailable("Public repository");
    } else {
      await check("Public repository", async () => {
        const result = await run(
          `GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote ${quote(`https://github.com/${config.targetRepo}`)}`,
          30,
        );
        if (result.exitCode !== 0) throw new Error("git failed");
        return "git ls-remote succeeded";
      });
    }

    if (!sandbox) {
      unavailable("Shared disk");
      unavailable("Codex CLI");
    } else {
      await check("Shared disk", async () => {
        const file = quote(`/mnt/archil/smoke/${timestamp}.txt`);
        const result = await run(
          `mkdir -p /mnt/archil/smoke && printf '%s' ${quote(marker)} > ${file} && sync ${file} && cat ${file}`,
        );
        if (result.exitCode !== 0 || result.stdout !== marker) throw new Error("disk mismatch");
        return "write, sync, and read-back matched";
      });
      await check("Codex CLI", async () => {
        const result = await run("npm install -g @openai/codex && codex --version", 600);
        if (result.exitCode !== 0 || !/codex[^\r\n]*\d+\.\d+/i.test(result.stdout)) {
          throw new Error("Codex install or version failed");
        }
        return "installed and codex --version succeeded";
      });
    }

    await check("Archil SQLite", async () => {
      const disk = await deps.getDisk(config.diskId!);
      const db = await deps.createDatabase(disk, "smoke/smoke.sqlite");
      await db.write`CREATE TABLE IF NOT EXISTS smoke_checks (value TEXT NOT NULL)`.run();
      await db.write`INSERT INTO smoke_checks (value) VALUES (${marker})`.run();
      const rows = await db.read`SELECT value FROM smoke_checks WHERE value = ${marker}`.all();
      if (!rows.some((row) => row.value === marker)) throw new Error("SQLite mismatch");
      return "created database; row write and read-back matched";
    });
  } catch (error) {
    report("Smoke execution", "FAIL", failureReason(error));
  } finally {
    if (sandbox) {
      const created = sandbox;
      await check("Stop sandbox", async () => {
        await created.stop();
        return "stopped";
      });
      await check("Delete sandbox", async () => {
        await created.delete();
        return "deleted";
      });
    } else {
      report("Sandbox cleanup", "PASS", "skipped: no sandbox was created");
    }
  }
  return summary();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const passed = await runSmoke({
    apiKey: process.env.ARCHIL_API_KEY,
    region: process.env.ARCHIL_REGION,
    diskId: process.env.ARCHIL_DISK_ID,
    targetRepo: process.env.TARGET_REPO,
  });
  if (!passed) process.exitCode = 1;
}
