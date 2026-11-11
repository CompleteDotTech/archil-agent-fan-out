#!/usr/bin/env node
// swarm/bin/swarm.mjs: fan-out helper for the three-layer Codex build swarm.
//
//   list                                 tasks, workstreams and dependencies
//   ws-init <WS>                         create .wt/ws-<WS> on branch ws/<WS> from the base branch
//   ready <WS>                           tasks in <WS> whose dependencies are merged and that haven't started
//   spawn <TASK> [--retry <file>] [--fresh]   start a leaf worker in the background (returns immediately)
//   wait <TASK...> [--max-seconds N]     block until one of the tasks finishes (default 90 s), print states
//   merge <TASK>                         merge task/<TASK> into ws/<WS>
//   block <TASK> <reason>                mark a task blocked
//   status [WS]                          table of every task, plus recent notes
//   note <text>                          append a line to .swarm/notes.md (root reads it)
//   merge-ws <WS>                        root only: merge ws/<WS> into the current branch (main)
//   ws-run <WS>                          fallback: run a workstream orchestrator as a headless codex exec
//   smoke                                prove a leaf worker can run from here
//
// Env: SWARM_CODEX_BIN (codex), SWARM_CODEX_ARGS (extra args, e.g. "-m gpt-5.5"),
//      SWARM_LEAF_SANDBOX (full-auto | bypass), SWARM_VERIFY_TIMEOUT_MIN (10)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).stdout.trim();
const SW = path.join(ROOT, ".swarm");
const DIRS = ["state", "out", "logs", "prompts", "retry"].map((d) => path.join(SW, d));
for (const d of DIRS) fs.mkdirSync(d, { recursive: true });

const CODEX = process.env.SWARM_CODEX_BIN || "codex";
const EXTRA = (process.env.SWARM_CODEX_ARGS || "").split(" ").filter(Boolean);
const LEAF_SANDBOX =
  process.env.SWARM_LEAF_SANDBOX === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--full-auto"];

// ---------- helpers ----------

function git(args, opts = {}) {
  for (let i = 0; ; i++) {
    const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd || ROOT });
    const lockErr = /index\.lock|cannot lock ref|Unable to create .*\.lock/i.test(r.stderr || "");
    if (r.status === 0 || !lockErr || i >= 4) {
      if (r.status !== 0 && !opts.allowFail) {
        throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
      }
      return r;
    }
    spawnSync("sleep", ["0.5"]);
  }
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

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const statePath = (id) => path.join(SW, "state", `${id}.json`);
function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
  } catch {
    return undefined;
  }
}
function writeState(id, patch) {
  const next = { ...(readState(id) || { task: id }), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath(id), JSON.stringify(next, null, 2));
  return next;
}
function note(text) {
  fs.appendFileSync(path.join(SW, "notes.md"), `- ${new Date().toISOString()} ${text}\n`);
}

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

function wsDir(ws) {
  return path.join(ROOT, ".wt", `ws-${ws}`);
}
function taskDir(id) {
  return path.join(ROOT, ".wt", id);
}

function linkNodeModules(dir) {
  const src = path.join(ROOT, "node_modules");
  const dst = path.join(dir, "node_modules");
  if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, "dir");
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

function buildPrompt(plan, task, retryNotes) {
  const ws = plan.wsById[task.ws];
  const lines = [
    `# Task ${task.id}: ${task.title}`,
    ``,
    `Workstream ${ws.id} (${ws.name}). You are a leaf worker in a Codex swarm. You work alone in this git worktree.`,
    ``,
    `## Goal`,
    task.prompt.trim(),
    ``,
  ];
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

// ---------- leaf worker (runs detached) ----------

async function runLeaf(plan, id, retryFile, fresh) {
  const task = plan.byId[id];
  const ws = task.ws;
  wsInit(plan, ws);
  const dir = taskDir(id);
  const prev = readState(id) || {};
  const attempt = (prev.attempt || 0) + 1;

  if (fresh && fs.existsSync(dir)) {
    git(["worktree", "remove", "--force", dir], { allowFail: true });
  }
  let base = prev.base;
  if (!fs.existsSync(dir)) {
    git(["worktree", "add", "-B", `task/${id}`, dir, `ws/${ws}`]);
    base = git(["rev-parse", "HEAD"], { cwd: dir }).stdout.trim();
  }
  linkNodeModules(dir);
  const startedAt = new Date().toISOString();
  writeState(id, { ws, state: "running", attempt, base, pid: process.pid, startedAt, endedAt: null });

  const retryNotes = retryFile && fs.existsSync(retryFile) ? fs.readFileSync(retryFile, "utf8") : "";
  const prompt = buildPrompt(plan, task, retryNotes);
  fs.writeFileSync(path.join(SW, "prompts", `${id}.md`), prompt);

  const logPath = path.join(SW, "logs", `${id}.log`);
  const finalPath = path.join(SW, "out", `${id}.final.md`);
  const timeoutMs = (plan.limits?.leaf_timeout_minutes || 25) * 60_000;
  const { code, timedOut } = await new Promise((resolve) => {
    const log = fs.openSync(logPath, "a");
    const out = fs.openSync(finalPath, "w");
    const child = spawn(CODEX, ["exec", ...LEAF_SANDBOX, ...EXTRA, "-"], {
      cwd: dir,
      stdio: ["pipe", out, log],
      env: process.env,
    });
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

  // Commit outside the worker's sandbox.
  const dirty = git(["status", "--porcelain"], { cwd: dir }).stdout.trim();
  if (dirty) {
    git(["add", "-A"], { cwd: dir });
    const hasIdentity = git(["config", "user.email"], { cwd: dir, allowFail: true }).stdout.trim() !== "";
    const identity = hasIdentity ? [] : ["-c", "user.name=codex-swarm", "-c", "user.email=swarm@localhost"];
    git([...identity, "commit", "--no-verify", "-m", `${id}: ${task.title} (attempt ${attempt})`], { cwd: dir });
  }
  const changedFiles = git(["diff", "--name-only", `${base}..HEAD`], { cwd: dir })
    .stdout.split("\n")
    .filter(Boolean);
  const outsideOwned = changedFiles.filter((f) => !matchesAny(f, task.owns));
  const verifyTimeout = Number(process.env.SWARM_VERIFY_TIMEOUT_MIN || 10);
  const checks = (task.verify || []).map((cmd) => runCmd(cmd, dir, verifyTimeout));
  fs.writeFileSync(
    path.join(SW, "logs", `${id}.verify.log`),
    checks.map((c) => `$ ${c.cmd}\n(exit ${c.exitCode})\n${c.tail}\n`).join("\n"),
  );
  const pass = code === 0 && !timedOut && outsideOwned.length === 0 && checks.every((c) => c.exitCode === 0);
  const result = {
    task: id,
    ws,
    attempt,
    pass,
    codexExitCode: code,
    timedOut,
    changedFiles,
    outsideOwned,
    checks: checks.map(({ cmd, exitCode, tail }) => ({ cmd, exitCode, tail: exitCode === 0 ? "" : tail })),
    finalMessage: path.relative(ROOT, finalPath),
    log: path.relative(ROOT, logPath),
    startedAt,
    endedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(SW, "out", `${id}.json`), JSON.stringify(result, null, 2));
  writeState(id, { state: pass ? "passed" : "failed", pid: null, endedAt: result.endedAt });
  return result;
}

// ---------- commands ----------

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const plan = await loadPlan();

switch (cmd) {
  case "list": {
    for (const t of plan.tasks) {
      console.log(
        `${t.id.padEnd(5)} L${t.layer} ws:${String(t.ws).padEnd(4)} deps:[${(t.deps || []).join(",")}]  ${t.title}`,
      );
    }
    break;
  }
  case "ws-init": {
    console.log(wsInit(plan, args[0]));
    break;
  }
  case "ready": {
    const ws = args[0];
    const tasks = plan.tasks.filter((t) => t.ws === ws && t.layer === 2);
    const ready = tasks.filter(
      (t) => effectiveState(t.id) === "not-started" && (t.deps || []).every((d) => effectiveState(d) === "merged"),
    );
    const running = tasks.filter((t) => effectiveState(t.id) === "running").map((t) => t.id);
    console.log(`ready: ${ready.map((t) => t.id).join(" ") || "(none)"}`);
    console.log(`running: ${running.join(" ") || "(none)"}`);
    const waiting = tasks.filter((t) => effectiveState(t.id) === "not-started" && !ready.includes(t));
    if (waiting.length) console.log(`waiting on deps: ${waiting.map((t) => t.id).join(" ")}`);
    break;
  }
  case "spawn": {
    const id = args[0];
    const task = plan.byId[id];
    if (!task || task.layer !== 2) die(`spawn takes a layer-2 task id; got ${id}`);
    if (effectiveState(id) === "running") die(`${id} is already running`);
    const childArgs = [path.join(ROOT, "swarm/bin/swarm.mjs"), "_run-leaf", id];
    if (flag("--retry")) childArgs.push("--retry", path.resolve(flag("--retry")));
    if (args.includes("--fresh")) childArgs.push("--fresh");
    const spawnLog = fs.openSync(path.join(SW, "logs", `${id}.spawn.log`), "a");
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", spawnLog, spawnLog],
      env: process.env,
    });
    child.unref();
    writeState(id, { ws: task.ws, state: "running", pid: child.pid, startedAt: new Date().toISOString() });
    console.log(`spawned ${id} (pid ${child.pid}); log: .swarm/logs/${id}.log; result: .swarm/out/${id}.json`);
    break;
  }
  case "_run-leaf": {
    const r = await runLeaf(plan, args[0], flag("--retry"), args.includes("--fresh"));
    console.log(JSON.stringify({ task: r.task, pass: r.pass }));
    break;
  }
  case "wait": {
    const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--max-seconds");
    const maxMs = Number(flag("--max-seconds") || 90) * 1000;
    const start = Date.now();
    const initiallyRunning = ids.filter((id) => effectiveState(id) === "running");
    while (Date.now() - start < maxMs) {
      if (initiallyRunning.some((id) => effectiveState(id) !== "running")) break;
      if (!initiallyRunning.length) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    for (const id of ids) {
      const s = readState(id) || {};
      console.log(`${id}: ${effectiveState(id)}${s.attempt ? ` (attempt ${s.attempt})` : ""}`);
    }
    break;
  }
  case "merge": {
    const id = args[0];
    const task = plan.byId[id];
    if (effectiveState(id) !== "passed") die(`${id} is ${effectiveState(id)}, not passed`);
    const dir = wsInit(plan, task.ws);
    const r = git(["merge", "--no-ff", "--no-edit", `task/${id}`], { cwd: dir, allowFail: true });
    if (r.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true }).stdout;
      git(["merge", "--abort"], { cwd: dir, allowFail: true });
      die(`merge conflict for ${id}:\n${conflicts || r.stderr}`, 2);
    }
    writeState(id, { state: "merged" });
    note(`${id} merged into ws/${task.ws}`);
    console.log(`merged ${id} into ws/${task.ws}`);
    break;
  }
  case "block": {
    const [id, ...reason] = args;
    writeState(id, { state: "blocked", reason: reason.join(" ") });
    note(`${id} BLOCKED: ${reason.join(" ")}`);
    console.log(`blocked ${id}`);
    break;
  }
  case "note": {
    note(args.join(" "));
    break;
  }
  case "status": {
    const ws = args[0];
    for (const t of plan.tasks.filter((t) => t.layer === 2 && (!ws || t.ws === ws))) {
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
      console.log(
        `${t.id.padEnd(4)} ${t.ws}  ${effectiveState(t.id).padEnd(11)} ${s.attempt ? `a${s.attempt}` : "  "}  ${detail}${s.reason ? ` (${s.reason})` : ""}`,
      );
    }
    const notesFile = path.join(SW, "notes.md");
    if (fs.existsSync(notesFile)) {
      console.log("\nrecent notes:");
      console.log(fs.readFileSync(notesFile, "utf8").trim().split("\n").slice(-8).join("\n"));
    }
    break;
  }
  case "merge-ws": {
    const ws = args[0];
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
  case "ws-run": {
    const ws = args[0];
    if (!plan.wsById[ws]) die(`Unknown workstream ${ws}`);
    const instructions = fs.readFileSync(path.join(ROOT, "swarm/prompts/ws_orchestrator.md"), "utf8");
    const prompt = `${instructions}\n\nYou own workstream ${ws}. Start now.`;
    const log = fs.openSync(path.join(SW, "logs", `ws-${ws}.log`), "a");
    const out = fs.openSync(path.join(SW, "out", `ws-${ws}.final.md`), "w");
    const child = spawn(CODEX, ["exec", "--dangerously-bypass-approvals-and-sandbox", ...EXTRA, "-"], {
      cwd: ROOT,
      detached: true,
      stdio: ["pipe", out, log],
      env: process.env,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.unref();
    console.log(`started workstream ${ws} orchestrator (pid ${child.pid}); log: .swarm/logs/ws-${ws}.log`);
    break;
  }
  case "smoke": {
    const dir = path.join(ROOT, ".wt", "_smoke");
    git(["worktree", "remove", "--force", dir], { allowFail: true });
    git(["worktree", "add", "--detach", dir, "HEAD"]);
    const logPath = path.join(SW, "logs", "_smoke.log");
    const prompt = "Create a file named SMOKE.txt whose only content is the word ok. Change nothing else.";
    const r = spawnSync(CODEX, ["exec", ...LEAF_SANDBOX, ...EXTRA, "-"], {
      cwd: dir,
      input: prompt,
      encoding: "utf8",
      timeout: 5 * 60_000,
    });
    fs.writeFileSync(logPath, `${r.error ? `spawn error: ${r.error.message}\n` : ""}${r.stderr || ""}\n--- stdout ---\n${r.stdout || ""}`);
    const ok = fs.existsSync(path.join(dir, "SMOKE.txt")) && /ok/i.test(fs.readFileSync(path.join(dir, "SMOKE.txt"), "utf8"));
    git(["worktree", "remove", "--force", dir], { allowFail: true });
    if (ok) console.log("SMOKE OK");
    else die(`SMOKE FAILED (codex exit ${r.status}); see .swarm/logs/_smoke.log`);
    break;
  }
  default:
    die("usage: node swarm/bin/swarm.mjs <list|ws-init|ready|spawn|wait|merge|block|status|note|merge-ws|ws-run|smoke> ...");
}
