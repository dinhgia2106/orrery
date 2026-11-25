import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/mcp/tools';
import { benchTools, runEpisode } from './agent';
import { geminiSchema, providerFor, type Msg, type Provider, type ToolCall, type Turn } from './providers';
import { solutions } from './solutions';
import { summarize, summaryMarkdown } from './summary';
import { TASKS } from './tasks';

const SOL = solutions();
const task = (id: string) => TASKS.find((t) => t.id === id)!;

/** A compiler stand-in that knows the reference sketches. */
const ctx: ToolContext = {
  compile: async (code) => {
    for (const s of Object.values(SOL)) {
      if (code === s.project.code) return { ok: true, hex: s.firmware.uno, log: '' };
      for (const [b, c] of Object.entries(s.project.sketches ?? {})) if (code === c) return { ok: true, hex: s.firmware[b], log: '' };
    }
    return { ok: false, log: 'sketch.ino:1:1: error: unknown sketch' };
  },
  readFile: async () => {
    throw new Error('no files');
  },
};

/** A model that plays a fixed script of tool calls and records what it was shown. */
function scripted(script: (ToolCall[] | string)[]): Provider & { seen: Msg[][] } {
  const seen: Msg[][] = [];
  let i = 0;
  return {
    id: 'script:test',
    seen,
    async complete(_system, history): Promise<Turn> {
      seen.push(JSON.parse(JSON.stringify(history)));
      const step = script[Math.min(i++, script.length - 1)];
      return typeof step === 'string' ? { text: step, calls: [], usage: { inputTokens: 10, outputTokens: 1 } } : { text: '', calls: step, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const json = (x: unknown) => JSON.stringify(x);

describe('benchmark episodes', () => {
  it('a model that checks, simulates and submits a correct design passes', async () => {
    const p = SOL['blink-2hz'].project;
    const model = scripted([
      [{ id: '1', name: 'orrery_check', args: { project: json(p) } }],
      [{ id: '2', name: 'orrery_simulate', args: { project: json(p), seconds: 1 } }],
      [{ id: '3', name: 'submit', args: { project: json(p) } }],
    ]);
    const r = await runEpisode(task('blink-2hz'), model, ctx);
    expect(r.error).toBeUndefined();
    expect(r.pass).toBe(true);
    expect(r).toMatchObject({ submitted: true, turns: 3, simulations: 1, toolCalls: { orrery_check: 1, orrery_simulate: 1, submit: 1 }, inputTokens: 30 });
    // the model saw the simulator's report as the result of its call
    const toolMsg = model.seen[2].find((m) => m.role === 'tool' && m.results[0].name === 'orrery_simulate') as Extract<Msg, { role: 'tool' }>;
    expect(JSON.parse(toolMsg.results[0].text).ok).toBe(true);
  });

  it('a wrong design is submitted and graded as failing, with the reasons', async () => {
    const p = { ...SOL['blink-2hz'].project, code: SOL['button-toggle-led'].project.code };
    const r = await runEpisode(task('blink-2hz'), scripted([[{ id: '1', name: 'submit', args: { project: json(p) } }]]), ctx);
    expect(r.submitted).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.criteria.find((c) => !c.pass)?.name).toBe('blinks');
  });

  it('a submission that does not compile fails on that', async () => {
    const p = { ...SOL['blink-2hz'].project, code: 'void setup() { nope(); }' };
    const r = await runEpisode(task('blink-2hz'), scripted([[{ id: '1', name: 'submit', args: { project: json(p) } }]]), ctx);
    expect(r.criteria).toEqual([expect.objectContaining({ name: 'the sketches compile', pass: false })]);
  });

  it('a submission that is not a project is refused and the model may try again', async () => {
    const model = scripted([[{ id: '1', name: 'submit', args: { project: '{"version":9}' } }], [{ id: '2', name: 'submit', args: { project: json(SOL['blink-2hz'].project) } }]]);
    const r = await runEpisode(task('blink-2hz'), model, ctx);
    expect(r.turns).toBe(2);
    expect(r.pass).toBe(true);
    const refusal = model.seen[1].at(-1) as Extract<Msg, { role: 'tool' }>;
    expect(refusal.results[0].text).toMatch(/^Not submitted/);
  });

  it('running out of turns, or of tool calls, scores nothing', async () => {
    const busy = await runEpisode(task('blink-2hz'), scripted([[{ id: 'x', name: 'orrery_guide', args: { topic: 'overview' } }]]), ctx, { maxTurns: 4 });
    expect(busy.error).toMatch(/no submission within 4 turns/);
    expect(busy.pass).toBe(false);
    const chatty = await runEpisode(task('blink-2hz'), scripted(['I think it works.']), ctx);
    expect(chatty.error).toMatch(/stopped calling tools/);
    expect(chatty.turns).toBe(4);
  });

  it('the bench tools take projects as JSON text and add submit', () => {
    const tools = benchTools();
    expect(tools.map((t) => t.name)).toEqual(['orrery_guide', 'orrery_get_template', 'orrery_check', 'orrery_compile', 'orrery_simulate', 'submit']);
    const sim = tools.find((t) => t.name === 'orrery_simulate')!.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(sim.properties.project.type).toBe('string');
    expect(sim.properties.path).toBeUndefined();
    expect(sim.required).toEqual(['seconds', 'project']);
  });

  it('summaries count passes and simulations per model', () => {
    const base = { submitted: true, criteria: [], turns: 4, toolCalls: {}, inputTokens: 100, outputTokens: 10, wallMs: 1, transcript: [] };
    const s = summarize([
      { ...base, task: 'a', model: 'm1', pass: true, simulations: 2 },
      { ...base, task: 'b', model: 'm1', pass: false, simulations: 5 },
      { ...base, task: 'a', model: 'm2', pass: false, simulations: 1 },
    ]);
    expect(s[0]).toMatchObject({ model: 'm1', passed: 1, episodes: 2, passRate: 0.5, meanSimulationsWhenPassed: 2, inputTokens: 200 });
    expect(s[1].meanSimulationsWhenPassed).toBeNull();
    expect(summaryMarkdown(s)).toMatch(/\| m1 \| 1\/2 \(50%\) \| 2\.0 \|/);
    const withInfra = summarize([{ ...base, task: 'a', model: 'm3', pass: false, simulations: 0, infraError: '429' }]);
    expect(withInfra[0]).toMatchObject({ episodes: 0, infraErrors: 1, passRate: 0 });
  });

  it('a provider failure is not scored against the model', async () => {
    const failing: Provider = {
      id: 'down:test',
      complete: async () => {
        throw new Error('503 from example.test');
      },
    };
    const r = await runEpisode(task('blink-2hz'), failing, ctx);
    expect(r).toMatchObject({ infraError: '503 from example.test', pass: false, turns: 0 });
    expect(r.error).toBeUndefined();
  });
});

describe('providers speak each API', () => {
  const history: Msg[] = [
    { role: 'user', text: 'Task: blink' },
    { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'orrery_guide', args: { topic: 'overview' } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'orrery_guide', text: 'the guide' }] },
  ];
  const tools = benchTools();
  let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const stub = (response: unknown) => {
    captured = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
      captured.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(response), { status: 200 });
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('Gemini schemas lose what the API does not take', () => {
    expect(geminiSchema({ type: ['object', 'string'], properties: { s: { type: 'number', exclusiveMinimum: 0 }, e: { enum: ['a'] } } })).toEqual({
      type: 'string',
      properties: { s: { type: 'number', minimum: 0 }, e: { enum: ['a'], type: 'string' } },
    });
  });

  it('Vertex with an API key: project path, functionDeclarations, function responses, thought parts kept out of the text', async () => {
    vi.stubEnv('VERTEX_API_KEY', 'k');
    vi.stubEnv('VERTEX_PROJECT', 'p1');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    vi.stubEnv('VERTEX_ACCESS_TOKEN', '');
    stub({
      candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'ok' }, { functionCall: { name: 'submit', args: { project: '{}' } } }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
    });
    const turn = await providerFor('vertex:gemini-2.5-pro').complete('sys', history, tools);
    const c = captured[0];
    expect(c.url).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent');
    expect(c.headers['x-goog-api-key']).toBe('k');
    const contents = c.body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents.map((x) => x.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2].parts[0]).toEqual({ functionResponse: { id: 'c1', name: 'orrery_guide', response: { result: 'the guide' } } });
    expect((c.body.tools as { functionDeclarations: unknown[] }[])[0].functionDeclarations).toHaveLength(tools.length);
    expect(turn.text).toBe('ok');
    expect(turn.calls).toEqual([expect.objectContaining({ name: 'submit', args: { project: '{}' } })]);
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 5 });
    expect(turn.raw).toBeDefined(); // replayed verbatim on the next turn (thought signatures)
  });

  it('OpenAI-compatible: tool_calls out, role "tool" results in, arguments parsed', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.test/v1/');
    stub({ choices: [{ message: { content: null, tool_calls: [{ id: 't9', function: { name: 'orrery_check', arguments: '{"project":"{}"}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    const turn = await providerFor('openai:qwen3-coder').complete('sys', history, tools);
    expect(captured[0].url).toBe('https://example.test/v1/chat/completions');
    const msgs = captured[0].body.messages as Record<string, unknown>[];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'the guide' });
    expect(turn.calls).toEqual([{ id: 't9', name: 'orrery_check', args: { project: '{}' } }]);
  });

  it('Anthropic: tool_use blocks out, tool_result blocks in', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    stub({ content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'submit', input: { project: '{}' } }], usage: { input_tokens: 9, output_tokens: 1 } });
    const turn = await providerFor('anthropic:some-model').complete('sys', history, tools);
    expect(captured[0].headers['anthropic-version']).toBe('2023-06-01');
    const msgs = captured[0].body.messages as { role: string; content: unknown }[];
    expect(msgs[1].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'orrery_guide', input: { topic: 'overview' } }]);
    expect(msgs[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'the guide' }]);
    expect(turn).toMatchObject({ text: 'hi', calls: [{ id: 'tu1', name: 'submit', args: { project: '{}' } }] });
  });

  it('unknown providers and missing keys say what to set', async () => {
    expect(() => providerFor('foo:bar')).toThrow(/unknown provider/);
    vi.stubEnv('GEMINI_API_KEY', '');
    await expect(providerFor('gemini:x').complete('s', history, tools)).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });
});
