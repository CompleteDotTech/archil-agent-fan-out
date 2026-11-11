#!/usr/bin/env node
// swarm/bin/swarm.mjs: recursive fan-out helper for the Codex build swarm.
//
// Leaves (implementers, sandboxed codex exec in their own worktree):
//   spawn <TASK> [--retry <file>] [--fresh]          start a tasks.yaml leaf in the background
//   spawn-sub <PARENT> <SUB> --owns "g1,g2" --verify "cmd1;;cmd2" --prompt-file <f> [--title <t>] [--retry <file>] [--fresh] [--no-start]
//                                                    start an ad-hoc sub-task <PARENT>.<SUB> branched from task/<PARENT>
//                                                    (--no-start only registers it, so it can be orchestrated recursively)
// Orchestrated tasks (an orchestrator splits the task instead of running one leaf):
//   task-init <ID>                                   create .wt/<ID> on task/<ID> without starting a leaf
//   finalize <ID>                                    commit, check OWNS, run verify, mark passed/failed
// Orchestrators (unsandboxed codex exec, any depth):
//   orchestrate <SCOPE> [--prompt-file <f>]          start an orchestrator process for a workstream, task or sub-task
//   ws-run <WS>                                      alias for orchestrate <WS>
// Shared:
//   list | ws-init <WS> | ready <WS> | wait <ID...> [--max-seconds N] | merge <ID> | block <ID> <reason>
//   status [WS] | note <text> | merge-ws <WS> | smoke | caps <maxLeaves> <maxOrch>   (caps apply live via .swarm/caps.json)
//
// Env: SWARM_MODEL (gpt-6.1-sol), SWARM_SERVICE_TIER (ultrafast; empty to disable),
//      SWARM_LEAF_EFFORT (medium), SWARM_ORCH_EFFORT (low), SWARM_MAX_LEAVES (24), SWARM_MAX_ORCH (16),
//      SWARM_LEAF_SANDBOX (full-auto | bypass), SWARM_CODEX_BIN (codex), SWARM_CODEX_ARGS (extra args),
//      SWARM_VERIFY_TIMEOUT_MIN (10)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).stdout.trim();
const SW = path.join(ROOT, ".swarm");
for (const d of ["state", "out", "logs", "prompts", "retry", "adhoc"]) fs.mkdirSync(path.join(SW, d), { recursive: true });

const env = (k, d) => (process.env[k] === undefined ? d : process.env[k]);
const CODEX = env("SWARM_CODEX_BIN", "codex");
const EXTRA = env("SWARM_CODEX_ARGS", "").split(" ").filter(Boolean);
const MODEL = env("SWARM_MODEL", "gpt-6.1-sol");
const TIER = env("SWARM_SERVICE_TIER", "ultrafast");
const LEAF_EFFORT = env("SWARM_LEAF_EFFORT", "medium");
const ORCH_EFFORT = env("SWARM_ORCH_EFFORT", "low");
const CAPS_FILE = path.join(SW, "caps.json");
const fileCaps = (() => {
  try {
    return JSON.parse(fs.readFileSync(CAPS_FILE, "utf8"));
  } catch {
    return {};
  }
})();
const MAX_LEAVES = Number(fileCaps.maxLeaves ?? env("SWARM_MAX_LEAVES", "24"));
const MAX_ORCH = Number(fileCaps.maxOrch ?? env("SWARM_MAX_ORCH", "16"));
const LEAF_SANDBOX =
  env("SWARM_LEAF_SANDBOX", "full-auto") === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--full-auto"];
const modelArgs = (effort) => [
  ...(MODEL ? ["-m", MODEL] : []),
  ...(TIER ? ["-c", `service_tier=${TIER}`] : []),
  ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ...EXTRA,
];

// ---------- helpers ----------

function git(args, opts = {}) {
  for (let i = 0; ; i++) {
    const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd || ROOT });
    const lockErr = /index\.lock|cannot lock ref|Unable to create .*\.lock/i.test(r.stderr || "");
    if (r.status === 0 || !lockErr || i >= 4) {
      if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
      return r;
    }
    spawnSync("sleep", ["0.5"]);
  }
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function loadPlan() {
  let YAML;
  try {
    YAML = (await import("yaml")).default;
  } catch {
    die("The 'yaml' package is missing. Run R0.1 (npm install) first.");
  }
  const doc = YAML.parse(fs.readFileSync(path.join(ROOT, "swarm/tasks.yaml"), "utf8"));
  doc.byId = Object.fromEntries(doc.tasks.map((t) => [t.id, t]));
  doc.wsById = Object.fromEntries(doc.workstreams.map((w) => [w.id, w]));
  return doc;
}

const adhocPath = (id) => path.join(SW, "adhoc", `${id}.json`);
function getTask(plan, id) {
  if (plan.byId[id]) return plan.byId[id];
  if (fs.existsSync(adhocPath(id))) return JSON.parse(fs.readFileSync(adhocPath(id), "utf8"));
  return undefined;
}
const isAdhoc = (task) => Boolean(task.parent && task.adhoc);
const parentBranch = (task) => (isAdhoc(task) ? `task/${task.parent}` : `ws/${task.ws}`);

const statePath = (id) => path.join(SW, "state", `${id}.json`);
function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
  } catch {
    return undefined;
  }
}
function writeState(id, patch) {
  const next = { ...(readState(id) || { id }), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath(id), JSON.stringify(next, null, 2));
  return next;
}
const allStates = () =>
  fs.readdirSync(path.join(SW, "state"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readState(f.slice(0, -5)))
    .filter(Boolean);
function note(text) {
  fs.appendFileSync(path.join(SW, "notes.md"), `- ${new Date().toISOString()} ${text}\n`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function effectiveState(id) {
  const s = readState(id);
  if (!s) return "not-started";
  if (s.state === "running" && !pidAlive(s.pid)) return "crashed";
  return s.state;
}
const running = (kind) => allStates().filter((s) => s.kind === kind && s.state === "running" && pidAlive(s.pid)).length;

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re = re.replace(/\/\.\*$/, "(?:/.*)?");
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

const wsDir = (ws) => path.join(ROOT, ".wt", `ws-${ws}`);
const taskDir = (id) => path.join(ROOT, ".wt", id);

function linkNodeModules(dir) {
  const src = path.join(ROOT, "node_modules");
  const dst = path.join(dir, "node_modules");
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    try {
      fs.symlinkSync(src, dst, "dir");
    } catch {}
  }
}

function wsInit(plan, ws) {
  if (!plan.wsById[ws]) die(`Unknown workstream ${ws}`);
  const dir = wsDir(ws);
  if (!fs.existsSync(dir)) {
    const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/ws/${ws}`], { allowFail: true }).status === 0;
    const r = git(exists ? ["worktree", "add", dir, `ws/${ws}`] : ["worktree", "add", "-b", `ws/${ws}`, dir, plan.base_branch], {
      allowFail: true,
    });
    if (r.status !== 0 && !fs.existsSync(dir)) die(`could not create ${dir}:\n${r.stderr}`);
  }
  linkNodeModules(dir);
  return dir;
}

// Creates (or reuses) the worktree for a task or sub-task, branched from its parent branch.
function ensureTaskWorktree(plan, task, fresh) {
  if (isAdhoc(task)) {
    if (!fs.existsSync(taskDir(task.parent))) die(`parent ${task.parent} has no worktree; run task-init ${task.parent} first`);
  } else wsInit(plan, task.ws);
  const dir = taskDir(task.id);
  const prev = readState(task.id) || {};
  if (fresh && fs.existsSync(dir)) git(["worktree", "remove", "--force", dir], { allowFail: true });
  let base = fresh ? undefined : prev.base;
  if (!fs.existsSync(dir)) {
    git(["worktree", "add", "-B", `task/${task.id}`, dir, parentBranch(task)]);
    base = git(["rev-parse", "HEAD"], { cwd: dir }).stdout.trim();
  }
  linkNodeModules(dir);
  return { dir, base };
}

function buildPrompt(plan, task, retryNotes) {
  const ws = plan.wsById[task.ws];
  const parent = isAdhoc(task) ? getTask(plan, task.parent) : undefined;
  const lines = [
    `# Task ${task.id}: ${task.title}`,
    ``,
    `Workstream ${ws.id} (${ws.name}). You are a leaf worker in a Codex swarm. You work alone in this git worktree.`,
  ];
  if (parent) lines.push(`This is a sub-task of ${parent.id} (${parent.title}). Other agents build the rest of ${parent.id} in parallel.`);
  lines.push(``, `## Goal`, String(task.prompt || "").trim(), ``);
  if (task.notes) lines.push(`## Notes (verified facts)`, task.notes.trim(), ``);
  lines.push(`## OWNS (create or edit only these paths)`, ...task.owns.map((g) => `- ${g}`), ``);
  lines.push(
    `## Read first`,
    `- AGENTS.md`,
    `- src/contracts/types.ts`,
    `- src/contracts/fakes.ts (use these in tests)`,
    ...(task.context || []).map((c) => `- ${c}`),
    ``,
  );
  lines.push(`## VERIFY (run every command; all must pass)`, ...(task.verify || []).map((v) => `- ${v}`), ``);
  if (retryNotes) lines.push(`## Retry: fix these findings from your previous attempt`, retryNotes.trim(), ``);
  lines.push(`## Rules`, plan.common_rules.trim(), ``, `Finish with the final message format from AGENTS.md.`);
  return lines.join("\n");
}

function runCmd(cmd, cwd, timeoutMin) {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutMin * 60_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { cmd, exitCode: r.status ?? 124, tail: out.split("\n").slice(-40).join("\n") };
}

// Commit, check OWNS (and the parent's OWNS for sub-tasks), run verify, write the result.
function gate(plan, task, dir, base, extra = {}) {
  const dirty = git(["status", "--porcelain"], { cwd: dir }).stdout.trim();
  if (dirty) {
    git(["add", "-A"], { cwd: dir });
    const hasIdentity = git(["config", "user.email"], { cwd: dir, allowFail: true }).stdout.trim() !== "";
    const identity = hasIdentity ? [] : ["-c", "user.name=codex-swarm", "-c", "user.email=swarm@localhost"];
    git([...identity, "commit", "--no-verify", "-m", `${task.id}: ${task.title}`], { cwd: dir });
  }
  const changedFiles = git(["diff", "--name-only", `${base}..HEAD`], { cwd: dir }).stdout.split("\n").filter(Boolean);
  const parent = isAdhoc(task) ? getTask(plan, task.parent) : undefined;
  const outsideOwned = changedFiles.filter((f) => !matchesAny(f, task.owns) || (parent && !matchesAny(f, parent.owns)));
  const verifyTimeout = Number(env("SWARM_VERIFY_TIMEOUT_MIN", "10"));
  const checks = (task.verify || []).map((cmd) => runCmd(cmd, dir, verifyTimeout));
  fs.writeFileSync(
    path.join(SW, "logs", `${task.id}.verify.log`),
    checks.map((c) => `$ ${c.cmd}\n(exit ${c.exitCode})\n${c.tail}\n`).join("\n"),
  );
  const codexOk = extra.codexExitCode === undefined || (extra.codexExitCode === 0 && !extra.timedOut);
  const pass = codexOk && outsideOwned.length === 0 && checks.every((c) => c.exitCode === 0);
  const result = {
    task: task.id,
    ws: task.ws,
    parent: task.parent,
    pass,
    ...extra,
    changedFiles,
    outsideOwned,
    checks: checks.map(({ cmd, exitCode, tail }) => ({ cmd, exitCode, tail: exitCode === 0 ? "" : tail })),
    endedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(SW, "out", `${task.id}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---------- detached workers ----------

async function runLeaf(plan, id, retryFile, fresh) {
  const task = getTask(plan, id);
  const { dir, base } = ensureTaskWorktree(plan, task, fresh);
  const attempt = ((readState(id) || {}).attempt || 0) + 1;
  const startedAt = new Date().toISOString();
  writeState(id, { kind: "leaf", ws: task.ws, parent: task.parent, state: "running", attempt, base, pid: process.pid, startedAt });

  const retryNotes = retryFile && fs.existsSync(retryFile) ? fs.readFileSync(retryFile, "utf8") : "";
  const prompt = buildPrompt(plan, task, retryNotes);
  fs.writeFileSync(path.join(SW, "prompts", `${id}.md`), prompt);
  const logPath = path.join(SW, "logs", `${id}.log`);
  const finalPath = path.join(SW, "out", `${id}.final.md`);
  const timeoutMs = (plan.limits?.leaf_timeout_minutes || 25) * 60_000;
  const { code, timedOut } = await runCodex(
    ["exec", ...LEAF_SANDBOX, ...modelArgs(LEAF_EFFORT), "-"],
    { cwd: dir, prompt, logPath, finalPath, timeoutMs },
  );
  const result = gate(plan, task, dir, base, {
    attempt,
    codexExitCode: code,
    timedOut,
    finalMessage: path.relative(ROOT, finalPath),
    log: path.relative(ROOT, logPath),
    startedAt,
  });
  writeState(id, { state: result.pass ? "passed" : "failed", pid: null, endedAt: result.endedAt });
  return result;
}

async function runOrch(plan, scope, promptFile) {
  const id = `orch-${scope}`;
  const instructions = fs.readFileSync(path.join(ROOT, "swarm/prompts/orchestrator.md"), "utf8");
  const extraPrompt = promptFile && fs.existsSync(promptFile) ? `\n\n## Extra instructions from your parent\n${fs.readFileSync(promptFile, "utf8")}` : "";
  const prompt = `${instructions}\n\nYour scope: ${scope}. Start now.${extraPrompt}`;
  fs.writeFileSync(path.join(SW, "prompts", `${id}.md`), prompt);
  writeState(id, { kind: "orch", scope, state: "running", pid: process.pid, startedAt: new Date().toISOString() });
  const { code } = await runCodex(
    ["exec", "--dangerously-bypass-approvals-and-sandbox", ...modelArgs(ORCH_EFFORT), "-"],
    {
      cwd: ROOT,
      prompt,
      logPath: path.join(SW, "logs", `${id}.log`),
      finalPath: path.join(SW, "out", `${id}.final.md`),
      timeoutMs: 120 * 60_000,
    },
  );
  writeState(id, { state: code === 0 ? "finished" : "failed", exitCode: code, pid: null, endedAt: new Date().toISOString() });
  note(`orchestrator ${scope} ${code === 0 ? "finished" : `failed (exit ${code})`}; report: .swarm/out/${id}.final.md`);
}

function runCodex(args, { cwd, prompt, logPath, finalPath, timeoutMs }) {
  return new Promise((resolve) => {
    const log = fs.openSync(logPath, "a");
    const out = fs.openSync(finalPath, "w");
    const child = spawn(CODEX, args, { cwd, stdio: ["pipe", out, log], env: process.env });
    let timedOut = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      fs.appendFileSync(logPath, `\n[swarm] failed to start ${CODEX}: ${err.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function detach(kind, id, args) {
  const cap = kind === "leaf" ? MAX_LEAVES : MAX_ORCH;
  const n = running(kind);
  if (n >= cap) die(`AT CAPACITY: ${n}/${cap} ${kind === "leaf" ? "leaves" : "orchestrators"} running. Run wait, then retry.`, 3);
  const log = fs.openSync(path.join(SW, "logs", `${id}.spawn.log`), "a");
  const child = spawn(process.execPath, [path.join(ROOT, "swarm/bin/swarm.mjs"), ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  writeState(id, { kind, state: "running", pid: child.pid, startedAt: new Date().toISOString() });
  return child.pid;
}

// ---------- commands ----------

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BOOL_FLAGS = new Set(["--fresh", "--no-start"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !BOOL_FLAGS.has(args[i - 1])));

const plan = await loadPlan();

function spawnLeaf(id) {
  const task = getTask(plan, id);
  if (!task || (task.layer !== 2 && !isAdhoc(task))) die(`spawn takes a leaf task id; got ${id}`);
  if (effectiveState(id) === "running") die(`${id} is already running`);
  const childArgs = ["_run-leaf", id];
  if (flag("--retry")) childArgs.push("--retry", path.resolve(flag("--retry")));
  if (args.includes("--fresh")) childArgs.push("--fresh");
  const pid = detach("leaf", id, childArgs);
  writeState(id, { ws: task.ws, parent: task.parent });
  console.log(`spawned ${id} (pid ${pid}); log: .swarm/logs/${id}.log; result: .swarm/out/${id}.json`);
}

switch (cmd) {
  case "list": {
    for (const t of plan.tasks) {
      console.log(`${t.id.padEnd(5)} L${t.layer} ws:${String(t.ws).padEnd(4)} deps:[${(t.deps || []).join(",")}]  ${t.title}`);
    }
    break;
  }
  case "ws-init":
    console.log(wsInit(plan, positional[0]));
    break;
  case "ready": {
    const ws = positional[0];
    const tasks = plan.tasks.filter((t) => t.ws === ws && t.layer === 2);
    const ready = tasks.filter(
      (t) => effectiveState(t.id) === "not-started" && (t.deps || []).every((d) => effectiveState(d) === "merged"),
    );
    console.log(`ready: ${ready.map((t) => t.id).join(" ") || "(none)"}`);
    console.log(`running: ${tasks.filter((t) => ["running", "orchestrating"].includes(effectiveState(t.id))).map((t) => t.id).join(" ") || "(none)"}`);
    const waiting = tasks.filter((t) => effectiveState(t.id) === "not-started" && !ready.includes(t));
    if (waiting.length) console.log(`waiting on deps: ${waiting.map((t) => t.id).join(" ")}`);
    console.log(`capacity: leaves ${running("leaf")}/${MAX_LEAVES}, orchestrators ${running("orch")}/${MAX_ORCH}`);
    break;
  }
  case "spawn":
    spawnLeaf(positional[0]);
    break;
  case "spawn-sub": {
    const [parentId, sub] = positional;
    const parentTask = getTask(plan, parentId);
    if (!parentTask) die(`unknown parent ${parentId}`);
    if (!sub || !/^[A-Za-z0-9_-]+$/.test(sub)) die("sub id must be letters, digits, - or _");
    const id = `${parentId}.${sub}`;
    const promptFile = flag("--prompt-file");
    if (!fs.existsSync(adhocPath(id))) {
      if (!promptFile || !fs.existsSync(promptFile)) die("--prompt-file <file> is required for a new sub-task");
      const owns = (flag("--owns") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const verify = (flag("--verify") || "").split(";;").map((s) => s.trim()).filter(Boolean);
      if (!owns.length) die("--owns is required");
      const spec = {
        id,
        adhoc: true,
        layer: 2,
        parent: parentId,
        ws: parentTask.ws,
        title: flag("--title") || `${parentTask.title} / ${sub}`,
        owns,
        verify,
        prompt: fs.readFileSync(promptFile, "utf8"),
        context: parentTask.context || [],
        notes: parentTask.notes,
      };
      fs.writeFileSync(adhocPath(id), JSON.stringify(spec, null, 2));
    }
    if (args.includes("--no-start")) {
      console.log(`registered ${id}; run task-init ${id} to orchestrate it, or spawn ${id} to run it as a leaf`);
      break;
    }
    spawnLeaf(id);
    break;
  }
  case "task-init": {
    const id = positional[0];
    const task = getTask(plan, id);
    if (!task) die(`unknown task ${id}`);
    const { dir, base } = ensureTaskWorktree(plan, task, args.includes("--fresh"));
    writeState(id, { kind: "orchestrated", ws: task.ws, parent: task.parent, state: "orchestrating", base, startedAt: new Date().toISOString() });
    console.log(dir);
    break;
  }
  case "finalize": {
    const id = positional[0];
    const task = getTask(plan, id);
    const s = readState(id);
    if (!task || !s || !fs.existsSync(taskDir(id))) die(`${id} has no worktree; run task-init first`);
    const result = gate(plan, task, taskDir(id), s.base);
    writeState(id, { state: result.pass ? "passed" : "failed", endedAt: result.endedAt });
    console.log(JSON.stringify({ task: id, pass: result.pass, outsideOwned: result.outsideOwned, failed: result.checks.filter((c) => c.exitCode).map((c) => c.cmd) }));
    break;
  }
  case "_run-leaf": {
    const r = await runLeaf(plan, positional[0], flag("--retry"), args.includes("--fresh"));
    console.log(JSON.stringify({ task: r.task, pass: r.pass }));
    break;
  }
  case "orchestrate":
  case "ws-run": {
    const scope = positional[0];
    if (!scope || (!plan.wsById[scope] && !getTask(plan, scope))) die(`unknown scope ${scope}`);
    if (effectiveState(`orch-${scope}`) === "running") die(`orchestrator for ${scope} is already running`);
    const childArgs = ["_run-orch", scope];
    if (flag("--prompt-file")) childArgs.push("--prompt-file", path.resolve(flag("--prompt-file")));
    const pid = detach("orch", `orch-${scope}`, childArgs);
    console.log(`started orchestrator for ${scope} (pid ${pid}); log: .swarm/logs/orch-${scope}.log; report: .swarm/out/orch-${scope}.final.md`);
    break;
  }
  case "_run-orch":
    try {
      await runOrch(plan, positional[0], flag("--prompt-file"));
    } catch (err) {
      writeState(`orch-${positional[0]}`, { kind: "orch", scope: positional[0], state: "failed", pid: null, error: String(err) });
      note(`orchestrator ${positional[0]} crashed: ${err.message}`);
    }
    break;
  case "caps": {
    const [leaves, orch] = positional.map(Number);
    if (!leaves || !orch) die("usage: caps <maxLeaves> <maxOrchestrators>");
    fs.writeFileSync(CAPS_FILE, JSON.stringify({ maxLeaves: leaves, maxOrch: orch }));
    note(`caps set: ${leaves} leaves, ${orch} orchestrators`);
    console.log(`caps: ${leaves} leaves, ${orch} orchestrators (applies to new spawns)`);
    break;
  }
  case "wait": {
    const ids = positional;
    const maxMs = Number(flag("--max-seconds") || 90) * 1000;
    const start = Date.now();
    const initiallyRunning = ids.filter((id) => effectiveState(id) === "running");
    while (initiallyRunning.length && Date.now() - start < maxMs) {
      if (initiallyRunning.some((id) => effectiveState(id) !== "running")) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    for (const id of ids) {
      const s = readState(id) || {};
      console.log(`${id}: ${effectiveState(id)}${s.attempt ? ` (attempt ${s.attempt})` : ""}`);
    }
    break;
  }
  case "merge": {
    const id = positional[0];
    const task = getTask(plan, id);
    if (!task) die(`unknown task ${id}`);
    if (effectiveState(id) !== "passed") die(`${id} is ${effectiveState(id)}, not passed`);
    const target = isAdhoc(task) ? taskDir(task.parent) : wsInit(plan, task.ws);
    if (!fs.existsSync(target)) die(`merge target ${target} is missing`);
    const r = git(["merge", "--no-ff", "--no-edit", `task/${id}`], { cwd: target, allowFail: true });
    if (r.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { cwd: target, allowFail: true }).stdout;
      git(["merge", "--abort"], { cwd: target, allowFail: true });
      die(`merge conflict for ${id}:\n${conflicts || r.stderr}`, 2);
    }
    writeState(id, { state: "merged" });
    const into = isAdhoc(task) ? `task/${task.parent}` : `ws/${task.ws}`;
    note(`${id} merged into ${into}`);
    console.log(`merged ${id} into ${into}`);
    break;
  }
  case "block": {
    const [id, ...reason] = positional;
    writeState(id, { state: "blocked", reason: reason.join(" ") });
    note(`${id} BLOCKED: ${reason.join(" ")}`);
    console.log(`blocked ${id}`);
    break;
  }
  case "note":
    note(args.join(" "));
    break;
  case "status": {
    const ws = positional[0];
    const adhoc = fs.readdirSync(path.join(SW, "adhoc")).filter((f) => f.endsWith(".json")).map((f) => getTask(plan, f.slice(0, -5)));
    const rows = [...plan.tasks.filter((t) => t.layer === 2), ...adhoc].filter((t) => !ws || t.ws === ws);
    rows.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    for (const t of rows) {
      const s = readState(t.id) || {};
      let detail = "";
      try {
        const out = JSON.parse(fs.readFileSync(path.join(SW, "out", `${t.id}.json`), "utf8"));
        const failed = out.checks.filter((c) => c.exitCode !== 0).map((c) => c.cmd);
        detail = out.pass
          ? "checks ok"
          : [out.timedOut && "timed out", out.outsideOwned.length && `outside OWNS: ${out.outsideOwned.join(",")}`,
             failed.length && `failed: ${failed.join(" | ")}`, out.codexExitCode && `codex exit ${out.codexExitCode}`]
              .filter(Boolean)
              .join("; ");
      } catch {}
      const depth = t.id.split(".").length - 1;
      console.log(`${"  ".repeat(depth)}${t.id.padEnd(14 - 2 * depth)} ${t.ws}  ${effectiveState(t.id).padEnd(13)} ${s.attempt ? `a${s.attempt}` : "  "}  ${detail}${s.reason ? ` (${s.reason})` : ""}`);
    }
    const orchs = allStates().filter((s) => s.kind === "orch");
    if (orchs.length) {
      console.log("\norchestrator processes:");
      for (const o of orchs) console.log(`  ${String(o.scope || o.id).padEnd(12)} ${effectiveState(o.id)}`);
    }
    console.log(`\ncapacity: leaves ${running("leaf")}/${MAX_LEAVES}, orchestrators ${running("orch")}/${MAX_ORCH}`);
    const notesFile = path.join(SW, "notes.md");
    if (fs.existsSync(notesFile)) {
      console.log("recent notes:");
      console.log(fs.readFileSync(notesFile, "utf8").trim().split("\n").slice(-8).join("\n"));
    }
    break;
  }
  case "merge-ws": {
    const ws = positional[0];
    const r = git(["merge", "--no-ff", "--no-edit", `ws/${ws}`], { allowFail: true });
    if (r.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout;
      git(["merge", "--abort"], { allowFail: true });
      die(`merge conflict merging ws/${ws}:\n${conflicts || r.stderr}`, 2);
    }
    note(`ws/${ws} merged into ${git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()}`);
    console.log(`merged ws/${ws}`);
    break;
  }
  case "smoke": {
    const dir = path.join(ROOT, ".wt", "_smoke");
    git(["worktree", "remove", "--force", dir], { allowFail: true });
    git(["worktree", "add", "--detach", dir, "HEAD"]);
    const logPath = path.join(SW, "logs", "_smoke.log");
    const prompt = "Create a file named SMOKE.txt whose only content is the word ok. Change nothing else.";
    const r = spawnSync(CODEX, ["exec", ...LEAF_SANDBOX, ...modelArgs(LEAF_EFFORT), "-"], {
      cwd: dir,
      input: prompt,
      encoding: "utf8",
      timeout: 5 * 60_000,
    });
    fs.writeFileSync(logPath, `args: ${["exec", ...LEAF_SANDBOX, ...modelArgs(LEAF_EFFORT)].join(" ")}\n${r.error ? `spawn error: ${r.error.message}\n` : ""}${r.stderr || ""}\n--- stdout ---\n${r.stdout || ""}`);
    const smokeFile = path.join(dir, "SMOKE.txt");
    const ok = fs.existsSync(smokeFile) && /ok/i.test(fs.readFileSync(smokeFile, "utf8"));
    git(["worktree", "remove", "--force", dir], { allowFail: true });
    if (ok) console.log(`SMOKE OK (model ${MODEL || "default"}, tier ${TIER || "default"})`);
    else die(`SMOKE FAILED (codex exit ${r.status}); see .swarm/logs/_smoke.log. Try SWARM_SERVICE_TIER= or SWARM_LEAF_SANDBOX=bypass.`);
    break;
  }
  default:
    die("usage: node swarm/bin/swarm.mjs <list|ws-init|ready|spawn|spawn-sub|task-init|finalize|orchestrate|wait|merge|block|status|note|merge-ws|caps|smoke> ...");
}
