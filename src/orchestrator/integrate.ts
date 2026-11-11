import type {
  IntegratorHooks, Manifest, Publisher, SandboxRunner, SharedDisk, Store, SwarmEvent, TaskSpec,
} from '../contracts/types.js';

interface Ports {
  publisher: Publisher;
  store: Store;
  sandboxes: SandboxRunner;
  disk: SharedDisk;
  log?: (message: string) => void;
}

interface Options {
  runId: string;
  integrationSandboxId: string;
  finalVerify: string[];
  timeoutMs?: number;
  /** Composition emits delivery only after exporting the app and evidence. */
  deferRunDone?: boolean;
}

type PullRequest = { number: number; url: string };
type Entry = { task: TaskSpec; manifest: Manifest; pr: PullRequest };
interface RadarEvidence {
  runId: string; datasetId: string; researchMode: string;
  events: { id: string; name: string; fields: Record<string, { status: string; value: string | null; findingIds: string[] }> }[];
  findings: { id: string; eventId: string; field: string; sourceId: string; value: string }[];
  sources: { id: string; url: string; retrievedAt: string; contentPath: string }[];
  roles: { role: string; status: string; findings: unknown[]; errors: string[] }[];
}

const refresh = 'cd /repo && git fetch origin && git checkout -B main origin/main';
const tail = (output: string): string => output.trimEnd().split('\n').slice(-40).join('\n').slice(-12_000);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const inline = (value: unknown): string => String(value).replace(/[\r\n]+/g, ' ');
// Indentation keeps arbitrary command output from closing a Markdown code fence.
const codeBlock = (value: string): string => value.split('\n').map(line => `    ${line}`).join('\n');

/** One promise chain owns the integration sandbox; failures never overtake queued work. */
export function createIntegrator(ports: Ports, opts: Options): IntegratorHooks & {
  idle(): Promise<void>;
  writeReport(): Promise<string>;
} {
  const startedAt = new Date().toISOString();
  const entries = new Map<string, Entry>();
  const queueErrors: unknown[] = [];
  let pending = Promise.resolve();

  async function event(type: string, data: Record<string, unknown>, entry?: Entry): Promise<void> {
    await ports.store.appendEvent({
      runId: opts.runId, at: new Date().toISOString(), type, data,
      ...(entry ? { taskId: entry.task.id, attemptId: entry.manifest.attemptId } : {}),
    });
  }

  async function integrate(entry: Entry): Promise<void> {
    const output: string[] = [];
    let pass = true;
    try {
      const merged = await ports.publisher.mergePullRequest(entry.pr.number);
      await event('pr.merged', { number: entry.pr.number, mergeCommit: merged.mergeCommit }, entry);
      for (const cmd of [refresh, ...opts.finalVerify.map(cmd => `cd /repo && ${cmd}`)]) {
        const result = await ports.sandboxes.exec(opts.integrationSandboxId, cmd, {
          timeoutMs: opts.timeoutMs ?? 120_000,
        });
        output.push(`$ ${cmd}\nexit code: ${result.exitCode}\n${tail(`${result.stdout}\n${result.stderr}`)}`);
        if (result.exitCode !== 0) {
          pass = false;
          if (cmd === refresh) break;
        }
      }
    } catch (error) {
      pass = false;
      output.push(message(error));
    }

    const summary = tail(output.join('\n\n'));
    // Persist a terminal state even if GitHub's comment/status API is unavailable.
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    if (!pass) {
      await attempt(() => ports.publisher.comment(opts.runId, entry.task.id,
        `Integration failed for PR #${entry.pr.number}.\n\n${codeBlock(summary)}`));
    }
    const status = pass ? 'done' : 'blocked';
    await attempt(() => ports.store.setTaskStatus(opts.runId, entry.task.id, status));
    await attempt(() => ports.publisher.setStatus(opts.runId, entry.task.id, status));
    await attempt(() => event('task.status', { status }, entry));
    await attempt(() => event('integration.result', { pass, output: summary }, entry));
    ports.log?.(`Integration ${entry.task.id}: ${status}`);
    if (failures.length) throw new AggregateError(failures, `Failed to record integration for ${entry.task.id}`);
  }

  async function idle(): Promise<void> {
    // Include work added while a caller is waiting for the current queue.
    let observed: Promise<void>;
    do { observed = pending; await observed; } while (observed !== pending);
    if (queueErrors.length) throw new AggregateError(queueErrors, 'Integration reporting failed');
  }

  async function writeReport(): Promise<string> {
    await idle();
    const [plan, statuses, issues, attempts, indexedEvents] = await Promise.all([
      ports.store.getPlan(opts.runId), ports.store.getTaskStatuses(opts.runId),
      ports.store.getIssueNumbers(opts.runId), ports.store.listAttempts(opts.runId),
      ports.store.listEvents(opts.runId),
    ]);
    const events = indexedEvents.map(item => item.event);
    const radarRaw = await ports.disk.read(`/research/${opts.runId}/dataset.json`);
    let radar: RadarEvidence | undefined;
    if (radarRaw) {
      try {
        const value = JSON.parse(radarRaw) as RadarEvidence;
        if (value.runId === opts.runId && Array.isArray(value.events) && Array.isArray(value.findings)
          && Array.isArray(value.sources) && Array.isArray(value.roles)) radar = value;
      } catch { /* Invalid research is reported, never inferred to be verified. */ }
    }
    const results = events.filter(item => item.type === 'integration.result');
    const finalResults = radarRaw ? results.filter(item => item.data.final === true) : results;
    const finalResult = finalResults.length === 0 ? 'Not run' : finalResults.every(item => item.data.pass === true) ? 'PASS' : 'FAIL';
    const start = events.find(item => item.type === 'run.started')?.at
      ?? attempts.map(item => item.startedAt).sort()[0] ?? startedAt;
    const lines = [
      `# Delivery report: ${inline(opts.runId)}`, '',
      `Started: ${start}`, `Ended: ${new Date().toISOString()}`, '',
      `Final test result: **${finalResult}**`, '',
      `Final verification commands: ${opts.finalVerify.length ? opts.finalVerify.map(inline).join('; ') : '(none configured)'}`, '',
    ];
    const tasks = new Map((plan?.tasks ?? []).map(task => [task.id, task]));
    for (const entry of entries.values()) tasks.set(entry.task.id, entry.task);
    const codingTasks = [...tasks.values()].filter(task => task.kind === 'task');
    const delivered = finalResult === 'PASS' && (radarRaw
      ? codingTasks.length > 0 && codingTasks.every(task => statuses[task.id] === 'done')
      : !Object.values(statuses).includes('blocked'));
    lines.push(`Delivery status: **${delivered ? 'complete' : 'incomplete'}**`, '');
    if (radarRaw) lines.push(...radarReport(radar, events, tasks));
    for (const task of tasks.values()) {
      const taskEvents = events.filter(item => item.taskId === task.id);
      const taskAttempts = attempts.filter(item => item.taskId === task.id).sort((a, b) => a.n - b.n);
      const prEvent = taskEvents.filter(item => item.type === 'pr.opened').at(-1);
      const pr = entries.get(task.id)?.pr;
      const prNumber = pr?.number ?? prEvent?.data.number
        ?? taskEvents.filter(item => item.type === 'pr.merged').at(-1)?.data.number;
      const prUrl = pr?.url ?? prEvent?.data.url;
      const issue = issues[task.id];
      const issueText = issue === undefined ? 'Not published' : plan
        ? `[#${issue}](https://github.com/${plan.targetRepo}/issues/${issue})` : `#${issue}`;
      const prText = prNumber === undefined ? 'Not opened' : typeof prUrl === 'string'
        ? `[#${inline(prNumber)}](${prUrl})` : `#${inline(prNumber)}`;
      const findings = [
        ...taskAttempts.flatMap(item => item.findings ?? []),
        ...taskEvents.filter(item => item.type === 'gate.result').flatMap(item =>
          Array.isArray(item.data.findings) ? item.data.findings.filter((f): f is string => typeof f === 'string') : []),
      ];
      const count = await sourceCount(task.id, taskEvents);
      lines.push(`## ${inline(task.id)}: ${inline(task.title)}`, '',
        `Status: ${statuses[task.id] ?? 'unknown'}`, `Issue: ${issueText}`, `PR: ${prText}`,
        `Attempts: ${taskAttempts.length}`, `Research source count: ${count}`, '',
        'Gate findings:', '', ...([...new Set(findings)].map(f => `- ${inline(f)}`)),
        ...(findings.length ? [] : ['- None recorded']), '');
      for (const attempt of taskAttempts) {
        lines.push(`- ${inline(attempt.attemptId)}: ${attempt.state}; started ${attempt.startedAt}`);
        if (radarRaw) {
          const receiptPath = `/runs/${opts.runId}/${task.id}/${attempt.attemptId}/research-receipt.json`;
          const receiptRaw = await ports.disk.read(receiptPath);
          let receipt: Record<string, unknown> | undefined;
          try { if (receiptRaw) receipt = JSON.parse(receiptRaw) as Record<string, unknown>; } catch { /* Show absence below. */ }
          const matches = receipt?.runId === opts.runId && receipt?.taskId === task.id
            && receipt?.datasetId === radar?.datasetId && receipt?.consumed === true;
          lines.push(matches
            ? `  - [Research receipt](${receiptPath}): dataset ${inline(receipt!.datasetId)}, SHA256 ${inline(receipt!.sha256)}, events ${inline(receipt!.eventCount)}. The worker harness read and supplied this input; this does not prove every claim was used.`
            : '  - Matching research consumption receipt: not recorded.');
        }
      }
      if (taskAttempts.length) lines.push('');
    }
    lines.push('## Integration results', '');
    if (!results.length) lines.push('No integration checks recorded.', '');
    for (const result of results) {
      lines.push(`### ${inline(result.taskId ?? 'run')}: ${result.data.pass === true ? 'PASS' : 'FAIL'}`, '',
        codeBlock(String(result.data.output ?? '')), '');
    }
    const path = `/delivery/${opts.runId}/report.md`;
    await ports.disk.write(path, lines.join('\n'));
    await event(delivered && !opts.deferRunDone ? 'run.done' : 'report.written', { reportPath: path, success: delivered });
    return path;
  }

  function radarReport(radar: RadarEvidence | undefined, events: SwarmEvent[], tasks: Map<string, TaskSpec>): string[] {
    if (!radar) return ['## Radar evidence', '', 'Research artifact exists but is invalid or belongs to another run. No research verification claimed.', ''];
    const mode = events.find(item => item.type === 'run.started')?.data ?? {};
    const lines = ['## Radar evidence', '',
      `Dataset: [${inline(radar.datasetId)}](/research/${opts.runId}/dataset.json)`,
      `Research mode: ${inline(radar.researchMode)}; coding agent: ${inline(mode.agent ?? 'not recorded')}; infrastructure: ${inline(mode.infrastructure ?? 'not recorded')}; run mode: ${inline(mode.mode ?? 'not recorded')}.`,
      `Plan mode: ${inline(mode.planMode ?? 'not recorded')}. Event content is research-derived; task boundaries and product design come from the plan.`,
      `Events in dataset: ${radar.events.length}. Five candidates alone do not establish that every field is verified.`, '',
      '### Research roles', ''];
    for (const role of radar.roles) {
      lines.push(`- [${inline(role.role)}](/research/${opts.runId}/roles/${encodeURIComponent(role.role)}/findings.json): ${inline(role.status)}; ${role.findings.length} findings; ${role.errors.length} errors.`);
      for (const error of role.errors) lines.push(`  - ${inline(error)}`);
    }
    lines.push('', '### Source to deadline implementation', '');
    const filterTask = tasks.get('T4');
    const taskEvents = events.filter(item => item.taskId === 'T4');
    const merge = taskEvents.find(item => item.type === 'pr.merged' && taskEvents.some(gate =>
      gate.type === 'gate.result' && gate.data.pass === true && gate.attemptId === item.attemptId
      && events.indexOf(gate) < events.indexOf(item)));
    const opened = merge && taskEvents.find(item => item.type === 'pr.opened' && item.data.number === merge.data.number);
    for (const event of radar.events) {
      const claim = event.fields.deadline;
      if (!claim || claim.status !== 'verified' || !claim.value) {
        lines.push(`- ${inline(event.name)}: deadline ${inline(claim?.status ?? 'not recorded')}; no verified deadline chain claimed.`);
        continue;
      }
      const findings = radar.findings.filter(item => claim.findingIds.includes(item.id) && item.eventId === event.id && item.field === 'deadline' && item.value === claim.value);
      for (const finding of findings) {
        const source = radar.sources.find(item => item.id === finding.sourceId);
        if (!source) continue;
        lines.push(`- ${inline(event.name)}: [official source](${source.url}) → [archived page](${source.contentPath}) (retrieved ${inline(source.retrievedAt)}) → finding ${inline(finding.id)} → deadline ${inline(claim.value)} → ${filterTask ? `T4: ${inline(filterTask.title)}` : 'filter task not recorded'}.`);
      }
    }
    lines.push(`Filter verification commands: ${filterTask?.verify.map(inline).join('; ') || 'not recorded'}.`,
      merge ? `Verified PR: ${typeof opened?.data.url === 'string' ? `[#${inline(merge.data.number)}](${opened.data.url})` : `#${inline(merge.data.number)}`}; passing gate and subsequent merge recorded for attempt ${inline(merge.attemptId ?? 'unspecified')}.`
        : 'Verified PR: not recorded (requires a passing gate followed by a matching merged PR).',
      'Working-app behavior and citation clicks require the separate browser verification evidence; a merged PR alone does not establish them.', '');
    return lines;
  }

  async function sourceCount(taskId: string, events: SwarmEvent[]): Promise<number> {
    const research = events.filter(item => item.type === 'research.done').at(-1);
    if (typeof research?.data.count === 'number') return research.data.count;
    const raw = await ports.disk.read(`/research/${opts.runId}/${taskId}/sources.json`);
    if (!raw) return 0;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && typeof parsed === 'object' && 'sources' in parsed && Array.isArray(parsed.sources)) {
        return parsed.sources.length;
      }
    } catch { /* Missing or malformed research must not prevent delivery. */ }
    return 0;
  }

  return {
    enqueue(task, manifest, pr) {
      const entry = structuredClone({ task, manifest, pr });
      entries.set(task.id, entry);
      pending = pending.then(() => integrate(entry)).catch(error => { queueErrors.push(error); });
    },
    idle,
    writeReport,
  };
}
