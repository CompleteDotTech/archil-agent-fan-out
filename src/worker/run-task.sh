#!/usr/bin/env bash
# The sandbox is the isolation boundary. This script owns commits; agents do not.
set +x
set -euo pipefail

: "${RUN_ID:?}" "${TASK_ID:?}" "${ATTEMPT_ID:?}" "${BASE_COMMIT:?}"
DISK=${DISK:-/mnt/archil}
REPO_DIR=${REPO_DIR:-/repo}
RESUME=${RESUME:-0}
AGENT=${AGENT:-codex}
PUSH=${PUSH:-1}
case "$RESUME:$PUSH:$AGENT" in
  [01]:[01]:codex|[01]:[01]:fake) ;;
  *) printf '%s\n' 'Invalid RESUME, PUSH, or AGENT' >&2; exit 1 ;;
esac

dir="$DISK/runs/$RUN_ID/$TASK_ID/$ATTEMPT_ID"
branch="swarm/$RUN_ID/$TASK_ID/$ATTEMPT_ID"
archil invalidate-cache "$DISK" 2>/dev/null || true
PROMPT=$(node -e '
const fs = require("node:fs");
const task = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const sections = [task.title, task.prompt || "",
  "Acceptance:\n" + task.acceptance.join("\n"),
  "OWNS:\n" + task.owns.join("\n"),
  "VERIFY:\n" + task.verify.join("\n"),
  "Findings:\n" + (task.findings || []).join("\n")];
if (fs.existsSync(process.argv[2])) sections.push("Research notes:\n" + process.argv[2]);
sections.push("Never edit package.json or the lockfile.\nDo not commit.");
process.stdout.write(sections.join("\n\n"));
' "$dir/task.json" "$DISK/research/$RUN_ID/$TASK_ID/sources.md")

cd "$REPO_DIR"
git checkout -B "$branch"
# Append on resume so the previous attempt's diagnostics remain available.
: >> "$dir/agent.log"
node -e '
const { spawnSync } = require("node:child_process");
setInterval(() => spawnSync("sync", [process.argv[1]], {stdio: "ignore"}), 10000);
' "$dir/agent.log" >/dev/null 2>&1 &
sync_pid=$!
cleanup() {
  kill "$sync_pid" 2>/dev/null || true
  wait "$sync_pid" 2>/dev/null || true
}
trap cleanup EXIT

agent_exit=0
if [ "$AGENT" = fake ]; then
  if cp -R "$DISK/swarm/fixtures/agent/$TASK_ID/." "$REPO_DIR/" 2>>"$dir/agent.log"; then
    printf 'Applied fake agent fixture for %s.\n' "$TASK_ID" > "$dir/final.md"
  else
    agent_exit=$?
    printf 'Failed to apply fake agent fixture for %s.\n' "$TASK_ID" > "$dir/final.md"
  fi
elif [ "$RESUME" = 1 ]; then
  codex exec resume --last --dangerously-bypass-approvals-and-sandbox \
    "You were interrupted. Check git status and the task above, then finish it." \
    < /dev/null >"$dir/final.md" 2>>"$dir/agent.log" || agent_exit=$?
else
  codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" \
    < /dev/null >"$dir/final.md" 2>>"$dir/agent.log" || agent_exit=$?
fi
cleanup
trap - EXIT
sync "$dir/agent.log" "$dir/final.md"

# Run each command independently, preserving all exit codes even after failures.
node - "$dir" <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const dir = process.argv[2];
const task = JSON.parse(fs.readFileSync(`${dir}/task.json`, 'utf8'));
const logPath = `${dir}/verify.log`;
const fd = fs.openSync(logPath, 'w');
const checks = [];
try {
  for (const cmd of task.verify) {
    fs.writeSync(fd, `$ ${cmd}\n`);
    const result = spawnSync('bash', ['-c', cmd], { stdio: ['ignore', fd, fd] });
    const exitCode = result.status ?? 1;
    if (result.error) fs.writeSync(fd, `${result.error.message}\n`);
    fs.writeSync(fd, `\nExit code: ${exitCode}\n`);
    checks.push({ cmd, exitCode, logPath });
  }
} finally {
  fs.closeSync(fd);
}
fs.writeFileSync(`${dir}/checks.json`, JSON.stringify(checks, null, 2) + '\n');
NODE

git add -A
git -c user.name='Archil Swarm' -c user.email='swarm@localhost' commit --allow-empty -m "$TASK_ID ($ATTEMPT_ID)"
if [ "$PUSH" = 1 ]; then
  : "${GITHUB_PUSH_TOKEN:?}" "${TARGET_REPO:?}"
  # Disable inherited Git tracing and suppress remote diagnostics containing URLs.
  if ! GIT_TRACE=0 GIT_TRACE_PACKET=0 GIT_TRACE_CURL=0 GIT_CURL_VERBOSE=0 \
    GIT_TRACE2=0 GIT_TRACE2_EVENT=0 GIT_TRACE2_PERF=0 \
    git -c credential.helper= push \
      "https://x-access-token:${GITHUB_PUSH_TOKEN}@github.com/${TARGET_REPO}.git" \
      "HEAD:refs/heads/$branch" >/dev/null 2>&1; then
    printf '%s\n' 'Failed to push worker branch' >&2
    exit 1
  fi
fi

node - "$dir" "$RUN_ID" "$TASK_ID" "$ATTEMPT_ID" "$BASE_COMMIT" "$branch" "$agent_exit" <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [dir, runId, taskId, attemptId, baseCommit, branch, agentExit] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const manifest = {
  runId, taskId, attemptId, baseCommit,
  headCommit: git('rev-parse', 'HEAD').trim(), branch,
  changedFiles: git('diff', '--name-only', '-z', `${baseCommit}..HEAD`).split('\0').filter(Boolean),
  checks: JSON.parse(fs.readFileSync(`${dir}/checks.json`, 'utf8')),
  summary: fs.readFileSync(`${dir}/final.md`, 'utf8').slice(0, 500),
  status: Number(agentExit) === 0 ? 'complete' : 'failed',
};
fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
NODE
archil sync "$DISK" 2>/dev/null || sync "$dir"/*
exit 0
