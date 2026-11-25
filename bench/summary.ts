// Benchmark tables: pass rate, simulations and tokens per model, and which tasks each model passed.
import type { EpisodeResult } from './agent';

export interface ModelSummary {
  model: string;
  /** Scored episodes (provider failures left out). */
  episodes: number;
  /** Episodes lost to provider failures (keys, network, HTTP errors). */
  infraErrors: number;
  passed: number;
  passRate: number;
  /** Mean orrery_simulate calls in passing episodes (null when none passed). */
  meanSimulationsWhenPassed: number | null;
  meanTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** Per task: passes / episodes. */
  tasks: Record<string, { passed: number; episodes: number }>;
}

export function summarize(results: EpisodeResult[]): ModelSummary[] {
  const byModel = new Map<string, EpisodeResult[]>();
  for (const r of results) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel].map(([model, all]) => {
    const rs = all.filter((r) => !r.infraError);
    const passed = rs.filter((r) => r.pass);
    const tasks: ModelSummary['tasks'] = {};
    for (const r of rs) {
      const t = (tasks[r.task] ??= { passed: 0, episodes: 0 });
      t.episodes++;
      if (r.pass) t.passed++;
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      model,
      episodes: rs.length,
      passed: passed.length,
      infraErrors: all.length - rs.length,
      passRate: rs.length ? passed.length / rs.length : 0,
      meanSimulationsWhenPassed: mean(passed.map((r) => r.simulations)),
      meanTurns: mean(rs.map((r) => r.turns)) ?? 0,
      inputTokens: rs.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: rs.reduce((a, r) => a + r.outputTokens, 0),
      tasks,
    };
  });
}

export function summaryMarkdown(s: ModelSummary[]): string {
  const tasks = [...new Set(s.flatMap((m) => Object.keys(m.tasks)))];
  const head = `| Model | Passed | Simulations per pass | Turns | Tokens in / out | Not scored (provider errors) |\n|---|---|---|---|---|---|\n`;
  const rows = s
    .map(
      (m) =>
        `| ${m.model} | ${m.passed}/${m.episodes}${m.episodes ? ` (${Math.round(m.passRate * 100)}%)` : ''} | ${m.meanSimulationsWhenPassed === null ? '—' : m.meanSimulationsWhenPassed.toFixed(1)} | ${m.meanTurns.toFixed(1)} | ${m.inputTokens.toLocaleString('en')} / ${m.outputTokens.toLocaleString('en')} | ${m.infraErrors} |`,
    )
    .join('\n');
  const grid =
    `\n\n| Task | ${s.map((m) => m.model).join(' | ')} |\n|---|${s.map(() => '---|').join('')}\n` +
    tasks.map((t) => `| ${t} | ${s.map((m) => (m.tasks[t] ? `${m.tasks[t].passed}/${m.tasks[t].episodes}` : '—')).join(' | ')} |`).join('\n');
  return head + rows + grid + '\n';
}
