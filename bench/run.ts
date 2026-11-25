/// <reference types="node" />
// Runs the benchmark: every model on every task, graded by the simulator.
//
//   npm run bench -- --model vertex:gemini-2.5-pro [--model openai:gpt-5 …] [--task arm-lift …] [--repeat 3]
//
// Sketches compile with the arduino-cli on this machine. Each episode is saved to bench/runs/<time>/ (full
// transcript, the submitted project and every grading criterion), with summary.json and summary.md for the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compile } from '../scripts/arduino-cli.mjs';
import type { ToolContext } from '../src/mcp/tools';
import { runEpisode, type EpisodeResult } from './agent';
import { providerFor } from './providers';
import { TASKS } from './tasks';
import { summarize, summaryMarkdown } from './summary';

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    task: { type: 'string', multiple: true },
    repeat: { type: 'string', default: '1' },
    'max-turns': { type: 'string', default: '30' },
    'max-tokens': { type: 'string' },
    temperature: { type: 'string' },
    out: { type: 'string', default: 'bench/runs' },
    list: { type: 'boolean' },
  },
});

if (values.list) {
  for (const t of TASKS) console.log(`${t.id.padEnd(20)} ${t.title}`);
  process.exit(0);
}
if (!values.model?.length) {
  console.error('Give at least one --model provider:model (vertex:, gemini:, openai:, anthropic:). --list shows the tasks.');
  process.exit(2);
}
const tasks = values.task?.length ? TASKS.filter((t) => values.task!.includes(t.id)) : TASKS;
const unknown = (values.task ?? []).filter((id) => !TASKS.some((t) => t.id === id));
if (unknown.length) {
  console.error(`Unknown task(s): ${unknown.join(', ')}. --list shows the tasks.`);
  process.exit(2);
}
const repeat = Math.max(1, Number(values.repeat));
const maxTurns = Math.max(1, Number(values['max-turns']));
const opts = {
  maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : undefined,
  temperature: values.temperature !== undefined ? Number(values.temperature) : undefined,
};
const providers = values.model.map((m) => providerFor(m, opts));

const ctx: ToolContext = { compile, readFile: (p) => readFile(p, 'utf8') };
const dir = join(values.out!, new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });
const slug = (s: string) => s.replace(/[^\w.-]+/g, '_');

const results: EpisodeResult[] = [];
for (const provider of providers) {
  let broken = false;
  for (const task of tasks) {
    for (let k = 1; k <= repeat && !broken; k++) {
      process.stdout.write(`${provider.id}  ${task.id}  #${k}  `);
      const r = await runEpisode(task, provider, ctx, { maxTurns, onTurn: () => process.stdout.write('.') });
      results.push(r);
      const sub = join(dir, slug(provider.id));
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${task.id}-${k}.json`), JSON.stringify(r, null, 1));
      if (r.infraError) {
        console.log(` NOT SCORED  provider error: ${r.infraError}`);
        // a provider that fails before its first answer is misconfigured: skip its remaining episodes
        if (r.turns === 0) {
          console.log(`Skipping the rest of ${provider.id}.`);
          broken = true;
        }
        continue;
      }
      const why = r.error ?? r.criteria.filter((c) => !c.pass).map((c) => c.name).join('; ');
      console.log(` ${r.pass ? 'PASS' : 'FAIL'}  turns ${r.turns}, simulations ${r.simulations}, ${(r.wallMs / 1000).toFixed(0)} s${r.pass ? '' : `  — ${why}`}`);
    }
  }
}

const summary = summarize(results);
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(dir, 'summary.md'), summaryMarkdown(summary));
console.log(`\n${summaryMarkdown(summary)}\nSaved to ${dir}`);
