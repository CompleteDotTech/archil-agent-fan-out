import { readFileSync } from 'node:fs';
import type { Gate, GateResult, Plan, Planner, Publisher, Research, Source, TaskStatus } from '../types.js';

interface ResearchFixture {
  search: { results: Source[] };
  fetch: { content: string };
}

function readFixture<T>(filename: string): T {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/${filename}`, import.meta.url), 'utf8')) as T;
}

/** Deterministic, offline research with the same shape as Keenable responses. */
export class FixtureResearch implements Research {
  constructor(private readonly fixture: ResearchFixture = readFixture<ResearchFixture>('keenable-search.json')) {}

  async search(_query: string, opts?: { maxResults?: number; site?: string }): Promise<Source[]> {
    const sources = this.fixture.search.results.map(({ title, url, snippet }) => ({ title, url, snippet }));
    return structuredClone(opts?.maxResults === undefined ? sources : sources.slice(0, Math.max(0, opts.maxResults)));
  }

  async fetch(_url: string): Promise<string> {
    return this.fixture.fetch.content;
  }
}

/** A fresh plan per call so tests cannot accidentally mutate the shared fixture. */
export class FixturePlanner implements Planner {
  constructor(private readonly fixture: Plan = readFixture<Plan>('plan.bookmarks.json')) {}

  async plan(input: Parameters<Planner['plan']>[0]): Promise<Plan> {
    return {
      ...structuredClone(this.fixture),
      runId: input.runId,
      brief: input.brief,
      targetRepo: input.targetRepo,
      baseBranch: input.baseBranch ?? this.fixture.baseBranch,
    };
  }
}

export interface PublisherCall {
  method: keyof Publisher;
  name: keyof Publisher;
  args: unknown[];
}

/** Records calls and returns stable fake issue and PR identities. */
export class RecordingPublisher implements Publisher {
  readonly calls: PublisherCall[] = [];
  private nextIssue = 1;
  private nextPr = 100;
  private readonly issues = new Map<string, number>();

  private record(method: keyof Publisher, ...args: unknown[]): void {
    this.calls.push({ method, name: method, args: structuredClone(args) });
  }

  async publishPlan(plan: Plan): Promise<Record<string, number>> {
    this.record('publishPlan', plan);
    const result: Record<string, number> = {};
    for (const task of plan.tasks) {
      const key = JSON.stringify([plan.runId, task.id]);
      let number = this.issues.get(key);
      if (number === undefined) {
        number = this.nextIssue++;
        this.issues.set(key, number);
      }
      result[task.id] = number;
    }
    return result;
  }

  async setStatus(runId: string, taskId: string, status: TaskStatus): Promise<void> {
    this.record('setStatus', runId, taskId, status);
  }

  async openPullRequest(input: Parameters<Publisher['openPullRequest']>[0]): Promise<{ number: number; url: string }> {
    this.record('openPullRequest', input);
    const number = this.nextPr++;
    return { number, url: `https://github.com/local/demo/pull/${number}` };
  }

  async mergePullRequest(prNumber: number): Promise<{ mergeCommit: string }> {
    this.record('mergePullRequest', prNumber);
    return { mergeCommit: prNumber.toString(16).padStart(40, '0') };
  }

  async comment(runId: string, taskId: string, body: string): Promise<void> {
    this.record('comment', runId, taskId, body);
  }
}

export class PassGate implements Gate {
  async check(_input: Parameters<Gate['check']>[0]): Promise<GateResult> {
    return { pass: true, findings: [] };
  }
}
