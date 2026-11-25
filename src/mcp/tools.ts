// The Orrery tools an agent calls over MCP: read the formats, start from a template, check a project, compile
// its sketches, run it (firmware + circuit + mechanism) and hand back a link. Kept apart from the stdio server
// (server.ts) so tests can call them directly.
import assemblyDoc from '../../docs/assembly-format.md?raw';
import projectDoc from '../../docs/project-format.md?raw';
import { runProject, type BenchInput, type RunReport } from '../headless/run';
import { DEVICES, type DeviceKind } from '../lab/devices';
import { LabSimulation } from '../lab/labsim';
import { parseProject, sketchOf, type Project } from '../lab/project';
import { PUBLIC_URL, shareUrl } from '../lab/share';
import { TEMPLATES } from '../lab/templates';
import { jointValues, validateAssembly } from '../mech/assembly';
import { CLASH_MIN_MM3, interference, massProperties } from '../mech/physics';
import { CATALOG } from '../sim/catalog';

/** Prebuilt firmware of the templates, by file name ("servo-sweep"). */
const PREBUILT: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../../public/examples/*.hex', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(([path, hex]) => [
    path.replace(/^.*\/(.*)\.hex$/, '$1'),
    hex,
  ]),
);

/** Template sketches whose prebuilt firmware is shipped: the exact sketch text → Intel HEX. */
const PREBUILT_BY_CODE = new Map<string, string>();
for (const t of TEMPLATES) {
  for (const [board, name] of Object.entries({ uno: t.hex, ...t.hexes })) {
    const hex = PREBUILT[name];
    if (hex) PREBUILT_BY_CODE.set(sketchOf(t.project, board), hex);
  }
}

export type CompileFn = (code: string) => Promise<{ ok: true; hex: string; log: string } | { ok: false; log: string }>;

export interface ToolContext {
  compile: CompileFn;
  readFile: (path: string) => Promise<string>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** Longest simulated run one call may ask for, s: a slow bench (17 servos, dynamics) takes a while per second. */
export const MAX_SECONDS = 60;
const MAX_PROJECT_CHARS = 4 * 1024 * 1024;
const MAX_LOG_CHARS = 4000;
const MAX_SERIAL_CHARS = 4000;

const PROJECT_ARGS = {
  project: { type: ['object', 'string'], description: 'The project (Orrery project format v1) as a JSON object or JSON text. Give this or "path".' },
  path: { type: 'string', description: 'Path to a .orrery.json project file on this machine. Give this or "project".' },
} as const;

const INPUT_SCHEMA = {
  type: 'object',
  description: 'Something done to the bench at simulated time t (s): exactly one of press, pot, serial, drop.',
  properties: {
    t: { type: 'number', minimum: 0 },
    press: { type: 'string', description: 'Button id to press; released after holdMs.' },
    holdMs: { type: 'number', minimum: 0, description: 'How long the button is held, ms (default 100).' },
    pot: { type: 'string', description: 'Potentiometer id to turn.' },
    value: { type: 'number', minimum: 0, maximum: 1, description: 'Wiper position for "pot", 0–1.' },
    serial: { type: 'string', description: 'Text typed into a board’s serial port.' },
    board: { type: 'string', description: 'Board id for "serial" (default: the first board).' },
    drop: { enum: ['ball', 'box'], description: 'Drop a loose PLA ball or cube (needs mechanics "dynamic").' },
    sizeMm: { type: 'number', exclusiveMinimum: 0 },
    at: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Centre of the dropped object, mm, bench frame (Y up).' },
  },
  required: ['t'],
} as const;

export const TOOLS = [
  {
    name: 'orrery_guide',
    description:
      'Read how Orrery works before designing: "overview" (workflow and conventions), "project-format" (bench JSON: devices, wires, sketches), "assembly-format" (3D mechanism JSON), "devices" (every part with its real part number, pins and props), "templates" (working examples to start from).',
    inputSchema: {
      type: 'object',
      properties: { topic: { enum: ['overview', 'project-format', 'assembly-format', 'devices', 'templates'] } },
      required: ['topic'],
    },
  },
  {
    name: 'orrery_get_template',
    description: 'Return a working template project (wired, with sketch and, for some, a mechanism) as JSON, to start from or learn the format.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Template id from orrery_guide "templates".' } }, required: ['id'] },
  },
  {
    name: 'orrery_check',
    description:
      'Check a project without running firmware: devices and wires that would be ignored (unknown kinds, pins that do not exist), shorts and supply mistakes, assembly validation errors, the mechanism’s mass and parts overlapping in the home pose. Fast; run it after every edit.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARGS } },
  },
  {
    name: 'orrery_compile',
    description: 'Compile every board’s sketch for the Arduino Uno with arduino-cli on this machine and return the compiler messages per board.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARGS } },
  },
  {
    name: 'orrery_simulate',
    description: `Compile the sketches and run the bench: the real firmware cycle by cycle, the wired circuit, and the mechanism (gravity loads on servos/steppers and collisions, or full rigid-body dynamics). Returns ok, problems, every check with when it appeared, serial output, sampled device states and joint angles, each actuator’s peak load as a share of its stall/holding torque, clashes and tendon readings. Up to ${MAX_SECONDS} s of simulated time.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARGS,
        seconds: { type: 'number', exclusiveMinimum: 0, maximum: MAX_SECONDS, description: 'Simulated time to run, s.' },
        inputs: { type: 'array', items: INPUT_SCHEMA, description: 'Timed button presses, pot moves, serial input and dropped objects.' },
        mechanics: { enum: ['off', 'static', 'dynamic'], description: '"static" (default with an assembly): gravity loads + clash checks. "dynamic": Rapier rigid-body physics as well. "off": electronics only.' },
        sampleEvery: { type: 'number', minimum: 0.001, description: 'Sampling interval, s (default 0.05).' },
        maxSamples: { type: 'integer', minimum: 2, maximum: 1000, description: 'Samples returned, spread evenly over the run (default 40).' },
        watch: { type: 'array', items: { type: 'string' }, description: 'Device ids to include in samples (default: all).' },
      },
      required: ['seconds'],
    },
  },
  {
    name: 'orrery_share',
    description: 'Compile the sketches and return a link that opens this exact bench, firmware included, in the Orrery web app (no account, no compiler needed to run it). Give it to the user so they can see and play with the design.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_ARGS, base: { type: 'string', description: `Orrery page to link to (default ${PUBLIC_URL}).` } },
    },
  },
] as const;

export const SERVER_INSTRUCTIONS = `Orrery simulates robot and IoT builds before they are wired: real Arduino Uno firmware runs cycle by cycle against a solved circuit of real parts (SG90 servos, A4988 + NEMA 17 steppers, buttons, pots, LEDs, supplies) and a 3D mechanism with masses, gravity, torque limits and collisions.
Workflow: orrery_guide (overview, then the formats) → start from orrery_get_template or write a project → orrery_check → orrery_simulate with inputs that exercise the design → fix what the report says, repeat → orrery_share to give the user a link.
A design is done when orrery_simulate returns ok: true AND the samples show it does what was asked; ok only means nothing is broken.`;

const OVERVIEW = `# Orrery for agents

${SERVER_INSTRUCTIONS}

## Conventions
- A project is JSON (topic "project-format"): devices with ids, wires "deviceId.PIN" ↔ "deviceId.PIN", the sketch of board "uno" in "code", others in "sketches".
- Mechanisms are the Orrery Assembly Format (topic "assembly-format"), in millimetres and degrees, Y up. Joints are driven by bench devices by id: a servo "servo1" on the bench drives {"drive":{"device":"servo1",...}} and must be in "mounts".
- Wire every part fully: servo SIG to a digital pin (Servo.h drives any of them), V+ to a 5 V supply, GND common with the board. Several moving SG90s can draw more than the Uno's 500 mA USB polyfuse (Orrery checks the rail): use a bench supply ("psu", volts 5) and join its − to the board's GND.
- Sketches compile with the arduino-cli on the user's machine for arduino:avr:uno (libraries: whatever is installed there, e.g. arduino-cli lib install Servo). Templates whose sketch is unchanged use their prebuilt firmware.

## Reading a simulation report
- ok / problems: error-level checks, overlapping parts, actuators loaded past their limit. Warnings are listed in checks but do not clear ok.
- samples: device states (servo angle, stepper angle, LED mA, button, pot) and joint angles over time; check them against what the design should do.
- mechanics.actuators[].peakShare: highest load as a share of the SG90 stall / NEMA 17 holding torque. Above 1 the actuator cannot hold it; keep a margin.
- mechanics.clashes: parts that overlap in a sampled pose. mechanics.tendons: minSlackMm < 0 means the geometry asks a line to stretch.
- Numbers come from the parts' datasheets; where Orrery approximates, the check says so.`;

function json(x: unknown): string {
  return JSON.stringify(x, null, 1);
}

function fail(msg: string): ToolResult {
  return { text: msg, isError: true };
}

function devicesReference() {
  return Object.values(DEVICES).map((d) => {
    const c = CATALOG[d.catalog];
    return {
      kind: d.kind,
      part: c ? `${c.manufacturer ?? ''} ${c.mpn ?? ''} — ${c.name}`.trim() : d.title,
      pins: d.pins.filter((p) => !p.dummy).map((p) => p.name),
      notModelled: d.pins.filter((p) => p.dummy).map((p) => p.name),
      joinedInside: d.internal ?? [],
      props: d.defaults ?? {},
      specs: c?.specs ?? [],
      notes: c?.notes ?? [],
    };
  });
}

/** What parseProject would silently drop or ignore, in words an agent can act on. */
export function lintProject(raw: unknown, project: Project): string[] {
  const out: string[] = [];
  const r = raw as { devices?: unknown[]; wires?: unknown[]; sketches?: Record<string, unknown>; assembly?: unknown };
  const kinds = Object.keys(DEVICES).join(', ');
  const kept = new Set(project.devices.map((d) => d.id));
  (r.devices ?? []).forEach((d, i) => {
    const dev = d as { id?: unknown; kind?: unknown };
    if (typeof dev?.id === 'string' && kept.has(dev.id)) return;
    out.push(`devices[${i}] (${String(dev?.id)}) is ignored: ${typeof dev?.kind === 'string' && !(dev.kind in DEVICES) ? `unknown kind "${dev.kind}" (kinds: ${kinds})` : 'needs a string id, a known kind and numeric x and y'}.`);
  });
  const seen = new Set<string>();
  for (const d of project.devices) {
    if (seen.has(d.id)) out.push(`Device id "${d.id}" is used twice; ids must be unique.`);
    seen.add(d.id);
  }
  const byId = new Map(project.devices.map((d) => [d.id, d]));
  const pinProblem = (ref: string): string | null => {
    const [id, pin] = ref.split('.');
    const d = byId.get(id);
    if (!d) return `there is no device "${id}"`;
    const def = DEVICES[d.kind as DeviceKind];
    const p = def.pins.find((x) => x.name === pin);
    if (!p) return `${id} (${d.kind}) has no pin "${pin}" (pins: ${def.pins.filter((x) => !x.dummy).map((x) => x.name).join(' ')})`;
    if (p.dummy) return `${id}.${pin} is on the real part but not modelled`;
    return null;
  };
  (r.wires ?? []).forEach((w, i) => {
    const wire = w as { a?: unknown; b?: unknown };
    if (typeof wire?.a !== 'string' || typeof wire?.b !== 'string') return void out.push(`wires[${i}] is ignored: "a" and "b" must be "deviceId.PIN".`);
    for (const end of [wire.a, wire.b]) {
      const why = pinProblem(end);
      if (why) out.push(`wires[${i}] ${wire.a} – ${wire.b} is ignored: ${why}.`);
    }
  });
  for (const id of Object.keys(r.sketches ?? {})) {
    if (!project.sketches?.[id]) out.push(`sketches.${id} is ignored: there is no board "${id}" on the bench.`);
    else if (id === 'uno') out.push('sketches.uno is ignored: the sketch of board "uno" goes in "code".');
  }
  const boards = project.devices.filter((d) => d.kind === 'uno');
  if (boards.length && !boards.some((b) => b.id === 'uno')) out.push('No board has the id "uno", so "code" runs nowhere: name the first board "uno".');
  if (r.assembly !== undefined && r.assembly !== null) {
    const v = validateAssembly(r.assembly);
    for (const e of v.errors) out.push(`assembly: ${e}`);
  }
  return out;
}

async function loadProject(args: Record<string, unknown>, ctx: ToolContext): Promise<{ project: Project; lint: string[] } | ToolResult> {
  let text: string;
  if (args.project !== undefined) text = typeof args.project === 'string' ? args.project : JSON.stringify(args.project);
  else if (typeof args.path === 'string') {
    try {
      text = await ctx.readFile(args.path);
    } catch (e) {
      return fail(`Cannot read ${args.path}: ${(e as Error).message}`);
    }
  } else return fail('Give the project as "project" (JSON) or "path" (a .orrery.json file).');
  if (text.length > MAX_PROJECT_CHARS) return fail('The project is larger than 4 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`The project is not valid JSON: ${(e as Error).message}`);
  }
  let project: Project;
  try {
    project = parseProject(text);
  } catch (e) {
    return fail(`Not an Orrery project: ${(e as Error).message}. It needs "version": 1, "devices": [], "wires": [] and "code": "".`);
  }
  return { project, lint: lintProject(raw, project) };
}

const cache = new Map<string, { ok: true; hex: string; log: string } | { ok: false; log: string }>();

interface BoardBuild {
  ok: boolean;
  from: 'prebuilt template' | 'compiled' | 'compiled (cached)';
  log: string;
}

/** Firmware for every board: the template's prebuilt .hex when the sketch is unchanged, else compiled (cached by sketch). */
async function buildAll(project: Project, ctx: ToolContext): Promise<{ firmware: Record<string, string>; builds: Record<string, BoardBuild>; ok: boolean }> {
  const firmware: Record<string, string> = {};
  const builds: Record<string, BoardBuild> = {};
  let ok = true;
  for (const b of project.devices.filter((d) => d.kind === 'uno')) {
    const code = sketchOf(project, b.id);
    const pre = PREBUILT_BY_CODE.get(code);
    if (pre) {
      firmware[b.id] = pre;
      builds[b.id] = { ok: true, from: 'prebuilt template', log: '' };
      continue;
    }
    const hit = cache.get(code);
    const r = hit ?? (await ctx.compile(code));
    if (!hit && (r.ok || !/arduino-cli not found/.test(r.log))) cache.set(code, r);
    const log = r.log.length > MAX_LOG_CHARS ? `${r.log.slice(0, MAX_LOG_CHARS)}\n… (log cut)` : r.log;
    builds[b.id] = { ok: r.ok, from: hit ? 'compiled (cached)' : 'compiled', log };
    if (r.ok) firmware[b.id] = r.hex;
    else ok = false;
  }
  return { firmware, builds, ok };
}

function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, k) => xs[Math.round((k * (xs.length - 1)) / (n - 1))]);
}

function trimReport(r: RunReport, maxSamples: number, watch?: string[]): RunReport {
  const keep = watch?.length ? new Set(watch) : null;
  const pick = <V>(o: Record<string, V>) => (keep ? Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k))) : o);
  return {
    ...r,
    serial: Object.fromEntries(Object.entries(r.serial).map(([k, v]) => [k, v.length > MAX_SERIAL_CHARS ? `… ${v.slice(-MAX_SERIAL_CHARS)}` : v])),
    samples: downsample(r.samples, maxSamples).map((s) => ({ ...s, devices: pick(s.devices) })),
    final: pick(r.final),
  };
}

const INPUT_KINDS = ['press', 'pot', 'serial', 'drop'] as const;

function parseInputs(x: unknown): BenchInput[] | string {
  if (x === undefined) return [];
  if (!Array.isArray(x)) return '"inputs" must be an array.';
  const out: BenchInput[] = [];
  for (const [i, e] of x.entries()) {
    const o = e as Record<string, unknown>;
    if (!o || typeof o.t !== 'number' || !(o.t >= 0)) return `inputs[${i}] needs a time "t" ≥ 0.`;
    const kinds = INPUT_KINDS.filter((k) => o[k] !== undefined);
    if (kinds.length !== 1) return `inputs[${i}] needs exactly one of ${INPUT_KINDS.join(', ')}.`;
    if (kinds[0] === 'pot' && !(typeof o.value === 'number' && o.value >= 0 && o.value <= 1)) return `inputs[${i}]: "pot" needs "value" between 0 and 1.`;
    if (kinds[0] === 'drop' && !(typeof o.sizeMm === 'number' && Array.isArray(o.at) && o.at.length === 3)) return `inputs[${i}]: "drop" needs "sizeMm" and "at": [x, y, z].`;
    out.push(o as unknown as BenchInput);
  }
  return out;
}

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case 'orrery_guide': {
      const topic = args.topic;
      if (topic === 'overview') return { text: OVERVIEW };
      if (topic === 'project-format') return { text: projectDoc };
      if (topic === 'assembly-format') return { text: assemblyDoc };
      if (topic === 'devices') return { text: json(devicesReference()) };
      if (topic === 'templates') return { text: json(TEMPLATES.map((t) => ({ id: t.id, title: t.title, summary: t.summary, boards: t.project.devices.filter((d) => d.kind === 'uno').length, mechanism: !!t.project.assembly }))) };
      return fail('topic must be one of overview, project-format, assembly-format, devices, templates.');
    }
    case 'orrery_get_template': {
      const t = TEMPLATES.find((x) => x.id === args.id);
      if (!t) return fail(`No template "${String(args.id)}". Templates: ${TEMPLATES.map((x) => x.id).join(', ')}.`);
      return { text: json(t.project) };
    }
    case 'orrery_check': {
      const loaded = await loadProject(args, ctx);
      if ('text' in loaded) return loaded;
      const { project, lint } = loaded;
      const sim = new LabSimulation(project, {});
      const out: Record<string, unknown> = {
        ok: lint.length === 0 && !sim.fatal.some((c) => c.level === 'error'),
        ignored: lint,
        wiring: sim.fatal,
        boards: project.devices.filter((d) => d.kind === 'uno').map((d) => d.id),
        note: 'Checks that depend on the firmware (pin modes, currents, servo pulses, loads while moving) need orrery_simulate.',
      };
      const asm = project.assembly;
      if (asm) {
        const props = await massProperties(asm);
        const clashes = (await interference(asm, jointValues(asm, () => undefined))).filter((c) => c.volumeMm3 >= CLASH_MIN_MM3);
        out.mechanism = {
          links: asm.links.length,
          joints: asm.joints.length,
          massG: Math.round([...props.values()].reduce((s, m) => s + m.massG, 0) * 10) / 10,
          unknownMass: [...props].filter(([, m]) => m.how === 'unknown').map(([id, m]) => `${id}: ${m.note ?? 'unknown'}`),
          clashesAtHome: clashes.map((c) => ({ a: c.a, b: c.b, volumeMm3: Math.round(c.volumeMm3 * 10) / 10 })),
          warnings: validateAssembly(asm).warnings,
        };
        if (clashes.length) out.ok = false;
      }
      return { text: json(out) };
    }
    case 'orrery_compile': {
      const loaded = await loadProject(args, ctx);
      if ('text' in loaded) return loaded;
      const { builds, ok } = await buildAll(loaded.project, ctx);
      if (!Object.keys(builds).length) return { text: json({ ok: true, boards: {}, note: 'No board on the bench: nothing to compile.' }) };
      return { text: json({ ok, boards: builds }) };
    }
    case 'orrery_simulate': {
      const loaded = await loadProject(args, ctx);
      if ('text' in loaded) return loaded;
      const seconds = Number(args.seconds);
      if (!(seconds > 0 && seconds <= MAX_SECONDS)) return fail(`"seconds" must be more than 0 and at most ${MAX_SECONDS}.`);
      const inputs = parseInputs(args.inputs);
      if (typeof inputs === 'string') return fail(inputs);
      const mechanics = args.mechanics as 'off' | 'static' | 'dynamic' | undefined;
      if (mechanics !== undefined && !['off', 'static', 'dynamic'].includes(mechanics)) return fail('"mechanics" must be off, static or dynamic.');
      const { firmware, builds, ok } = await buildAll(loaded.project, ctx);
      if (!ok) return { text: json({ ok: false, problems: ['A sketch does not compile; nothing was run.'], build: builds, ignored: loaded.lint }), isError: true };
      const report = await runProject(loaded.project, {
        seconds,
        firmware,
        inputs,
        mechanics,
        sampleEvery: typeof args.sampleEvery === 'number' ? args.sampleEvery : undefined,
      });
      const maxSamples = typeof args.maxSamples === 'number' ? Math.max(2, Math.min(1000, Math.floor(args.maxSamples))) : 40;
      const watch = Array.isArray(args.watch) ? args.watch.filter((x): x is string => typeof x === 'string') : undefined;
      const trimmed = trimReport(report, maxSamples, watch);
      const ignored = loaded.lint;
      return { text: json({ ...trimmed, ok: trimmed.ok && ignored.length === 0, problems: [...ignored, ...trimmed.problems], build: builds }) };
    }
    case 'orrery_share': {
      const loaded = await loadProject(args, ctx);
      if ('text' in loaded) return loaded;
      const base = typeof args.base === 'string' ? args.base : PUBLIC_URL;
      if (!/^https?:\/\//.test(base)) return fail('"base" must be an http(s) URL.');
      const { firmware, builds, ok } = await buildAll(loaded.project, ctx);
      const url = await shareUrl(loaded.project, firmware, base);
      return {
        text: json({
          url,
          length: url.length,
          firmwareIncluded: Object.keys(firmware),
          ...(ok ? {} : { note: 'Some sketches do not compile; those boards open without firmware.', build: builds }),
        }),
      };
    }
    default:
      return fail(`Unknown tool ${name}.`);
  }
}
