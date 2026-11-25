// One benchmark episode: a model gets a task and the Orrery tools, works until it submits a design (or runs out
// of turns), and the submission is graded by the simulator.
import { parseProject } from '../src/lab/project';
import { SERVER_INSTRUCTIONS, TOOLS, buildAll, callTool, type ToolContext } from '../src/mcp/tools';
import type { Msg, Provider, ToolSpec } from './providers';
import { gradeTask, type Criterion, type Task } from './tasks';

/** The MCP tools as the benchmark offers them: projects travel as JSON text, there is no file access and no share link. */
export function benchTools(): ToolSpec[] {
  const tools: ToolSpec[] = TOOLS.filter((t) => t.name !== 'orrery_share').map((t) => {
    const params = JSON.parse(JSON.stringify(t.inputSchema)) as { properties?: Record<string, unknown> };
    if (params.properties?.project) {
      params.properties.project = { type: 'string', description: 'The whole project (Orrery project format v1) as JSON text.' };
      delete params.properties.path;
      (params as { required?: string[] }).required = [...new Set([...((params as { required?: string[] }).required ?? []), 'project'])];
    }
    return { name: t.name, description: t.description, parameters: params };
  });
  tools.push({
    name: 'submit',
    description: 'Submit the finished design for grading. This ends the test: call it once, when the design does what the task asks.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The final project (Orrery project format v1) as JSON text.' },
        notes: { type: 'string', description: 'Optional: anything the grader should know.' },
      },
      required: ['project'],
    },
  });
  return tools;
}

export function systemPrompt(maxTurns: number): string {
  return `${SERVER_INSTRUCTIONS}

You are taking a design test. Build what the task asks as one Orrery project: devices, wires, sketches and, when the task involves a mechanism, an assembly. Use the tools to read the formats, check, simulate and fix your design. A tester will then run your submitted project in the same simulator and operate it the way the task describes (pressing buttons, turning potentiometers, sending serial lines); it does not see your notes or your reasoning.
You have at most ${maxTurns} turns. When the design works, call submit with the final project JSON. A design that is never submitted scores nothing.`;
}

export interface EpisodeResult {
  task: string;
  model: string;
  submitted: boolean;
  pass: boolean;
  criteria: Criterion[];
  /** Model calls. */
  turns: number;
  toolCalls: Record<string, number>;
  /** orrery_simulate calls before submitting: how many times the model ran its design. */
  simulations: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  /** Why the model failed the episode (no submission, stopped calling tools). */
  error?: string;
  /** The provider failed (missing key, network, HTTP error): the episode says nothing about the model and is not scored. */
  infraError?: string;
  project?: unknown;
  transcript: Msg[];
}

export interface EpisodeOptions {
  maxTurns?: number;
  /** Called after every model turn (progress output). */
  onTurn?: (turn: number, calls: string[]) => void;
}

/** How long a tool result may be in the transcript kept on disk (the model always sees the full text). */
const KEEP_CHARS = 20_000;

export async function runEpisode(task: Task, provider: Provider, ctx: ToolContext, opts: EpisodeOptions = {}): Promise<EpisodeResult> {
  const maxTurns = opts.maxTurns ?? 30;
  const t0 = Date.now();
  const tools = benchTools();
  const system = systemPrompt(maxTurns);
  const history: Msg[] = [{ role: 'user', text: `Task: ${task.prompt}` }];
  const r: EpisodeResult = { task: task.id, model: provider.id, submitted: false, pass: false, criteria: [], turns: 0, toolCalls: {}, simulations: 0, inputTokens: 0, outputTokens: 0, wallMs: 0, transcript: [] };
  let submitted: string | undefined;
  let nudges = 0;
  try {
    while (r.turns < maxTurns && submitted === undefined) {
      let turn;
      try {
        turn = await provider.complete(system, history, tools);
      } catch (e) {
        r.infraError = (e as Error).message;
        break;
      }
      r.turns++;
      r.inputTokens += turn.usage.inputTokens;
      r.outputTokens += turn.usage.outputTokens;
      history.push({ role: 'assistant', text: turn.text, calls: turn.calls, raw: turn.raw });
      opts.onTurn?.(r.turns, turn.calls.map((c) => c.name));
      if (!turn.calls.length) {
        if (++nudges > 3) throw new Error('the model stopped calling tools');
        history.push({ role: 'user', text: 'Keep going with the tools. When the design works, call submit with the final project JSON.' });
        continue;
      }
      const results: { id: string; name: string; text: string }[] = [];
      for (const c of turn.calls) {
        r.toolCalls[c.name] = (r.toolCalls[c.name] ?? 0) + 1;
        if ('__invalidJson' in c.args) {
          results.push({ id: c.id, name: c.name, text: 'The tool arguments were not valid JSON.' });
          continue;
        }
        if (c.name === 'submit') {
          const text = typeof c.args.project === 'string' ? c.args.project : JSON.stringify(c.args.project ?? null);
          try {
            parseProject(text);
            submitted = text;
            results.push({ id: c.id, name: c.name, text: 'Submitted.' });
          } catch (e) {
            results.push({ id: c.id, name: c.name, text: `Not submitted: ${(e as Error).message}. Fix the project JSON and submit again.` });
          }
          continue;
        }
        if (c.name === 'orrery_simulate' && submitted === undefined) r.simulations++;
        const out = await callTool(c.name, c.args, ctx);
        results.push({ id: c.id, name: c.name, text: out.text });
      }
      history.push({ role: 'tool', results });
    }
    if (r.infraError) throw new Error(r.infraError);
    if (submitted === undefined) throw new Error(`no submission within ${maxTurns} turns`);
    r.submitted = true;
    r.project = JSON.parse(submitted);
    const project = parseProject(submitted);
    const { firmware, ok, builds } = await buildAll(project, ctx);
    if (!ok) {
      r.criteria = [{ name: 'the sketches compile', pass: false, detail: Object.entries(builds).filter(([, b]) => !b.ok).map(([id, b]) => `${id}: ${b.log.slice(0, 400)}`).join(' | ') }];
    } else {
      const g = await gradeTask(task, r.project, firmware);
      r.criteria = g.criteria;
      r.pass = g.pass;
    }
  } catch (e) {
    if (!r.infraError) r.error = (e as Error).message;
  }
  r.wallMs = Date.now() - t0;
  r.transcript = history.map((m) => (m.role === 'tool' ? { ...m, results: m.results.map((x) => ({ ...x, text: x.text.length > KEEP_CHARS ? `${x.text.slice(0, KEEP_CHARS)}… (cut)` : x.text })) } : { ...m, raw: undefined }));
  return r;
}
