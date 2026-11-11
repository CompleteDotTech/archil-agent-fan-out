import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { compose } from './compose.js';

const { values } = parseArgs({ options: {
  brief: { type: 'string' }, repo: { type: 'string' }, port: { type: 'string', default: '3000' },
  'dry-run': { type: 'boolean' }, 'fake-agent': { type: 'boolean' },
  'fixture-plan': { type: 'boolean' }, local: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help || !values.brief || !values.repo) {
  console.log('Usage: npm run swarm -- --brief <file> --repo <owner/name> [--dry-run] [--fake-agent] [--fixture-plan] [--local] [--port 3000]');
  if (!values.help) process.exitCode = 1;
} else {
  try {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('Repository must be owner/name');
    await compose({ brief: await readFile(values.brief, 'utf8'), targetRepo: values.repo, port,
      local: !!values.local, fakeAgent: !!values['fake-agent'], fixturePlan: !!values['fixture-plan'],
      dryRun: !!values['dry-run'] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
